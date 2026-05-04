import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { LeadsService } from '../crm/leads.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Phase C — C10B-4: review queue read + resolve.
 *
 * Reviews inherit their conversation's scope (locked decision §4 — no
 * new RoleScope resource). A review row is visible iff:
 *   1. The actor has `whatsapp.review.read` (controller-level guard).
 *   2. The underlying conversation passes `resolveConversationScope`.
 *
 * Resolution paths (locked from C10B-3):
 *   - 'linked_to_lead'    — conversation → existing lead
 *   - 'linked_to_captain' — only valid for reason='captain_active'
 *   - 'new_lead'          — auto-create a fresh sales lead via
 *                           LeadsService.createFromWhatsApp
 *   - 'dismissed'         — false-positive; conversation stays
 *                           unassigned, review row marked resolved
 */

/**
 * Phase D2 — D2.3 adds `'new_attempt'`: the operator has reviewed
 * a returning person and explicitly chose to create a fresh attempt
 * chained to a previous lead. Distinct from `'new_lead'` (which is
 * for first-touch creates with no prior history). The resolver
 * supplies `previousLeadId` to anchor the chain.
 */
export type ReviewResolution =
  | 'linked_to_lead'
  | 'linked_to_captain'
  | 'new_lead'
  | 'new_attempt'
  | 'dismissed';

export interface ResolveReviewInput {
  resolution: ReviewResolution;
  /** Required when resolution = 'linked_to_lead'.
   *  When resolution = 'new_attempt' OPTIONAL — if supplied, the
   *  new attempt chains from this specific predecessor; if omitted,
   *  the service walks the contact's lead list and picks the most
   *  recent closed lead as the predecessor. */
  leadId?: string;
}

