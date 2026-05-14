import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ScopeUserClaims } from '../rbac/scope-context.service';
import { requireTenantId } from '../tenants/tenant-context';

import { LeadsService } from './leads.service';
import type {
  CreateLeadPartnerTargetDto,
  ListLeadPartnerTargetsQueryDto,
  UpdateLeadPartnerTargetDto,
} from './lead-partner-targets.dto';

/**
 * Sprint 13 (D13) — Lead Partner Targets service.
 *
 * Operator-driven write surface for "we want to pursue this real
 * person for an additional partner journey." Parallel to but
 * distinct from the read-side PartnerVerification projection
 * (which mirrors synced partner data).
 *
 * Permission model:
 *   • controller gates with `partner.target.read` / `.write`.
 *   • service runs every call through `LeadsService.findByIdInScopeOrThrow`
 *     so a user with `partner.target.write` but no `lead.read`
 *     for this lead can never reach the row.
 *
 * Dedupe contract:
 *   • DB unique index on (lead_id, partner_source_id).
 *   • Service catches the Prisma P2002 and throws a typed
 *     `lead.partner_target.duplicate` so the UI surfaces a
 *     clean error instead of a 500.
 *
 * Notifications:
 *   • When the create assigns a non-self owner, ship a generic
 *     notification ("A partner target was assigned to you. Open
 *     the lead for the details.") — no partner identity in the
 *     body since the recipient may not have partner.target.read.
 */
