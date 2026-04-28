import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import { PipelineService } from './pipeline.service';
import { DEFAULT_STAGE_CODE, type ActivityType } from './pipeline.registry';
import { normalizeE164 } from './phone.util';
import type { CreateLeadDto, UpdateLeadDto, AddActivityDto, ListLeadsQueryDto } from './leads.dto';

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
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // create
  // ───────────────────────────────────────────────────────────────────────

  async create(dto: CreateLeadDto, actorUserId: string) {
    const tenantId = requireTenantId();
    const stage = await this.pipeline.findByCodeOrThrow(dto.stageCode ?? DEFAULT_STAGE_CODE);

    // Defensive normalisation. The DTO's zod transform usually does this
    // before we get here, but the service is also called from tests +
    // background workers — keeping the canonical form at the service
    // boundary means the DB never sees a raw user-typed phone.
    const phone = normalizeE164(dto.phone);

    if (dto.assignedToId) {
      await this.assertUserInTenant(dto.assignedToId);
    }

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
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

    const where: Prisma.LeadWhereInput = {
      ...(stageId && { stageId }),
      ...(query.assignedToId && { assignedToId: query.assignedToId }),
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

    const normalizedPhone = dto.phone !== undefined ? normalizeE164(dto.phone) : undefined;

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

    return this.prisma.withTenant(tenantId, async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: { assignedToId: assigneeUserId },
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
      return updated;
    });
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

    return this.prisma.withTenant(tenantId, async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: { stageId: toStage.id },
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
    await this.findByIdOrThrow(id);

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.leadActivity.create({
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
      }),
    );
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
