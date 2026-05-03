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
import { requireTenantId } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
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
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // create
  // ───────────────────────────────────────────────────────────────────────

  async create(dto: CreateLeadDto, actorUserId: string) {
    const tenantId = requireTenantId();
    const settings = await this.tenantSettings.getCurrent();

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
        let stage: { id: string; code: string; name: string; isTerminal: boolean };

        if (dto.pipelineStageId) {
          const row = await tx.pipelineStage.findUnique({
            where: { id: dto.pipelineStageId },
            select: {
              id: true,
              code: true,
              name: true,
              isTerminal: true,
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
              select: { id: true, code: true, name: true, isTerminal: true },
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

        const lead = await tx.lead.create({
          data: {
            tenantId,
            name: dto.name,
            phone,
            email: dto.email ?? null,
            source: dto.source,
            companyId: dto.companyId ?? null,
            countryId: dto.countryId ?? null,
            pipelineId,
            stageId: stage.id,
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

  async list(query: ListLeadsQueryDto) {
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

    const where: Prisma.LeadWhereInput = {
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

    return this.prisma.withTenant(tenantId, async (tx) => {
      const [items, total] = await Promise.all([
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
      return { items, total, limit: query.limit, offset: query.offset };
    });
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
  async listByStage(query: ListLeadsByStageQueryDto) {
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
    const baseWhere: Prisma.LeadWhereInput = {
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
      const buckets = await Promise.all(
        stages.map(async (s) => {
          const total = countByStageId.get(s.id) ?? 0;
          if (total === 0) {
            return { stage: s, totalCount: 0, leads: [] };
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

      return {
        pipelineId: query.pipelineId,
        perStage,
        stages: buckets,
      };
    });
  }

  /**
   * C37 — leads whose `nextActionDueAt` is in the past (and still
   * non-null, i.e. there is a pending follow-up). Optionally filtered
   * to a specific assignee — the agent workspace passes `me`.
   */
  async listOverdue(opts: { assignedToId?: string; limit?: number; now?: Date } = {}) {
    const tenantId = requireTenantId();
    const now = opts.now ?? new Date();
    const where: Prisma.LeadWhereInput = {
      nextActionDueAt: { lt: now },
      ...(opts.assignedToId && { assignedToId: opts.assignedToId }),
    };
    return this.prisma.withTenant(tenantId, (tx) =>
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
  }

  /**
   * C37 — leads whose `nextActionDueAt` falls within today's wall-clock
   * window (server local time). Optionally filtered to a specific
   * assignee.
   */
  async listDueToday(opts: { assignedToId?: string; limit?: number; now?: Date } = {}) {
    const tenantId = requireTenantId();
    const now = opts.now ?? new Date();
    // P2-08 — compute the day boundary in the TENANT's timezone, not
    // the server's. An admin in Cairo and an admin in Casablanca
    // running off the same server should each see "their" today.
    const settings = await this.tenantSettings.getCurrent();
    const { start, end } = dayBoundsInTimezone(now, settings.timezone);
    const where: Prisma.LeadWhereInput = {
      nextActionDueAt: { gte: start, lte: end },
      ...(opts.assignedToId && { assignedToId: opts.assignedToId }),
    };
    return this.prisma.withTenant(tenantId, (tx) =>
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
  }

  listActivities(leadId: string) {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
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
  }

  // ───────────────────────────────────────────────────────────────────────
  // update / delete
  // ───────────────────────────────────────────────────────────────────────

  async update(id: string, dto: UpdateLeadDto, actorUserId: string) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);

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

  async assign(id: string, assigneeUserId: string | null, actorUserId: string) {
    const tenantId = requireTenantId();
    const before = await this.findByIdOrThrow(id);

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
    target: { stageCode?: string; pipelineStageId?: string },
    actorUserId: string,
  ) {
    if (Boolean(target.stageCode) === Boolean(target.pipelineStageId)) {
      throw new BadRequestException({
        code: 'lead.move_stage.invalid_target',
        message: 'pass exactly one of stageCode or pipelineStageId',
      });
    }
    const tenantId = requireTenantId();
    const before = await this.findByIdOrThrow(id);
    // Lead's pipeline — denormalised column is the fast path; fall
    // back to the stage row for legacy leads still on NULL.
    const leadPipelineId = before.pipelineId ?? before.stage.pipelineId;

    let toStage: { id: string; code: string; name: string; isTerminal: boolean };
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

    const settings = await this.tenantSettings.getCurrent();
    return this.prisma.withTenant(tenantId, async (tx) => {
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

      const updated = await tx.lead.update({
        where: { id },
        data: { stageId: toStage.id, ...sla },
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
        },
        createdById: actorUserId,
      });
      return updated;
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // activities (notes / calls)
  // ───────────────────────────────────────────────────────────────────────

  async addActivity(id: string, dto: AddActivityDto, actorUserId: string) {
    const tenantId = requireTenantId();
    const before = await this.findByIdOrThrow(id);
    const settings = await this.tenantSettings.getCurrent();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const created = await tx.leadActivity.create({
        data: {
          tenantId,
          leadId: id,
          type: dto.type,
          body: dto.body,
          createdById: actorUserId,
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
   * Append a system / agent activity row inside an existing transaction.
   * Service callers use this to keep a single transaction around
   * lead-mutation + activity-write so the audit timeline never drifts.
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
    const target = dto.pipelineStageId
      ? { pipelineStageId: dto.pipelineStageId }
      : { stageCode: dto.stageCode! };
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