@Injectable()
export class LeadPartnerTargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ─────────────────── reads ───────────────────

  async listForLead(
    leadId: string,
    userClaims: ScopeUserClaims,
    opts: ListLeadPartnerTargetsQueryDto,
  ) {
    const tenantId = requireTenantId();
    await this.leads.findByIdInScopeOrThrow(leadId, userClaims);
    return this.prisma.withTenant(tenantId, async (tx) => {
      return tx.leadPartnerTarget.findMany({
        where: {
          leadId,
          ...(opts.status && { status: opts.status }),
          ...(opts.partnerSourceId && { partnerSourceId: opts.partnerSourceId }),
        },
        orderBy: [{ createdAt: 'desc' }],
        include: {
          partnerSource: {
            select: {
              id: true,
              partnerCode: true,
              displayName: true,
              companyId: true,
              countryId: true,
            },
          },
          owner: { select: { id: true, name: true, email: true } },
          createdBy: { select: { id: true, name: true, email: true } },
          team: { select: { id: true, name: true } },
          country: { select: { id: true, code: true, name: true } },
        },
      });
    });
  }

  // ─────────────────── writes ───────────────────

  async create(
    leadId: string,
    dto: CreateLeadPartnerTargetDto,
    userClaims: ScopeUserClaims,
  ): Promise<{ id: string }> {
    const tenantId = requireTenantId();
    // Scope gate — also gives us the lead row for defaults.
    const lead = await this.leads.findByIdInScopeOrThrow(leadId, userClaims);

    return this.prisma.withTenant(tenantId, async (tx) => {
      // Validate the partner source exists in this tenant. RLS
      // would filter it anyway; the explicit check gives the UI
      // a clean error code.
      const partnerSource = await tx.partnerSource.findFirst({
        where: { id: dto.partnerSourceId, isActive: true },
        select: { id: true, countryId: true, partnerCode: true, displayName: true },
      });
      if (!partnerSource) {
        throw new BadRequestException({
          code: 'lead.partner_target.partner_source_invalid',
          message: 'Partner source not found or inactive in the active tenant',
        });
      }

      // Validate ownerUserId is in the tenant (RLS would filter,
      // but cross-tenant uuids would be silently accepted by the
      // create FK because users.id is global; the explicit query
      // hardens the path).
      if (dto.ownerUserId) {
        const owner = await tx.user.findUnique({
          where: { id: dto.ownerUserId },
          select: { id: true },
        });
        if (!owner) {
          throw new BadRequestException({
            code: 'lead.partner_target.owner_invalid',
            message: 'Owner user not found in the active tenant',
          });
        }
      }
      if (dto.teamId) {
        const team = await tx.team.findUnique({
          where: { id: dto.teamId },
          select: { id: true },
        });
        if (!team) {
          throw new BadRequestException({
            code: 'lead.partner_target.team_invalid',
            message: 'Team not found in the active tenant',
          });
        }
      }

      const effectiveOwnerId = dto.ownerUserId ?? lead.assignedToId ?? null;
      const effectiveCountryId = dto.countryId ?? partnerSource.countryId ?? null;

      let created: { id: string };
      try {
        created = await tx.leadPartnerTarget.create({
          data: {
            tenantId,
            leadId,
            partnerSourceId: dto.partnerSourceId,
            status: dto.status ?? 'target',
            countryId: effectiveCountryId,
            teamId: dto.teamId ?? null,
            ownerUserId: effectiveOwnerId,
            createdById: userClaims.userId,
            note: dto.note ?? null,
          },
          select: { id: true },
        });
      } catch (err) {
        // P2002 → unique-index violation on (lead_id, partner_source_id).
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === 'P2002'
        ) {
          throw new ConflictException({
            code: 'lead.partner_target.duplicate',
            message: 'This partner target already exists for this lead.',
          });
        }
        throw err;
      }

      // Audit + activity in the same tx.
      await this.audit.writeInTx(tx, tenantId, {
        action: 'lead.partner_target.created',
        entityType: 'lead_partner_target',
        entityId: created.id,
        actorUserId: userClaims.userId,
        payload: {
          leadId,
          targetId: created.id,
          partnerSourceId: partnerSource.id,
          partnerCode: partnerSource.partnerCode,
          status: dto.status ?? 'target',
        } as Prisma.InputJsonValue,
      });
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId,
          type: 'system',
          body: `Partner target added (${partnerSource.displayName}).`,
          createdById: userClaims.userId,
          payload: {
            kind: 'partner_target',
            targetId: created.id,
            partnerSourceId: partnerSource.id,
            partnerCode: partnerSource.partnerCode,
          } as Prisma.InputJsonValue,
        },
      });

      // Notify the owner if it isn't the caller themselves.
      if (
        this.notifications &&
        effectiveOwnerId !== null &&
        effectiveOwnerId !== userClaims.userId
      ) {
        await this.notifications
          .createInTx(tx, tenantId, {
            recipientUserId: effectiveOwnerId,
            kind: 'lead.partner_target.assigned',
            title: 'Partner target assigned to you',
            // Generic body — recipient may not hold
            // partner.target.read for the lead's scope.
            body: 'A partner target was assigned to you. Open the lead for the details.',
            severity: 'info',
            actionUrl: `/admin/leads/${leadId}`,
            payload: {
              leadId,
              targetId: created.id,
            } as Prisma.InputJsonValue,
          })
          .catch(() => {
            /* swallow */
          });
      }

      return created;
    });
  }

  /**
   * Sprint 17 (D17) — partial update of an existing partner target.
   *
   * Closes the Sprint 13 PATCH deferral. Status, owner, team, country,
   * and note can be changed; `partnerSourceId` is intentionally
   * immutable so the unique-index dedupe key on
   * `(lead_id, partner_source_id)` keeps holding and the audit trail
   * stays interpretable.
   *
   * Permission model: same shape as `create()` — controller gates on
   * `partner.target.write`, service additionally enforces lead scope
   * via `LeadsService.findByIdInScopeOrThrow`. The target itself is
   * looked up under the active tenant context so RLS guarantees a
   * caller can never PATCH a target that belongs to a different
   * tenant (cross-tenant id surfaces as a clean 404).
   *
   * Notifications:
   *   - When the owner changes AND the new owner is not the caller,
   *     ship the same generic notification used on create.
   */
  async update(
    leadId: string,
    targetId: string,
    dto: UpdateLeadPartnerTargetDto,
    userClaims: ScopeUserClaims,
  ): Promise<{ id: string }> {
    const tenantId = requireTenantId();
    await this.leads.findByIdInScopeOrThrow(leadId, userClaims);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.leadPartnerTarget.findFirst({
        where: { id: targetId, leadId },
        select: {
          id: true,
          status: true,
          countryId: true,
          teamId: true,
          ownerUserId: true,
          note: true,
          partnerSource: {
            select: { id: true, partnerCode: true, displayName: true },
          },
        },
      });
      if (!before) {
        throw new NotFoundException({
          code: 'lead.partner_target.not_found',
          message: `Partner target ${targetId} not found for lead ${leadId}.`,
        });
      }

      // Validate optional FKs the same way create() does so the UI
      // surfaces typed errors instead of a raw FK failure. Skipped
      // when the caller is clearing the field (null) or leaving it
      // alone (undefined).
      if (typeof dto.ownerUserId === 'string') {
        const owner = await tx.user.findUnique({
          where: { id: dto.ownerUserId },
          select: { id: true },
        });
        if (!owner) {
          throw new BadRequestException({
            code: 'lead.partner_target.owner_invalid',
            message: 'Owner user not found in the active tenant',
          });
        }
      }
      if (typeof dto.teamId === 'string') {
        const team = await tx.team.findUnique({
          where: { id: dto.teamId },
          select: { id: true },
        });
        if (!team) {
          throw new BadRequestException({
            code: 'lead.partner_target.team_invalid',
            message: 'Team not found in the active tenant',
          });
        }
      }
      if (typeof dto.countryId === 'string') {
        const country = await tx.country.findUnique({
          where: { id: dto.countryId },
          select: { id: true },
        });
        if (!country) {
          throw new BadRequestException({
            code: 'lead.partner_target.country_invalid',
            message: 'Country not found in the active tenant',
          });
        }
      }

      // Build the update payload. Three-way null semantics: undefined
      // skips, null clears (for nullable columns), value sets.
      const data: Prisma.LeadPartnerTargetUpdateInput = {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.countryId !== undefined && { countryId: dto.countryId }),
        ...(dto.teamId !== undefined && { teamId: dto.teamId }),
        ...(dto.ownerUserId !== undefined && { ownerUserId: dto.ownerUserId }),
        ...(dto.note !== undefined && { note: dto.note }),
      };

      const updated = await tx.leadPartnerTarget.update({
        where: { id: targetId },
        data,
        select: { id: true, ownerUserId: true },
      });

      // Compute changed-fields list for the audit payload. Only the
      // keys actually present in the PATCH body are considered, so a
      // no-op PATCH still records "the operator looked but didn't
      // change anything" via an empty changedFields array.
      const changedFields = (Object.keys(dto) as (keyof UpdateLeadPartnerTargetDto)[]).filter(
        (key) => {
          const next = dto[key] as unknown;
          const prev = (before as unknown as Record<string, unknown>)[key] ?? null;
          return JSON.stringify(next ?? null) !== JSON.stringify(prev);
        },
      );

      await this.audit.writeInTx(tx, tenantId, {
        action: 'lead.partner_target.updated',
        entityType: 'lead_partner_target',
        entityId: targetId,
        actorUserId: userClaims.userId,
        payload: {
          leadId,
          targetId,
          partnerSourceId: before.partnerSource?.id,
          partnerCode: before.partnerSource?.partnerCode,
          changedFields,
          ...(dto.status !== undefined && { status: dto.status }),
        } as Prisma.InputJsonValue,
      });
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId,
          type: 'system',
          body:
            dto.status !== undefined && dto.status !== before.status
              ? `Partner target moved to ${dto.status} (${before.partnerSource?.displayName ?? ''}).`
              : `Partner target updated (${before.partnerSource?.displayName ?? ''}).`,
          createdById: userClaims.userId,
          payload: {
            kind: 'partner_target',
            targetId,
            partnerSourceId: before.partnerSource?.id,
            partnerCode: before.partnerSource?.partnerCode,
            event: 'updated',
            changedFields,
          } as Prisma.InputJsonValue,
        },
      });

      // Notify the new owner when ownership changed AND the new
      // owner is not the caller themselves. Best-effort, same
      // privacy contract as create() (generic body, no partner
      // identity in the notification).
      const ownerChanged = dto.ownerUserId !== undefined && dto.ownerUserId !== before.ownerUserId;
      if (
        ownerChanged &&
        this.notifications &&
        updated.ownerUserId !== null &&
        updated.ownerUserId !== userClaims.userId
      ) {
        await this.notifications
          .createInTx(tx, tenantId, {
            recipientUserId: updated.ownerUserId,
            kind: 'lead.partner_target.assigned',
            title: 'Partner target assigned to you',
            body: 'A partner target was assigned to you. Open the lead for the details.',
            severity: 'info',
            actionUrl: `/admin/leads/${leadId}`,
            payload: {
              leadId,
              targetId,
            } as Prisma.InputJsonValue,
          })
          .catch(() => {
            /* swallow */
          });
      }

      return { id: updated.id };
    });
  }
}
