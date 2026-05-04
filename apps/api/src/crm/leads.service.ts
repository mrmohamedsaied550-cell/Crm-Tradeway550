import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { DistributionService } from '../distribution/distribution.service';
import type { RoutingContext } from '../distribution/distribution.types';
import { AuditService } from '../audit/audit.service';
import { FieldFilterService } from '../rbac/field-filter.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { requireTenantId } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { buildAttribution } from './attribution.util';
import { LostReasonsService } from './lost-reasons.service';
import { PipelineService } from './pipeline.service';
import { isSlaResetting, type ActivityType } from './pipeline.registry';
import { normalizeE164WithDefault } from './phone.util';
import { dayBoundsInTimezone } from './time.util';
import { SlaService } from './sla.service';
import type {
  CreateLeadDto,
  UpdateLeadDto,
  AddActivityDto,
  ListLeadsQueryDto,
  ListLeadsByStageQueryDto,
  BulkAssignDto,
  BulkMoveStageDto,
  BulkDeleteDto,
} from './leads.dto';

/**
 * Lead lifecycle.
 *
 * Every read/write goes through `prisma.withTenant(...)` so the database's
 * RLS policy enforces tenant isolation. Activity rows are appended for
 * every mutating operation (create / assign / move / note / call /
 * convert) so the UI's lead-detail timeline is reconstructable from a
 * single SELECT on `lead_activities`.
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: PipelineService,
    private readonly sla: SlaService,
    private readonly tenantSettings: TenantSettingsService,
    /**
     * Phase 1A — A5 cutover. autoAssign() routes through this façade
     * instead of consulting the legacy PL-3 JSONB column. AssignmentService
     * dependency was removed — SLA breach + ingestion still use it
     * directly via their own injection (cutover for those paths
     * lands in a follow-up).
     *
     * @Optional so the existing test fixtures that built LeadsService
     * pre-Phase-1A continue to compile. Tests that exercise
     * autoAssign() MUST pass DistributionService — autoAssign throws
     * a clear error when it's missing.
     */
    @Optional() private readonly distribution?: DistributionService,
    @Optional() private readonly realtime?: RealtimeService,
    /**
     * Phase A — A3: validation of lostReasonId on terminal=lost
     * stage moves. @Optional so legacy test fixtures compile —
     * production wiring (CrmModule) always provides it; the service
     * throws a clear error if a lost move is attempted without it.
     */
    @Optional() private readonly lostReasons?: LostReasonsService,
    /**
     * Phase C — C3: per-(role × resource) scope filter applied to
     * read paths. @Optional so existing test fixtures that build
     * LeadsService without scope context (and exercise reads with
     * no userClaims arg) keep working as before. When neither this
     * dependency nor a userClaims arg is supplied at the call site,
     * read paths run scope-free (today's behaviour).
     */
    @Optional() private readonly scopeContext?: ScopeContextService,
    /**
     * Phase C — C4: per-(role × resource × field) read-side filter.
     * Strips denied fields from response payloads at the service
     * boundary. @Optional for the same reason as scopeContext: legacy
     * fixtures don't wire it; production wiring (CrmModule via the
     * @Global RbacModule) always provides it.
     */
    @Optional() private readonly fieldFilter?: FieldFilterService,
    /**
     * Phase C — C5.5: emits `field_write_denied` audit events when a
     * write call drops forbidden fields. @Optional so legacy
     * fixtures keep compiling; production (CrmModule via the
     * @Global AuditModule) always provides it.
     *
     * The audit row carries field NAMES only — never values — so
     * the audit log itself can't leak the data the role was denied.
     */
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Phase C — C4: convenience wrapper that resolves the calling
   * user's denied-fields list once and applies it to a single
   * payload. Returns `payload` unchanged when the dep / claims are
   * absent (legacy fixtures) OR when the role has no denied fields
   * for the resource (super_admin + most roles today).
   */
  private async applyLeadFieldFilter<T>(
    userClaims: ScopeUserClaims | undefined,
    payload: T,
  ): Promise<T> {
    if (!userClaims || !this.fieldFilter) return payload;
    const { paths } = await this.fieldFilter.listDeniedReadFields(userClaims, 'lead');
    if (paths.length === 0) return payload;
    return this.fieldFilter.filterRead(payload, paths);
  }

  /** List variant — same single round-trip for the role's deny list. */
  private async applyLeadFieldFilterMany<T>(
    userClaims: ScopeUserClaims | undefined,
    rows: T[],
  ): Promise<T[]> {
    if (!userClaims || !this.fieldFilter) return rows;
    const { paths } = await this.fieldFilter.listDeniedReadFields(userClaims, 'lead');
    if (paths.length === 0) return rows;
    return this.fieldFilter.filterReadMany(rows, paths);
  }

  /**
   * Phase C — C5 + C5.5: write-side companion to applyLeadFieldFilter.
   * Strips any keys the calling user's role isn't allowed to WRITE
   * from an incoming DTO before persistence AND reports which paths
   * were actually present in the input so the caller can emit a
   * `field_write_denied` audit row naming only the affected fields
   * (no values).
   *
   * Returns `{ dto: input, denied: [] }` when no claims / no
   * fieldFilter / no denies — so legacy fixtures that don't pass
   * userClaims keep current behaviour byte-identically.
   *
   * SILENT STRIP POLICY (C5 rule 7):
   *   Forbidden fields are dropped from the input and the operation
   *   continues as if those keys were never sent. Callers MUST NOT
   *   throw on a non-empty `denied` set; the API contract is "the
   *   request succeeds with the forbidden change not applied".
   *
   * AUDIT POLICY (C5.5 rule 3):
   *   When `denied` is non-empty, the caller emits a single audit
   *   row of action `field_write_denied` carrying the field names
   *   (never values). This is BEFORE the main write so the audit is
   *   recorded even if the subsequent write fails for unrelated
   *   reasons (validation error, RLS, etc.) — matching the existing
   *   AuditService.writeForTenant best-effort semantics.
   */
  private async stripLeadWriteDeniesWithReport<T>(
    userClaims: ScopeUserClaims | undefined,
    dto: T,
  ): Promise<{ dto: T; denied: string[] }> {
    if (!userClaims || !this.fieldFilter) return { dto, denied: [] };
    const { paths } = await this.fieldFilter.listDeniedWriteFields(userClaims, 'lead');
    if (paths.length === 0) return { dto, denied: [] };
    return this.fieldFilter.stripWithReport(dto, paths);
  }

  /**
   * Phase C — C5: returns the user's lead write-deny paths once.
   * Call sites that need to inspect the path set (e.g. assign /
   * moveStage to short-circuit when the action only touches
   * forbidden fields) use this directly instead of the generic
   * stripper above.
   */
  private async leadWriteDenyPaths(
    userClaims: ScopeUserClaims | undefined,
  ): Promise<readonly string[]> {
    if (!userClaims || !this.fieldFilter) return [];
    const { paths } = await this.fieldFilter.listDeniedWriteFields(userClaims, 'lead');
    return paths;
  }

  /**
   * Phase C — C5.5: emit a `field_write_denied` audit row.
   *
   * Best-effort via AuditService.writeForTenant — the audit failure
   * never breaks the parent operation. Field NAMES are recorded;
   * values are not. The `entityId` is the lead being written, or
   * null on create (the lead doesn't exist yet at strip time).
   */
  private async auditFieldWriteDenied(
    userClaims: ScopeUserClaims | undefined,
    operation: 'create' | 'update' | 'assign' | 'moveStage',
    entityId: string | null,
    deniedFields: readonly string[],
  ): Promise<void> {
    if (!userClaims || !this.audit || deniedFields.length === 0) return;
    await this.audit.writeForTenant(userClaims.tenantId, {
      action: 'field_write_denied',
      entityType: 'lead',
      entityId,
      actorUserId: userClaims.userId,
      payload: {
        resource: 'lead',
        operation,
        deniedFields: [...deniedFields],
        roleId: userClaims.roleId,
      },
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // create
  // ───────────────────────────────────────────────────────────────────────

  async create(dto: CreateLeadDto, actorUserId: string, userClaims?: ScopeUserClaims) {
    const tenantId = requireTenantId();
    const settings = await this.tenantSettings.getCurrent();

    // Phase C — C5 + C5.5: silently drop any fields the calling role
    // isn't allowed to write, and emit `field_write_denied` audit
    // when something was actually stripped. The remainder of the
    // create flow proceeds normally — denied keys default through
    // their schema-level defaults (e.g. `source` falls back to the
    // column default 'manual' when the role can't write it).
    // Activity / audit emissions further down read from the
    // stripped dto, so the change log can't leak forbidden values
    // either. entityId is null because the lead has no id yet.
    {
      const { dto: stripped, denied } = await this.stripLeadWriteDeniesWithReport(userClaims, dto);
      dto = stripped;
      await this.auditFieldWriteDenied(userClaims, 'create', null, denied);
    }

    // P2-08 — the DTO only sanity-checks the shape; full E.164
    // normalisation happens here, with the tenant's defaultDialCode
    // applied to local-format input ("01001234567" → "+201001234567").
    // A malformed phone surfaces as a 400 with a stable code so the
    // admin UI can branch.
    let phone: string;
    try {
      phone = normalizeE164WithDefault(dto.phone, settings.defaultDialCode);
    } catch (err) {
      throw new BadRequestException({
        code: 'lead.invalid_phone',
        message: (err as Error).message,
      });
    }

    if (dto.assignedToId) {
      await this.assertUserInTenant(dto.assignedToId);
    }

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        // Phase 1B — resolve the pipeline first, then resolve / validate
        // the stage *within* that pipeline. Three input paths:
        //   1. pipelineStageId  → load stage; pipeline is stage.pipelineId
        //                          (companyId/countryId are advisory, must
        //                          match the stage's pipeline scope or be
        //                          omitted).
        //   2. stageCode        → resolve pipeline from (company, country)
        //                          then look up the code in it.
        //   3. neither          → resolve pipeline; pick its first
        //                          non-terminal stage (lowest order).
        let pipelineId: string;
        // Phase A — terminalKind threaded through so the lifecycle
        // classifier is correct on rare admin-create-direct-to-
        // terminal-stage flows. The first-non-terminal entry path
        // hardcodes terminalKind=null since isTerminal:false.
        let stage: {
          id: string;
          code: string;
          name: string;
          isTerminal: boolean;
          terminalKind: string | null;
        };

        if (dto.pipelineStageId) {
          const row = await tx.pipelineStage.findUnique({
            where: { id: dto.pipelineStageId },
            select: {
              id: true,
              code: true,
              name: true,
              isTerminal: true,
              terminalKind: true,
              pipelineId: true,
            },
          });
          if (!row) {
            throw new NotFoundException({
              code: 'pipeline.stage.not_found',
              message: `Pipeline stage not found: ${dto.pipelineStageId}`,
            });
          }
          pipelineId = row.pipelineId;
          stage = row;
        } else {
          const pipeline = await this.pipeline.resolveForLeadInTx(tx, {
            companyId: dto.companyId ?? null,
            countryId: dto.countryId ?? null,
          });
          pipelineId = pipeline.id;
          if (dto.stageCode) {
            stage = await this.pipeline.findCodeInPipelineOrThrow(pipelineId, dto.stageCode);
          } else {
            // First non-terminal stage by order.
            const first = await tx.pipelineStage.findFirst({
              where: { pipelineId, isTerminal: false },
              orderBy: { order: 'asc' },
              select: { id: true, code: true, name: true, isTerminal: true, terminalKind: true },
            });
            if (!first) {
              throw new BadRequestException({
                code: 'pipeline.no_entry_stage',
                message: `Pipeline ${pipelineId} has no non-terminal stage to use as entry point`,
              });
            }
            stage = first;
          }
        }

        const now = new Date();
        // Non-terminal new lead → SLA starts ticking immediately. Terminal
        // (rare on create — admin import case) → SLA paused.
        const slaDueAt = stage.isTerminal ? null : this.sla.computeDueAt(now, settings.slaMinutes);
        const slaStatus = stage.isTerminal ? 'paused' : 'active';

        // Phase A — derive lifecycleState from the entry stage's
        // terminalKind. The default is 'open' (column default), but
        // we set it explicitly so admin create-into-terminal-stage
        // produces the right classifier on day one. Note: 'lost' on
        // create is rejected — the create DTO has no path to supply
        // a lostReasonId, so we'd write a 'lost' lead with NULL
        // reason which violates the FK semantics. Force admins to
        // create-then-moveStage if they really want this.
        const lifecycleState =
          stage.terminalKind === 'won'
            ? 'won'
            : stage.terminalKind === 'lost'
              ? // Defensive: this path is reachable only via
                // pipelineStageId pointing at a 'lost' stage. We
                // refuse with a typed error rather than silently
                // creating a lifecycle=lost row with no reason.
                (() => {
                  throw new BadRequestException({
                    code: 'lead.create_into_lost_forbidden',
                    message:
                      'Cannot create a lead directly into a "lost" stage; create it open and then move it',
                  });
                })()
              : 'open';

        // Phase A — A4: build the JSONB attribution payload from the
        // lead's flat source + the optional rich input. The flat
        // `source` column stays in lockstep with `attribution.source`
        // (helper enforces). Manual creates without an attribution
        // payload still produce `{ source }` so every lead has a
        // non-null payload going forward.
        const attribution = buildAttribution(dto.source, dto.attribution ?? null);

        const lead = await tx.lead.create({
          data: {
            tenantId,
            name: dto.name,
            phone,
            email: dto.email ?? null,
            source: dto.source,
            attribution: attribution as unknown as Prisma.InputJsonValue,
            companyId: dto.companyId ?? null,
            countryId: dto.countryId ?? null,
            pipelineId,
            stageId: stage.id,
            lifecycleState,
            assignedToId: dto.assignedToId ?? null,
            createdById: actorUserId,
            slaDueAt,
            slaStatus,
          },
          include: { stage: true, captain: true },
        });
        await this.appendActivity(tx, {
          tenantId,
          leadId: lead.id,
          type: 'system',
          body: `Lead created in stage "${stage.code}"`,
          payload: {
            event: 'created',
            stageCode: stage.code,
            stageId: stage.id,
            pipelineId,
            source: dto.source,
          },
          createdById: actorUserId,
        });
        // Phase C — C10B-3: if the lead is linked to a Contact (via the
        // C10B-1 column) and entered an OPEN lifecycle, mark the
        // contact as `hasOpenLead`. Manual create today never carries
        // contactId; this guard is the seam for future create paths
        // (CSV import + Meta lead-ads webhook) that DO populate it.
        if (lead.contactId && lifecycleState === 'open') {
          await tx.contact.update({
            where: { id: lead.contactId },
            data: { hasOpenLead: true },
          });
        }
        return lead;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'lead.duplicate_phone',
          message: `A lead with phone ${phone} already exists in this tenant`,
        });
      }
      throw err;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // read / list
  // ───────────────────────────────────────────────────────────────────────

  findById(id: string) {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.lead.findUnique({
        where: { id },
        include: {
          stage: {
            select: {
              id: true,
              code: true,
              name: true,
              order: true,
              isTerminal: true,
              // Phase 1B — moveStage falls back to the stage's own
              // pipelineId for legacy leads whose `pipelineId` column
              // is still NULL. Keep the include so that fallback works
              // without a second query.
              pipelineId: true,
            },
          },
          captain: true,
        },
      }),
    );
  }

  async findByIdOrThrow(id: string) {
    const lead = await this.findById(id);
    if (!lead) {
      throw new NotFoundException({ code: 'lead.not_found', message: `Lead not found: ${id}` });
    }
    return lead;
  }

  /**
   * Phase C — C3: scope-aware findById. Used by the GET endpoint so
   * a user with role-scope='own' (or team / company / country) only
   * resolves leads inside their scope. Out-of-scope rows raise the
   * same 404 as a missing row — we deliberately don't differentiate
   * to avoid leaking lead existence across scope boundaries.
   *
   * Internal write paths (moveStage, convert, addActivity, etc.)
   * keep using `findByIdOrThrow` — write enforcement lands in a
   * later chunk per the C-plan.
   */
  async findByIdInScopeOrThrow(id: string, userClaims: ScopeUserClaims) {
    const tenantId = requireTenantId();
    const scopeWhere = await this.resolveLeadScopeWhere(userClaims);
    const lead = await this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.LeadWhereInput = scopeWhere ? { AND: [{ id }, scopeWhere] } : { id };
      return tx.lead.findFirst({
        where,
        include: {
          assignedTo: { select: { id: true, name: true, email: true } },
          stage: {
            select: {
              id: true,
              code: true,
              name: true,
              order: true,
              isTerminal: true,
              terminalKind: true,
              pipelineId: true,
            },
          },
          captain: true,
        },
      });
    });
    if (!lead) {
      throw new NotFoundException({ code: 'lead.not_found', message: `Lead not found: ${id}` });
    }
    // Phase C — C4: strip denied fields before returning.
    return this.applyLeadFieldFilter(userClaims, lead);
  }

  /**
   * Phase C — C3: resolve the scope `where` once per call. Returns
   * `null` when scope is `'global'` OR when the scope context dep
   * isn't wired (legacy fixtures that don't pass userClaims) OR
   * when the caller passed no claims. Either way, no extra filter
   * is applied.
   */
  private async resolveLeadScopeWhere(
    userClaims: ScopeUserClaims | undefined,
  ): Promise<Prisma.LeadWhereInput | null> {
    if (!userClaims || !this.scopeContext) return null;
    const { where } = await this.scopeContext.resolveLeadScope(userClaims);
    return where;
  }

  async list(query: ListLeadsQueryDto, userClaims?: ScopeUserClaims) {
    const tenantId = requireTenantId();

    // Phase 1B — three stage-filter inputs (mutually exclusive in
    // practice; the controller already validates only one is sent):
    //   pipelineStageId — exact stage row
    //   stageCode       — legacy code; resolved against tenant default
    //                     pipeline so old clients keep working without
    //                     change. New UI uses pipelineStageId.
    //   pipelineId      — every lead currently in the pipeline (Kanban)
    let stageIdFilter: string | undefined;
    if (query.pipelineStageId) {
      stageIdFilter = query.pipelineStageId;
    } else if (query.stageCode) {
      stageIdFilter = (await this.pipeline.findByCodeOrThrow(query.stageCode)).id;
    }

    // P3-03 — `assignedToId` and `unassigned` are mutually exclusive;
    // when both are passed the explicit `assignedToId` wins (most
    // specific intent). The fallback to `unassigned` only applies when
    // the caller did NOT pass an id.
    const assigneeFilter: Prisma.LeadWhereInput = query.assignedToId
      ? { assignedToId: query.assignedToId }
      : query.unassigned
        ? { assignedToId: null }
        : {};

    // P3-03 — created-at window. Either bound may be missing; we only
    // build the `gte` / `lte` keys when present so a half-open range
    // works without a sentinel.
    const createdAt: Prisma.DateTimeFilter | undefined =
      query.createdFrom || query.createdTo
        ? {
            ...(query.createdFrom && { gte: new Date(query.createdFrom) }),
            ...(query.createdTo && { lte: new Date(query.createdTo) }),
          }
        : undefined;

    // Phase C — C3: AND the user's role-scope `where` clause on top
    // of the explicit filter. `null` means 'global' (or no claims) →
    // no extra filter. AND-array form keeps any existing OR (e.g. the
    // search clause) intact.
    const scopeWhere = await this.resolveLeadScopeWhere(userClaims);
    const baseWhere: Prisma.LeadWhereInput = {
      ...(stageIdFilter && { stageId: stageIdFilter }),
      ...(query.pipelineId && { pipelineId: query.pipelineId }),
      ...(query.companyId && { companyId: query.companyId }),
      ...(query.countryId && { countryId: query.countryId }),
      ...assigneeFilter,
      ...(query.source && { source: query.source }),
      ...(query.slaStatus && { slaStatus: query.slaStatus }),
      ...(query.hasOverdueFollowup && { nextActionDueAt: { lt: new Date() } }),
      ...(createdAt && { createdAt }),
      ...(query.q && {
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { phone: { contains: query.q } },
          { email: { contains: query.q, mode: 'insensitive' } },
        ],
      }),
    };
    const where: Prisma.LeadWhereInput = scopeWhere ? { AND: [baseWhere, scopeWhere] } : baseWhere;

    const { items: rawItems, total } = await this.prisma.withTenant(tenantId, async (tx) => {
      const [items, count] = await Promise.all([
        tx.lead.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: query.limit,
          skip: query.offset,
          include: {
            stage: { select: { code: true, name: true, order: true, isTerminal: true } },
            captain: { select: { id: true, onboardingStatus: true } },
          },
        }),
        tx.lead.count({ where }),
      ]);
      return { items, total: count };
    });
    // Phase C — C4: strip denied fields from every row.
    const items = await this.applyLeadFieldFilterMany(userClaims, rawItems);
    return { items, total, limit: query.limit, offset: query.offset };
  }

  /**
   * Phase 1B — Kanban grouped query.
   *
   * Returns one bucket per stage of `query.pipelineId`, each bucket
   * carrying its `totalCount` (across the entire filter, not just
   * the cards we returned) and the first `perStage` cards ordered
   * by createdAt desc. The shape is denormalised on purpose: the
   * Kanban board renders columns deterministically from this single
   * round-trip, no follow-up calls per column.
   *
   * Stages with zero matching leads are still returned (empty bucket
   * + `totalCount = 0`) so the board renders all columns even when
   * a filter narrows results to a subset of stages.
   *
   * NOT a replacement for `list()` — large pipelines that need more
   * than `perStage` cards in one column page in via the legacy
   * paginated `list()` with `pipelineStageId` set.
   */
  async listByStage(query: ListLeadsByStageQueryDto, userClaims?: ScopeUserClaims) {
    const tenantId = requireTenantId();

    const assigneeFilter: Prisma.LeadWhereInput = query.assignedToId
      ? { assignedToId: query.assignedToId }
      : query.unassigned
        ? { assignedToId: null }
        : {};

    const createdAt: Prisma.DateTimeFilter | undefined =
      query.createdFrom || query.createdTo
        ? {
            ...(query.createdFrom && { gte: new Date(query.createdFrom) }),
            ...(query.createdTo && { lte: new Date(query.createdTo) }),
          }
        : undefined;

    // The pipelineId clause is the only invariant filter — every other
    // condition is optional.
    const scopeWhere = await this.resolveLeadScopeWhere(userClaims);
    const userWhere: Prisma.LeadWhereInput = {
      pipelineId: query.pipelineId,
      ...(query.companyId && { companyId: query.companyId }),
      ...(query.countryId && { countryId: query.countryId }),
      ...assigneeFilter,
      ...(query.source && { source: query.source }),
      ...(query.slaStatus && { slaStatus: query.slaStatus }),
      ...(query.hasOverdueFollowup && { nextActionDueAt: { lt: new Date() } }),
      ...(createdAt && { createdAt }),
      ...(query.q && {
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { phone: { contains: query.q } },
          { email: { contains: query.q, mode: 'insensitive' } },
        ],
      }),
    };
    const baseWhere: Prisma.LeadWhereInput = scopeWhere
      ? { AND: [userWhere, scopeWhere] }
      : userWhere;

    return this.prisma.withTenant(tenantId, async (tx) => {
      // Resolve the stage list first — it drives the response shape
      // and lets us reject an unknown pipelineId with a typed 404
      // before doing any expensive work.
      const stages = await tx.pipelineStage.findMany({
        where: { pipelineId: query.pipelineId },
        orderBy: { order: 'asc' },
        select: { id: true, code: true, name: true, order: true, isTerminal: true },
      });
      if (stages.length === 0) {
        throw new NotFoundException({
          code: 'pipeline.not_found_or_empty',
          message: `Pipeline ${query.pipelineId} not found or has no stages`,
        });
      }

      // Per-stage counts via a single GROUP BY. Stages with zero
      // matches get a 0 in the merged map below.
      const grouped = await tx.lead.groupBy({
        by: ['stageId'],
        where: baseWhere,
        _count: { _all: true },
      });
      const countByStageId = new Map<string, number>(
        grouped.map((g) => [g.stageId, g._count._all]),
      );

      // Per-stage card list — N parallel `findMany`s. Capped at
      // `perStage` cards each, ordered by createdAt desc so the
      // newest leads sit at the top of every column.
      const perStage = query.perStage;
      type LeadCard = Awaited<ReturnType<typeof tx.lead.findMany>>[number];
      const buckets = await Promise.all(
        stages.map(async (s) => {
          const total = countByStageId.get(s.id) ?? 0;
          if (total === 0) {
            return { stage: s, totalCount: 0, leads: [] as LeadCard[] };
          }
          const leads = await tx.lead.findMany({
            where: { ...baseWhere, stageId: s.id },
            orderBy: { createdAt: 'desc' },
            take: perStage,
            include: {
              stage: { select: { code: true, name: true, order: true, isTerminal: true } },
              captain: { select: { id: true, onboardingStatus: true } },
            },
          });
          return { stage: s, totalCount: total, leads };
        }),
      );

      // Phase C — C4: filter every bucket's leads through the deny
      // list. Resolved once per request inside applyLeadFieldFilterMany.
      const filteredBuckets = await Promise.all(
        buckets.map(async (b) => ({
          ...b,
          leads: await this.applyLeadFieldFilterMany<LeadCard>(userClaims, b.leads),
        })),
      );
      return {
        pipelineId: query.pipelineId,
        perStage,
        stages: filteredBuckets,
      };
    });
  }

  /**
   * C37 — leads whose `nextActionDueAt` is in the past (and still
   * non-null, i.e. there is a pending follow-up). Optionally filtered
   * to a specific assignee — the agent workspace passes `me`.
   */
  async listOverdue(
    opts: { assignedToId?: string; limit?: number; now?: Date } = {},
    userClaims?: ScopeUserClaims,
  ) {
    const tenantId = requireTenantId();
    const now = opts.now ?? new Date();
    const scopeWhere = await this.resolveLeadScopeWhere(userClaims);
    const baseWhere: Prisma.LeadWhereInput = {
      nextActionDueAt: { lt: now },
      ...(opts.assignedToId && { assignedToId: opts.assignedToId }),
    };
    const where: Prisma.LeadWhereInput = scopeWhere ? { AND: [baseWhere, scopeWhere] } : baseWhere;
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.lead.findMany({
        where,
        orderBy: { nextActionDueAt: 'asc' },
        take: opts.limit ?? 100,
        include: {
          stage: { select: { code: true, name: true, order: true, isTerminal: true } },
          captain: { select: { id: true, onboardingStatus: true } },
        },
      }),
    );
    // Phase C — C4: strip denied fields from every overdue row.
    return this.applyLeadFieldFilterMany(userClaims, rows);
  }

  /**
   * C37 — leads whose `nextActionDueAt` falls within today's wall-clock
   * window (server local time). Optionally filtered to a specific
   * assignee.
   */
  async listDueToday(
    opts: { assignedToId?: string; limit?: number; now?: Date } = {},
    userClaims?: ScopeUserClaims,
  ) {
    const tenantId = requireTenantId();
    const now = opts.now ?? new Date();
    // P2-08 — compute the day boundary in the TENANT's timezone, not
    // the server's. An admin in Cairo and an admin in Casablanca
    // running off the same server should each see "their" today.
    const settings = await this.tenantSettings.getCurrent();
    const { start, end } = dayBoundsInTimezone(now, settings.timezone);
    const scopeWhere = await this.resolveLeadScopeWhere(userClaims);
    const baseWhere: Prisma.LeadWhereInput = {
      nextActionDueAt: { gte: start, lte: end },
      ...(opts.assignedToId && { assignedToId: opts.assignedToId }),
    };
    const where: Prisma.LeadWhereInput = scopeWhere ? { AND: [baseWhere, scopeWhere] } : baseWhere;
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.lead.findMany({
        where,
        orderBy: { nextActionDueAt: 'asc' },
        take: opts.limit ?? 100,
        include: {
          stage: { select: { code: true, name: true, order: true, isTerminal: true } },
          captain: { select: { id: true, onboardingStatus: true } },
        },
      }),
    );
    // Phase C — C4: strip denied fields from every due-today row.
    return this.applyLeadFieldFilterMany(userClaims, rows);
  }

  async listActivities(leadId: string, userClaims?: ScopeUserClaims) {
    const rows = await this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.leadActivity.findMany({
        where: { leadId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          body: true,
          payload: true,
          createdAt: true,
          createdById: true,
        },
      }),
    );
    // Phase C — C4: an activity's `payload` JSON may mirror lead-
    // shape fields (e.g. attribution.campaign was lifted into a
    // payload by a future emitter). Apply the SAME lead-resource
    // deny paths to each `payload` so the timeline can't leak a
    // value the role isn't allowed to see directly. Today's
    // emitters don't include any of the seeded sales_agent denies,
    // so this is a defensive pass — but it ships now so future
    // payload writers stay safe by default.
    if (!userClaims || !this.fieldFilter) return rows;
    const { paths } = await this.fieldFilter.listDeniedReadFields(userClaims, 'lead');
    if (paths.length === 0) return rows;
    return rows.map((row) => ({
      ...row,
      payload:
        row.payload == null
          ? row.payload
          : (this.fieldFilter!.filterRead(row.payload, paths) as typeof row.payload),
    }));
  }

  // ───────────────────────────────────────────────────────────────────────
  // update / delete
  // ───────────────────────────────────────────────────────────────────────

  async update(id: string, dto: UpdateLeadDto, actorUserId: string, userClaims?: ScopeUserClaims) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);

    // Phase C — C5 + C5.5: silently drop any keys the calling role
    // can't write before we touch the row, and emit
    // `field_write_denied` audit when something was actually
    // stripped. After the strip, an empty dto simply produces a
    // no-op update + activity row that records nothing meaningful.
    // The activity emission below reads from the stripped dto so
    // the change log doesn't leak forbidden values.
    {
      const { dto: stripped, denied } = await this.stripLeadWriteDeniesWithReport(userClaims, dto);
      dto = stripped;
      await this.auditFieldWriteDenied(userClaims, 'update', id, denied);
    }

    const settings = await this.tenantSettings.getCurrent();
    let normalizedPhone: string | undefined;
    if (dto.phone !== undefined) {
      try {
        normalizedPhone = normalizeE164WithDefault(dto.phone, settings.defaultDialCode);
      } catch (err) {
        throw new BadRequestException({
          code: 'lead.invalid_phone',
          message: (err as Error).message,
        });
      }
    }

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const updated = await tx.lead.update({
          where: { id },
          data: {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(normalizedPhone !== undefined && { phone: normalizedPhone }),
            ...(dto.email !== undefined && { email: dto.email }),
            ...(dto.source !== undefined && { source: dto.source }),
          },
          include: { stage: true, captain: true },
        });
        await this.appendActivity(tx, {
          tenantId,
          leadId: id,
          type: 'system',
          body: 'Lead updated',
          payload: { event: 'updated', changes: dto },
          createdById: actorUserId,
        });
        return updated;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'lead.duplicate_phone',
          message: `A lead with that phone already exists in this tenant`,
        });
      }
      throw err;
    }
  }

  async delete(id: string) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    await this.prisma.withTenant(tenantId, (tx) => tx.lead.delete({ where: { id } }));
  }

  // ───────────────────────────────────────────────────────────────────────
  // assign
  // ───────────────────────────────────────────────────────────────────────

  async assign(
    id: string,
    assigneeUserId: string | null,
    actorUserId: string,
    userClaims?: ScopeUserClaims,
  ) {
    const tenantId = requireTenantId();
    const before = await this.findByIdOrThrow(id);

    // Phase C — C5 + C5.5: assignedToId is the only field this
    // method touches. If the calling role can't write it, silently
    // no-op (return the unchanged lead, same shape as a successful
    // assign so the controller doesn't branch) AND emit a
    // `field_write_denied` audit row naming the field. Consistent
    // with create/update: silent strip, audit emission.
    const denyPaths = await this.leadWriteDenyPaths(userClaims);
    if (denyPaths.includes('assignedToId')) {
      await this.auditFieldWriteDenied(userClaims, 'assign', id, ['assignedToId']);
      return before;
    }

    if (assigneeUserId !== null) {
      await this.assertUserInTenant(assigneeUserId);
    }

    const settings = await this.tenantSettings.getCurrent();
    const updated = await this.prisma.withTenant(tenantId, async (tx) => {
      // Reassignment counts as an SLA-resetting event so the new owner
      // gets a full window. We skip the reset when the lead is in a
      // terminal stage (SLA stays paused).
      const inTerminal = before.stage.isTerminal;
      const row = await tx.lead.update({
        where: { id },
        data: {
          assignedToId: assigneeUserId,
          ...(!inTerminal && {
            slaDueAt: this.sla.computeDueAt(new Date(), settings.slaMinutes),
            slaStatus: 'active',
          }),
        },
        include: { stage: true },
      });
      await this.appendActivity(tx, {
        tenantId,
        leadId: id,
        type: 'assignment',
        body:
          assigneeUserId === null ? 'Lead unassigned' : `Lead assigned to user ${assigneeUserId}`,
        payload: {
          event: 'assignment',
          fromUserId: before.assignedToId ?? null,
          toUserId: assigneeUserId,
        },
        createdById: actorUserId,
      });
      return row;
    });

    // P3-02 — push the new owner so their workspace lights up the
    // lead immediately. Skipped on unassign (no recipient).
    if (assigneeUserId && this.realtime) {
      try {
        this.realtime.emitToUser(tenantId, assigneeUserId, {
          type: 'lead.assigned',
          leadId: id,
          toUserId: assigneeUserId,
          fromUserId: before.assignedToId ?? null,
          reason: 'manual',
        });
      } catch {
        /* swallowed — best-effort push */
      }
    }
    return updated;
  }

  /**
   * Auto-assign a lead via the Phase-1A distribution engine.
   *
   * Flow (post A5 cutover):
   *   1. DistributionService.route() finds the matching rule (source ×
   *      company × country), or falls back to the tenant's
   *      default_strategy when none matches.
   *   2. The candidate filter pipeline excludes the current assignee
   *      and any user that fails availability / capacity / OOF /
   *      team-membership checks (see candidate-filter.ts for the
   *      exact ordering).
   *   3. The chosen strategy (specific_user / round_robin / weighted /
   *      capacity) picks one survivor.
   *   4. A lead_routing_logs row is written by the orchestrator
   *      INSIDE the same transaction — atomic with the lead update,
   *      and ALWAYS written even when no eligible agent exists.
   *   5. If a winner was picked, this method applies the decision:
   *      lead.assignedToId update + activity row + SLA reset +
   *      users.last_assigned_at bump (powers true round-robin).
   *
   * Returns the updated Lead, or null when no eligible agent exists
   * (the lead is left unassigned and an audit row records why).
   *
   * Backward compatibility:
   *   - The HTTP route POST /leads/:id/auto-assign is unchanged.
   *   - The activity payload still carries `event='auto_assignment'`
   *     and `strategy=...` — the strategy NAME changed
   *     ('rule' → 'specific_user', 'round_robin' kept) but the field
   *     name + presence is preserved.
   *   - Source-based routing still works: the same source→user
   *     intent is now expressed by a row in `distribution_rules`
   *     (migration 0027 backfilled the legacy JSONB rules).
   */
  async autoAssign(id: string, actorUserId: string | null = null) {
    if (!this.distribution) {
      throw new Error(
        'LeadsService.autoAssign requires DistributionService — wire it via DistributionModule (or pass it explicitly in tests).',
      );
    }
    const tenantId = requireTenantId();
    const before = await this.findByIdOrThrow(id);

    if (before.stage.isTerminal) {
      throw new BadRequestException({
        code: 'lead.terminal_stage',
        message: `Cannot auto-assign a lead in terminal stage "${before.stage.code}"`,
      });
    }

    const settings = await this.tenantSettings.getCurrent();

    // Build the routing context for the engine. companyId / countryId
    // are looked up via the lead's stage → pipeline → company/country.
    // The lookup is a single tx-scoped read.
    const routeCtx: RoutingContext = {
      tenantId,
      leadId: id,
      source: before.source,
      companyId: null,
      countryId: null,
      currentAssigneeId: before.assignedToId ?? null,
    };

    const result = await this.prisma.withTenant(tenantId, async (tx) => {
      // Phase 1B — prefer the lead's own (companyId, countryId) when
      // populated; fall back to the pipeline's scope for legacy leads
      // that pre-date B3. The fallback exists so old rows still match
      // company/country distribution rules through the pipeline they
      // were placed on.
      if (before.companyId || before.countryId) {
        routeCtx.companyId = before.companyId;
        routeCtx.countryId = before.countryId;
      } else {
        const stageRow = await tx.pipelineStage.findUnique({
          where: { id: before.stageId },
          select: { pipeline: { select: { companyId: true, countryId: true } } },
        });
        routeCtx.companyId = stageRow?.pipeline?.companyId ?? null;
        routeCtx.countryId = stageRow?.pipeline?.countryId ?? null;
      }

      // 1. Run the engine — writes lead_routing_logs row in this tx.
      const decision = await this.distribution!.route(routeCtx, tx);

      if (!decision.chosenUserId) {
        // No eligible agent. Lead stays as-is. The log row is
        // already persisted; the operator sees the exclusion
        // reasons in /admin/distribution → Routing log.
        return { lead: null, decision };
      }

      const pickedId = decision.chosenUserId;

      // 2. Apply the decision: lead.assignedToId + activity + SLA
      //    reset + last_assigned_at bump (the round_robin clock).
      await tx.lead.update({
        where: { id },
        data: { assignedToId: pickedId },
      });
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId: id,
          type: 'auto_assignment',
          body: `Lead auto-assigned via ${decision.strategy}`,
          payload: {
            event: 'auto_assignment',
            fromUserId: before.assignedToId ?? null,
            strategy: decision.strategy,
            ruleId: decision.ruleId,
            source: before.source,
          } as Prisma.InputJsonValue,
          createdById: actorUserId,
        },
      });
      // Bump users.last_assigned_at so the next round_robin call sees
      // the rotation advance. Cheap unconditional update — even
      // strategies that don't consume the field benefit from accurate
      // bookkeeping (so a future strategy switch works correctly).
      await tx.user.update({
        where: { id: pickedId },
        data: { lastAssignedAt: new Date() },
      });

      // 3. Fresh SLA window for the new owner.
      const lead = await tx.lead.update({
        where: { id },
        data: {
          slaDueAt: this.sla.computeDueAt(new Date(), settings.slaMinutes),
          slaStatus: 'active',
        },
        include: { stage: true, captain: true },
      });
      return { lead, decision };
    });

    // P3-02 — push to the new owner (best-effort; never blocks).
    if (result.decision.chosenUserId && this.realtime) {
      try {
        this.realtime.emitToUser(tenantId, result.decision.chosenUserId, {
          type: 'lead.assigned',
          leadId: id,
          toUserId: result.decision.chosenUserId,
          fromUserId: before.assignedToId ?? null,
          reason: 'auto',
        });
      } catch {
        /* swallowed — best-effort push */
      }
    }
    return result.lead;
  }

  // ───────────────────────────────────────────────────────────────────────
  // move stage
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Phase 1B — accept either a stage UUID or a stage code. The lookup
   * is scoped to the lead's own pipeline, so two pipelines that
   * happen to share a stage code (e.g. both have "contacted") never
   * cross-pollinate. A stage UUID from the wrong pipeline is rejected
   * with `pipeline.stage.cross_pipeline_move`.
   *
   * For backward compatibility with pre-1B leads that don't yet
   * carry `pipelineId`, we fall back to the stage's own pipeline (the
   * stage is the source of truth — `Lead.pipelineId` is denormalised).
   */
  async moveStage(
    id: string,
    target: {
      stageCode?: string;
      pipelineStageId?: string;
      lostReasonId?: string;
      lostNote?: string;
    },
    actorUserId: string,
    userClaims?: ScopeUserClaims,
  ) {
    if (Boolean(target.stageCode) === Boolean(target.pipelineStageId)) {
      throw new BadRequestException({
        code: 'lead.move_stage.invalid_target',
        message: 'pass exactly one of stageCode or pipelineStageId',
      });
    }
    const tenantId = requireTenantId();
    const before = await this.findByIdOrThrow(id);

    // Phase C — C5.5: moveStage modifies several catalogued fields
    // as side-effects (lifecycleState, lostReasonId, lostNote,
    // slaStatus, slaDueAt, lastResponseAt, nextActionDueAt). If the
    // calling role denies write on any of them, the natural flow
    // would silently bypass that denial — so check the deny set
    // up front and silent-no-op + audit when an overlap exists.
    // Consistent with create/update/assign behaviour.
    //
    // Notes:
    //   • `stageId` itself is NOT in the catalogue (it's a structural
    //     pointer, not a value field) so `lead.stage.move`
    //     capability is the primary gate. The catalogued fields
    //     listed below are the *side-effects* of a stage move.
    //   • TODO: when the catalogue gains `stageId` (or pipelineId
    //     becomes write-controlled per role) the same overlap check
    //     handles it without changes.
    const denyPaths = await this.leadWriteDenyPaths(userClaims);
    if (denyPaths.length > 0) {
      const moveStageTouches = [
        'lifecycleState',
        'lostReasonId',
        'lostNote',
        'slaStatus',
        'slaDueAt',
        'nextActionDueAt',
      ];
      const overlap = moveStageTouches.filter((f) => denyPaths.includes(f));
      if (overlap.length > 0) {
        await this.auditFieldWriteDenied(userClaims, 'moveStage', id, overlap);
        return before;
      }
    }
    // Lead's pipeline — denormalised column is the fast path; fall
    // back to the stage row for legacy leads still on NULL.
    const leadPipelineId = before.pipelineId ?? before.stage.pipelineId;

    let toStage: {
      id: string;
      code: string;
      name: string;
      isTerminal: boolean;
      terminalKind: string | null;
    };
    if (target.pipelineStageId) {
      // Explicit UUID path — verify it belongs to the lead's pipeline.
      try {
        toStage = await this.pipeline.findStageInPipelineOrThrow(
          leadPipelineId,
          target.pipelineStageId,
        );
      } catch (err) {
        // Re-shape into the user-facing "cross-pipeline" error so the
        // caller can branch on `code` independently of generic 404s.
        if (
          err &&
          typeof err === 'object' &&
          'getResponse' in err &&
          typeof (err as { getResponse: unknown }).getResponse === 'function'
        ) {
          const r = (err as { getResponse: () => unknown }).getResponse();
          if (
            r &&
            typeof r === 'object' &&
            (r as Record<string, unknown>).code === 'pipeline.stage.not_in_pipeline'
          ) {
            throw new BadRequestException({
              code: 'pipeline.stage.cross_pipeline_move',
              message: `Stage ${target.pipelineStageId} does not belong to this lead's pipeline (${leadPipelineId})`,
            });
          }
        }
        throw err;
      }
    } else {
      // Code path — resolved against the lead's pipeline only.
      toStage = await this.pipeline.findCodeInPipelineOrThrow(leadPipelineId, target.stageCode!);
    }

    if (before.stageId === toStage.id) {
      // No-op transitions are silently accepted to keep the flow idempotent
      // for clients that don't track current state.
      return before;
    }

    // ─── Phase A — A3: lost-reason validation + lifecycle write ───
    //
    // Three rules:
    //   1. Moving to terminalKind='lost' MUST include a lostReasonId.
    //   2. Moving to anything else MUST NOT include a lostReasonId
    //      (catches accidental UI sends; keeps the row clean).
    //   3. The lostReasonId, if present, must exist in this tenant
    //      AND be active. Inactive reasons reject identically to
    //      missing ones — the picker should never surface an
    //      inactive reason in the first place.
    //
    // `lifecycleState` is computed from the target stage's
    // terminalKind ('won', 'lost', or null → 'open'). Returning to a
    // non-terminal stage automatically clears any prior lostReasonId
    // / lostNote — leaving them set on a non-lost lead would be
    // misleading.
    if (toStage.terminalKind === 'lost') {
      if (!target.lostReasonId) {
        throw new BadRequestException({
          code: 'lead.lost_reason_required',
          message: 'lostReasonId is required when moving to a "lost" stage',
        });
      }
    } else if (target.lostReasonId) {
      throw new BadRequestException({
        code: 'lead.lost_reason_only_on_lost_stage',
        message: 'lostReasonId is only valid when moving to a "lost" stage',
      });
    }

    const settings = await this.tenantSettings.getCurrent();
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Validate the lostReasonId inside the same tx so the read
      // sees the same RLS scope. Returns null for unknown OR
      // inactive — both reject with the same code.
      if (toStage.terminalKind === 'lost' && target.lostReasonId) {
        if (!this.lostReasons) {
          throw new BadRequestException({
            code: 'lead.lost_reason_unavailable',
            message: 'LostReasonsService is not wired in this context',
          });
        }
        const reason = await this.lostReasons.findActiveByIdInTx(tx, target.lostReasonId);
        if (!reason) {
          throw new BadRequestException({
            code: 'lead.lost_reason_not_in_tenant',
            message: `Lost reason ${target.lostReasonId} not found or inactive`,
          });
        }
      }

      // Stage transitions drive SLA state:
      //   non-terminal → fresh window (counts as agent response).
      //   terminal     → pause; the breach scanner ignores paused rows.
      const now = new Date();
      const sla: Prisma.LeadUncheckedUpdateInput = toStage.isTerminal
        ? { slaDueAt: null, slaStatus: 'paused' }
        : {
            slaDueAt: this.sla.computeDueAt(now, settings.slaMinutes),
            slaStatus: 'active',
            lastResponseAt: now,
          };

      // Phase A — derive lifecycleState + write the lost-reason
      // payload (or clear it). 'archived' is set only via a
      // dedicated admin path, not via stage move.
      const lifecycleState =
        toStage.terminalKind === 'won' ? 'won' : toStage.terminalKind === 'lost' ? 'lost' : 'open';

      const lostFields: Prisma.LeadUncheckedUpdateInput =
        toStage.terminalKind === 'lost'
          ? { lostReasonId: target.lostReasonId!, lostNote: target.lostNote ?? null }
          : { lostReasonId: null, lostNote: null };

      const updated = await tx.lead.update({
        where: { id },
        data: {
          stageId: toStage.id,
          lifecycleState,
          ...lostFields,
          ...sla,
        },
        include: { stage: true, captain: true },
      });
      await this.appendActivity(tx, {
        tenantId,
        leadId: id,
        type: 'stage_change',
        body: `Stage changed: ${before.stage.code} → ${toStage.code}`,
        payload: {
          event: 'stage_change',
          fromStageCode: before.stage.code,
          fromStageId: before.stageId,
          toStageCode: toStage.code,
          toStageId: toStage.id,
          // Phase A — surface the lifecycle classifier on the activity
          // payload so the timeline can render badges directly.
          toLifecycleState: lifecycleState,
          ...(target.lostReasonId && { lostReasonId: target.lostReasonId }),
        },
        createdById: actorUserId,
      });
      // Phase C — C10B-3: maintain Contact.hasOpenLead on terminal
      // transitions. If the lead is contact-linked AND the new stage
      // is terminal, and no OTHER non-terminal lead exists for the
      // same contact, the flag flips off. The recompute ignores `id`
      // itself because the row we just updated reflects the new
      // (terminal) state, but defending against read ordering with
      // an explicit exclude keeps the predicate self-evident. The
      // backfill (C10B-2) is the safety net for any drift.
      if (updated.contactId && toStage.isTerminal) {
        const stillOpen = await tx.lead.count({
          where: {
            contactId: updated.contactId,
            id: { not: id },
            lifecycleState: 'open',
          },
        });
        if (stillOpen === 0) {
          await tx.contact.update({
            where: { id: updated.contactId },
            data: { hasOpenLead: false },
          });
        }
      }
      // Inverse: a return-from-terminal stage flips the flag back on.
      if (updated.contactId && !toStage.isTerminal && before.stage.isTerminal) {
        await tx.contact.update({
          where: { id: updated.contactId },
          data: { hasOpenLead: true },
        });
      }
      return updated;
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // activities (notes / calls)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * addActivity (notes / calls).
   *
   * Phase C — C5.5: ACTIVITY CHANNEL POLICY
   *
   *   • `dto.body` is FREEFORM USER PROSE. The field-permission
   *     system never censors body text — censoring user-typed
   *     prose would be wrong (and ineffective: a user can also
   *     type values into the email body or note title in any other
   *     CRM field). UX guidance lives in the client.
   *
   *   • `dto` may NOT carry structured payload fields today —
   *     AddActivityDto is `{ type, body }`. The internal
   *     `payload` JSON column on `lead_activities` is set only by
   *     other LeadsService methods (moveStage, assign, convert)
   *     using payloads we author here, and those payloads never
   *     contain catalogued lead values.
   *
   *   • TODO (when AddActivityDto grows a structured `payload`
   *     field): pass it through `stripLeadWriteDenies` so a future
   *     emitter that puts `{ source: '…' }` in there is filtered
   *     against the calling role's lead-resource denies. The
   *     defensive guard below already strips any keys outside the
   *     known set so an unwired schema addition can't slip through.
   *
   *   • The C4 read filter mirrors lead-resource denies onto
   *     activity-row payloads on read, so even if an internal
   *     emitter accidentally writes a denied value, the role can't
   *     SEE it. Defence in depth.
   */
  async addActivity(id: string, dto: AddActivityDto, actorUserId: string) {
    const tenantId = requireTenantId();
    const before = await this.findByIdOrThrow(id);
    const settings = await this.tenantSettings.getCurrent();

    // Phase C — C5.5 + D1.1: defensive guard. AddActivityDto carries
    // `type` + `body` + (D1.1) optional `actionSource`. Drop any
    // unknown structured keys before the row hits the DB.
    const knownKeys: ReadonlyArray<keyof AddActivityDto> = ['type', 'body', 'actionSource'];
    for (const k of Object.keys(dto) as Array<keyof AddActivityDto>) {
      if (!knownKeys.includes(k)) {
        delete (dto as Record<string, unknown>)[k as string];
      }
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const created = await tx.leadActivity.create({
        data: {
          tenantId,
          leadId: id,
          type: dto.type,
          body: dto.body,
          createdById: actorUserId,
          // D1.1 — schema column default is 'lead'; only override
          // when the caller passed an explicit actionSource.
          ...(dto.actionSource && { actionSource: dto.actionSource }),
        },
        select: {
          id: true,
          type: true,
          body: true,
          payload: true,
          createdAt: true,
          createdById: true,
        },
      });

      // C37 — denormalise the latest activity timestamp onto the lead.
      await tx.lead.update({
        where: { id },
        data: { lastActivityAt: created.createdAt },
      });

      // Agent-driven activity types reset the response-SLA window. We
      // never resurrect a paused (terminal) SLA — once a lead is
      // converted/lost the clock stays off until a human moves it back
      // to a non-terminal stage via moveStage().
      if (isSlaResetting(dto.type) && !before.stage.isTerminal) {
        await this.sla.resetForLead(tx, id, {
          markResponse: true,
          slaMinutes: settings.slaMinutes,
        });
      }

      return created;
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // helpers
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Phase C — C10B-3: create a lead from an inbound WhatsApp message.
   *
   * Distinct from the public `create()` because:
   *   - assignment is PRE-RESOLVED by the inbound flow's
   *     `routeConversation` call, so we MUST NOT call DistributionService
   *     a second time (would double-route + double-log).
   *   - SLA is initialised from the tenant settings with `actorUserId`
   *     null (system path; the webhook has no user claims).
   *   - the activity row is tagged `actionSource='whatsapp'` so the
   *     timeline distinguishes WhatsApp-sourced leads from manual /
   *     import paths.
   *   - `Contact.hasOpenLead` is set to true in the same tx so the
   *     denormalised flag stays accurate.
   *   - `Contact.id` is linked into `Lead.contactId`; the latest
   *     conversation pointer becomes `Lead.primaryConversationId`.
   *
   * Race handling: the surrounding inbound orchestrator catches P2002
   * on the `(tenantId, phone)` unique constraint and falls back to the
   * "1-match-found" branch (link the conversation to the existing
   * lead instead of failing). The orchestrator handles the catch; we
   * just propagate the error with the typed code below.
   */
  async createFromWhatsApp(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      contactId: string;
      phone: string;
      name: string;
      profileName?: string | null;
      waId?: string | null;
      companyId: string | null;
      countryId: string | null;
      assignedToId: string;
      primaryConversationId: string;
    },
  ): Promise<{ id: string; stageCode: string }> {
    const settings = await this.tenantSettings.getInTx(tx, input.tenantId);

    // Pipeline resolution mirrors `create()`: the company × country
    // fallback chain via PipelineService.
    const pipeline = await this.pipeline.resolveForLeadInTx(tx, {
      companyId: input.companyId,
      countryId: input.countryId,
    });
    const stage = await tx.pipelineStage.findFirst({
      where: { pipelineId: pipeline.id, isTerminal: false },
      orderBy: { order: 'asc' },
      select: { id: true, code: true },
    });
    if (!stage) {
      throw new BadRequestException({
        code: 'pipeline.no_entry_stage',
        message: `Pipeline ${pipeline.id} has no non-terminal entry stage`,
      });
    }

    const now = new Date();
    const slaDueAt = this.sla.computeDueAt(now, settings.slaMinutes);

    // C10B-3: stash the raw WhatsApp identity bits in the
    // `custom` block of the attribution payload so reporting can
    // surface them later without a schema migration. The `name`
    // field on AttributionRef matches Meta's profile-name semantic
    // for the campaign slot.
    const attribution = buildAttribution('whatsapp', {
      ...(input.profileName && { campaign: { name: input.profileName } }),
      ...(input.waId && { ad: { id: input.waId } }),
    });

    try {
      const lead = await tx.lead.create({
        data: {
          tenantId: input.tenantId,
          name: input.name,
          phone: input.phone,
          source: 'whatsapp',
          attribution: attribution as unknown as Prisma.InputJsonValue,
          companyId: input.companyId,
          countryId: input.countryId,
          pipelineId: pipeline.id,
          stageId: stage.id,
          lifecycleState: 'open',
          assignedToId: input.assignedToId,
          createdById: null,
          slaDueAt,
          slaStatus: 'active',
          contactId: input.contactId,
          primaryConversationId: input.primaryConversationId,
        },
        select: { id: true },
      });

      await this.appendActivity(tx, {
        tenantId: input.tenantId,
        leadId: lead.id,
        type: 'system',
        body: 'Lead created from inbound WhatsApp',
        payload: {
          event: 'created',
          stageCode: stage.code,
          stageId: stage.id,
          pipelineId: pipeline.id,
          source: 'whatsapp',
          contactId: input.contactId,
          primaryConversationId: input.primaryConversationId,
        },
        createdById: null,
        actionSource: 'whatsapp',
      });

      // C10B-3: keep Contact.hasOpenLead in sync — this freshly-created
      // lead is by definition open. Backfill is the safety net (C10B-2)
      // but the inbound flow needs the up-to-the-millisecond truth so
      // the next inbound for the same phone sees `hasOpenLead = true`
      // and routes to the "1 match" branch instead of duplicating.
      await tx.contact.update({
        where: { id: input.contactId },
        data: { hasOpenLead: true, lastSeenAt: now },
      });

      return { id: lead.id, stageCode: stage.code };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'lead.duplicate_phone',
          message: `A lead with phone ${input.phone} already exists in this tenant`,
        });
      }
      throw err;
    }
  }

  /**
   * Append a system / agent activity row inside an existing transaction.
   * Service callers use this to keep a single transaction around
   * lead-mutation + activity-write so the audit timeline never drifts.
   *
   * Phase C — C10B-3: `actionSource` carries the provenance of the
   * activity — 'lead' (default; agent action on the lead detail page),
   * 'whatsapp' (chat surface), 'system' (automation), or 'import'
   * (CSV / batch). Defaults to 'lead' so every existing caller keeps
   * the schema-default behaviour without code changes.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async appendActivity(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      leadId: string;
      type: ActivityType;
      body?: string | null;
      payload?: Record<string, unknown> | null;
      createdById?: string | null;
      actionSource?: 'lead' | 'whatsapp' | 'system' | 'import';
    },
  ) {
    await tx.leadActivity.create({
      data: {
        tenantId: input.tenantId,
        leadId: input.leadId,
        type: input.type,
        body: input.body ?? null,
        payload: (input.payload ?? null) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
        createdById: input.createdById ?? null,
        ...(input.actionSource && { actionSource: input.actionSource }),
      },
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // P3-05 — bulk actions
  //
  // Each bulk endpoint dispatches the existing single-id mutator per lead
  // so the audit / activity / SLA / realtime emitter side-effects remain
  // identical to the one-at-a-time path. The result envelope is
  // `{ updated: string[], failed: { id, code, message }[] }` — the
  // controller serialises both halves so a partial failure (one bad
  // lead in the batch) doesn't poison the rest.
  // ───────────────────────────────────────────────────────────────────────

  async bulkAssign(dto: BulkAssignDto, actorUserId: string) {
    const updated: string[] = [];
    const failed: Array<{ id: string; code: string; message: string }> = [];
    if (dto.assignedToId !== null) {
      // Validate the assignee once up-front so we don't spam the same
      // 400 for every lead in the batch.
      await this.assertUserInTenant(dto.assignedToId);
    }
    for (const id of dto.leadIds) {
      try {
        await this.assign(id, dto.assignedToId, actorUserId);
        updated.push(id);
      } catch (err) {
        failed.push(toFailure(id, err));
      }
    }
    return { updated, failed };
  }

  async bulkMoveStage(dto: BulkMoveStageDto, actorUserId: string) {
    const updated: string[] = [];
    const failed: Array<{ id: string; code: string; message: string }> = [];
    // Phase 1B — re-shape the input so each call passes the correct
    // discriminator; per-lead pipeline resolution lives inside
    // moveStage.
    //
    // Phase A — forward lostReasonId / lostNote so a single bulk
    // batch can mark many leads as lost with one reason. Per-lead
    // validation (terminal=lost requires reason; non-lost forbids
    // it) happens inside moveStage; if the batch's target is a
    // mix of lost and non-lost destinations across pipelines, the
    // failures get reported per-lead in the result envelope.
    const target = {
      ...(dto.pipelineStageId
        ? { pipelineStageId: dto.pipelineStageId }
        : { stageCode: dto.stageCode! }),
      ...(dto.lostReasonId !== undefined && { lostReasonId: dto.lostReasonId }),
      ...(dto.lostNote !== undefined && { lostNote: dto.lostNote }),
    };
    for (const id of dto.leadIds) {
      try {
        await this.moveStage(id, target, actorUserId);
        updated.push(id);
      } catch (err) {
        failed.push(toFailure(id, err));
      }
    }
    return { updated, failed };
  }

  async bulkDelete(dto: BulkDeleteDto) {
    const updated: string[] = [];
    const failed: Array<{ id: string; code: string; message: string }> = [];
    for (const id of dto.leadIds) {
      try {
        await this.delete(id);
        updated.push(id);
      } catch (err) {
        failed.push(toFailure(id, err));
      }
    }
    return { updated, failed };
  }

  private async assertUserInTenant(userId: string): Promise<void> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { id: true, status: true } }),
    );
    if (!row) {
      throw new BadRequestException({
        code: 'user.not_in_tenant',
        message: `User ${userId} is not a member of the active tenant`,
      });
    }
    if (row.status === 'disabled') {
      throw new BadRequestException({
        code: 'user.disabled',
        message: `User ${userId} is disabled`,
      });
    }
  }
}

/**
 * P3-05 — narrow an arbitrary error into the bulk-result failure
 * shape. Nest's HttpException carries `{ code, message }` in its
 * response object; everything else falls back to the message.
 */
function toFailure(id: string, err: unknown): { id: string; code: string; message: string } {
  const fallback = err instanceof Error ? err.message : String(err);
  if (
    err &&
    typeof err === 'object' &&
    'getResponse' in err &&
    typeof (err as { getResponse: unknown }).getResponse === 'function'
  ) {
    const r = (err as { getResponse: () => unknown }).getResponse();
    if (r && typeof r === 'object') {
      const obj = r as Record<string, unknown>;
      const code = typeof obj['code'] === 'string' ? obj['code'] : 'bulk.unknown';
      const message = typeof obj['message'] === 'string' ? obj['message'] : fallback;
      return { id, code, message };
    }
  }
  return { id, code: 'bulk.unknown', message: fallback };
}