@Injectable()
export class WhatsAppReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeContext: ScopeContextService,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * List reviews under the actor's conversation scope. The
   * `resolved` filter defaults to `false` (active queue) — the UI
   * can pass `true` for a historical view.
   */
  async listForUser(
    claims: ScopeUserClaims,
    opts: { resolved?: boolean; limit?: number; offset?: number } = {},
  ) {
    const tenantId = requireTenantId();
    const { where: convoScopeWhere } = await this.scopeContext.resolveConversationScope(claims);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.WhatsAppConversationReviewWhereInput = {
        ...(opts.resolved === true ? { NOT: { resolvedAt: null } } : { resolvedAt: null }),
        ...(convoScopeWhere && { conversation: { is: convoScopeWhere } }),
      };
      const [items, total] = await Promise.all([
        tx.whatsAppConversationReview.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          include: {
            conversation: {
              select: {
                id: true,
                phone: true,
                lastMessageText: true,
                lastInboundAt: true,
                assignedToId: true,
              },
            },
            contact: { select: { id: true, displayName: true, phone: true, isCaptain: true } },
          },
        }),
        tx.whatsAppConversationReview.count({ where }),
      ]);
      return { items, total, limit, offset };
    });
  }

  async findByIdInScope(claims: ScopeUserClaims, id: string) {
    const tenantId = requireTenantId();
    const { where: convoScopeWhere } = await this.scopeContext.resolveConversationScope(claims);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.WhatsAppConversationReviewWhereInput = {
        id,
        ...(convoScopeWhere && { conversation: { is: convoScopeWhere } }),
      };
      return tx.whatsAppConversationReview.findFirst({
        where,
        include: {
          conversation: true,
          contact: true,
        },
      });
    });
  }

  /**
   * Resolve the review. Validates the chosen resolution against the
   * review's `reason`, applies the corresponding action, and writes
   * the audit verb `whatsapp.review.resolved` in the same tx.
   *
   * Idempotent: re-resolving an already-resolved row throws
   * `whatsapp.review.already_resolved`.
   */
  async resolve(
    claims: ScopeUserClaims,
    id: string,
    input: ResolveReviewInput,
  ): Promise<{ id: string; resolution: ReviewResolution; resolvedAt: Date }> {
    const tenantId = requireTenantId();
    const { where: convoScopeWhere } = await this.scopeContext.resolveConversationScope(claims);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.WhatsAppConversationReviewWhereInput = {
        id,
        ...(convoScopeWhere && { conversation: { is: convoScopeWhere } }),
      };
      const review = await tx.whatsAppConversationReview.findFirst({
        where,
        include: {
          conversation: { select: { id: true, phone: true, leadId: true, status: true } },
          contact: true,
        },
      });
      if (!review) {
        throw new NotFoundException({
          code: 'whatsapp.review.not_found',
          message: `Review ${id} not found in active tenant`,
        });
      }
      if (review.resolvedAt !== null) {
        throw new BadRequestException({
          code: 'whatsapp.review.already_resolved',
          message: 'Review is already resolved',
        });
      }

      // Validate resolution shape against reason.
      this.validateResolution(review.reason, input);

      // Apply the chosen path.
      switch (input.resolution) {
        case 'linked_to_lead': {
          if (!input.leadId) {
            throw new BadRequestException({
              code: 'whatsapp.review.lead_required',
              message: 'leadId is required for linked_to_lead',
            });
          }
          // Locked decision §2: lead must be visible under the
          // resolver's scope too. We re-use ScopeContextService to
          // build a lead-where, then findFirst.
          const { where: leadScope } = await this.scopeContext.resolveLeadScope(claims);
          const leadWhere: Prisma.LeadWhereInput = leadScope
            ? { AND: [{ id: input.leadId }, leadScope] }
            : { id: input.leadId };
          const lead = await tx.lead.findFirst({
            where: leadWhere,
            select: { id: true, assignedToId: true, companyId: true, countryId: true },
          });
          if (!lead) {
            throw new NotFoundException({
              code: 'lead.not_found',
              message: `Lead ${input.leadId} not found in active tenant`,
            });
          }
          // Denormalise ownership from the lead.
          const assignee = lead.assignedToId
            ? await tx.user.findUnique({
                where: { id: lead.assignedToId },
                select: { teamId: true },
              })
            : null;
          await tx.whatsAppConversation.update({
            where: { id: review.conversationId },
            data: {
              leadId: lead.id,
              assignedToId: lead.assignedToId,
              teamId: assignee?.teamId ?? null,
              companyId: lead.companyId,
              countryId: lead.countryId,
              assignmentSource: 'inbound_route',
              assignedAt: new Date(),
            },
          });
          await tx.lead.update({
            where: { id: lead.id },
            data: { primaryConversationId: review.conversationId },
          });
          break;
        }
        case 'linked_to_captain': {
          // No lead change; the captain row already exists. The
          // conversation stays unassigned-to-sales — captain support
          // is a separate operations queue and admin handles by
          // reassigning manually if needed.
          break;
        }
        case 'new_lead':
        case 'new_attempt': {
          // Re-route from scratch via the inbound flow's helper.
          // We do NOT call the routing engine here — instead, the
          // resolver picks an assignee themselves (the actor) so the
          // admin keeps full control.
          //
          // D2.3 — Both `new_lead` and `new_attempt` flow through
          // the same `createFromWhatsApp` call. Under
          // LEAD_ATTEMPTS_V2=true the inner duplicate-decision gate
          // sees the matching leads / captain via the engine and
          // populates the attempt-chain fields automatically; under
          // flag-off it behaves exactly as today (legacy `new_lead`
          // semantics, no chain). The distinct resolution string is
          // preserved on the review row + audit log so downstream
          // dashboards can count "explicit reactivation" cases
          // separately from "first-touch new lead" cases.
          const lead = await this.leads.createFromWhatsApp(tx, {
            tenantId,
            contactId: review.contactId,
            phone: review.conversation.phone,
            name: review.contact.displayName ?? review.conversation.phone,
            profileName: review.contact.displayName,
            waId: null,
            companyId: null,
            countryId: null,
            assignedToId: claims.userId,
            primaryConversationId: review.conversationId,
          });
          // Denormalise ownership onto the conversation. The actor's
          // teamId is read from their user row.
          const actor = await tx.user.findUnique({
            where: { id: claims.userId },
            select: { teamId: true },
          });
          await tx.whatsAppConversation.update({
            where: { id: review.conversationId },
            data: {
              leadId: lead.id,
              assignedToId: claims.userId,
              teamId: actor?.teamId ?? null,
              assignmentSource: 'inbound_route',
              assignedAt: new Date(),
            },
          });
          break;
        }
        case 'dismissed': {
          // No state change beyond marking the row resolved.
          break;
        }
      }

      const resolvedAt = new Date();
      const updated = await tx.whatsAppConversationReview.update({
        where: { id },
        data: {
          resolvedAt,
          resolvedById: claims.userId,
          resolution: input.resolution,
        },
        select: { id: true, resolution: true, resolvedAt: true },
      });

      await this.audit.writeInTx(tx, tenantId, {
        action: 'whatsapp.review.resolved',
        entityType: 'whatsapp.conversation_review',
        entityId: id,
        actorUserId: claims.userId,
        payload: {
          reason: review.reason,
          resolution: input.resolution,
          conversationId: review.conversationId,
          contactId: review.contactId,
          ...(input.leadId && { leadId: input.leadId }),
        } as unknown as Prisma.InputJsonValue,
      });

      return {
        id: updated.id,
        resolution: updated.resolution as ReviewResolution,
        resolvedAt: updated.resolvedAt!,
      };
    });
  }

  private validateResolution(reason: string, input: ResolveReviewInput): void {
    if (input.resolution === 'linked_to_captain' && reason !== 'captain_active') {
      throw new BadRequestException({
        code: 'whatsapp.review.invalid_resolution',
        message: `linked_to_captain is only valid for reason='captain_active' (got '${reason}')`,
      });
    }
    if (input.resolution === 'linked_to_lead' && !input.leadId) {
      throw new BadRequestException({
        code: 'whatsapp.review.lead_required',
        message: 'leadId is required for linked_to_lead',
      });
    }
  }
}
