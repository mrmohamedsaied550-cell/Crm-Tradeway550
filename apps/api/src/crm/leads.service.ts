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
import { requireTenantId } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { PipelineService } from './pipeline.service';
import { DEFAULT_STAGE_CODE, isSlaResetting, type ActivityType } from './pipeline.registry';
import { normalizeE164WithDefault } from './phone.util';
import { dayBoundsInTimezone } from './time.util';
import { AssignmentService } from './assignment.service';
import { SlaService } from './sla.service';
import type {
  CreateLeadDto,
  UpdateLeadDto,
  AddActivityDto,
  ListLeadsQueryDto,
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
    private readonly assignment: AssignmentService,
    private readonly sla: SlaService,
    private readonly tenantSettings: TenantSettingsService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // create
  // ───────────────────────────────────────────────────────────────────────

  async create(dto: CreateLeadDto, actorUserId: string) {
    const tenantId = requireTenantId();
    const stage = await this.pipeline.findByCodeOrThrow(dto.stageCode ?? DEFAULT_STAGE_CODE);
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
          payload: { event: 'created', stageCode: stage.code, source: dto.source },
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
          stage: { select: { id: true, code: true, name: true, order: true, isTerminal: true } },
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
    const stageId = query.stageCode
      ? (await this.pipeline.findByCodeOrThrow(query.stageCode)).id
      : undefined;

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
      ...(stageId && { stageId }),
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
   * Auto-assign a lead via the round-robin AssignmentService. Returns the
   * updated lead, or null when no eligible agent is available. Writes an
   * `auto_assignment` activity and resets the SLA window for the new
   * owner. No-op if the lead is already assigned to the picked agent.
   */
  async autoAssign(id: string, actorUserId: string | null = null) {
    const tenantId = requireTenantId();
    const before = await this.findByIdOrThrow(id);

    if (before.stage.isTerminal) {
      throw new BadRequestException({
        code: 'lead.terminal_stage',
        message: `Cannot auto-assign a lead in terminal stage "${before.stage.code}"`,
      });
    }

    const settings = await this.tenantSettings.getCurrent();

    // PL-3 — distribution rule consultation. If a rule names a user
    // for this lead's source AND that user is currently eligible
    // (active, sales-facing role, NOT the lead's current assignee),
    // route the lead straight to them. Otherwise fall through to
    // round-robin. The "is the user still eligible" check uses the
    // same role list the round-robin picker enforces, so the rule
    // can never escalate beyond what the picker would accept.
    const ruled = settings.distributionRules.find((r) => r.source === before.source);
    const excludeForRR = before.assignedToId ? [before.assignedToId] : [];

    const result = await this.prisma.withTenant(tenantId, async (tx) => {
      let pickedId: string | null = null;
      let strategy: 'rule' | 'round_robin' = 'round_robin';

      if (ruled && ruled.assigneeUserId !== before.assignedToId) {
        const candidate = await tx.user.findFirst({
          where: {
            id: ruled.assigneeUserId,
            status: 'active',
            role: { code: { in: [...AssignmentService.ELIGIBLE_ROLE_CODES] } },
          },
          select: { id: true },
        });
        if (candidate) {
          // Apply the rule directly. We mirror the round-robin path's
          // side-effects (lead.assignedToId update + audit activity)
          // so the timeline reads identically regardless of strategy.
          await tx.lead.update({
            where: { id },
            data: { assignedToId: candidate.id },
          });
          await tx.leadActivity.create({
            data: {
              tenantId,
              leadId: id,
              type: 'auto_assignment',
              body: `Lead auto-assigned via distribution rule (source=${before.source})`,
              payload: {
                event: 'auto_assignment',
                fromUserId: before.assignedToId ?? null,
                strategy: 'rule',
                source: before.source,
              } as Prisma.InputJsonValue,
              createdById: actorUserId,
            },
          });
          pickedId = candidate.id;
          strategy = 'rule';
        }
        // If the rule's user is no longer eligible (disabled / role
        // changed), silently fall back to round-robin below.
      }

      if (!pickedId) {
        pickedId = await this.assignment.assignLeadViaRoundRobin({
          tx,
          leadId: id,
          tenantId,
          // Don't pick the current assignee — auto-assign is meaningful
          // either when the lead is unassigned or as a manual rotation.
          excludeUserIds: excludeForRR,
          activityType: 'auto_assignment',
          actorUserId,
          body: 'Lead auto-assigned via round-robin',
          payload: {
            event: 'auto_assignment',
            fromUserId: before.assignedToId ?? null,
            strategy: 'round_robin',
          },
        });
      }

      if (!pickedId) {
        return { lead: null, pickedId: null as string | null, strategy };
      }

      // Fresh SLA window for the new owner.
      const lead = await tx.lead.update({
        where: { id },
        data: {
          slaDueAt: this.sla.computeDueAt(new Date(), settings.slaMinutes),
          slaStatus: 'active',
        },
        include: { stage: true, captain: true },
      });
      return { lead, pickedId, strategy };
    });

    // P3-02 — push to the new owner.
    if (result.pickedId && this.realtime) {
      try {
        this.realtime.emitToUser(tenantId, result.pickedId, {
          type: 'lead.assigned',
          leadId: id,
          toUserId: result.pickedId,
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

  async moveStage(id: string, toStageCode: string, actorUserId: string) {
    const tenantId = requireTenantId();
    const before = await this.findByIdOrThrow(id);
    const toStage = await this.pipeline.findByCodeOrThrow(toStageCode);

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
          toStageCode: toStage.code,
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
    for (const id of dto.leadIds) {
      try {
        await this.moveStage(id, dto.stageCode, actorUserId);
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
