import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Phase C — C10B-2: backfill `Contact` rows from existing
 * `WhatsAppConversation` rows and denormalise the ownership chain
 * onto every linked conversation.
 *
 * The service is the testable core; `apps/api/scripts/c10b-backfill.ts`
 * is the CLI wrapper that operations runs once at deploy time.
 *
 * Per-tenant orchestration: walks tenants outside any tenant context
 * (the `tenants` table is not RLS-protected), and inside each tenant
 * runs a single transaction with `SET LOCAL app.tenant_id = ...` so
 * RLS policies still hold for every row touched. This mirrors the
 * P2-05 token-encryption script.
 *
 * Idempotence rules:
 *   • Contact: get-or-create keyed on (tenantId, phone). Re-runs
 *     only refresh `lastSeenAt` and the denormalised flags
 *     (`isCaptain`, `hasOpenLead`); they never overwrite a
 *     `displayName` an agent has already cleaned up.
 *   • Conversation.contactId: written only when the column is NULL.
 *     A subsequent inbound-flow run (C10B-3) keeps the same
 *     contact_id because Contact lookups are deterministic per phone.
 *   • Conversation ownership (assignedToId / teamId / companyId /
 *     countryId / assignmentSource / assignedAt): written only when
 *     `assignmentSource IS NULL`. Once the inbound router or a
 *     manual handover writes a real source the backfill stops
 *     touching the row.
 *
 * Unlinked conversations (leadId IS NULL) keep `assignedToId = NULL`
 * — no auto-route here. They are counted and reported so C10B-3 can
 * push them through the routing engine and (when appropriate) into
 * the review queue.
 */

export interface TenantBackfillReport {
  tenantId: string;
  conversationsScanned: number;
  contactsCreated: number;
  contactsUpdated: number;
  conversationsLinkedToContact: number;
  conversationsOwnershipDenormalised: number;
  conversationsUnlinked: number;
  conversationsAlreadyOwned: number;
}

export interface BackfillReport {
  tenantsScanned: number;
  perTenant: TenantBackfillReport[];
  totalContactsCreated: number;
  totalContactsUpdated: number;
  totalConversationsScanned: number;
  totalConversationsLinkedToContact: number;
  totalConversationsOwnershipDenormalised: number;
  totalConversationsUnlinked: number;
  totalConversationsAlreadyOwned: number;
}

const BATCH_SIZE = 500;

@Injectable()
export class WhatsAppBackfillService {
  /**
   * Walk every active tenant and backfill. The CLI wrapper passes a
   * fresh `PrismaClient` so it owns the lifecycle (connect /
   * disconnect); tests can inject a service-level client too.
   */
  async backfillAll(prisma: PrismaClient): Promise<BackfillReport> {
    const tenants = await prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    const perTenant: TenantBackfillReport[] = [];
    for (const t of tenants) {
      const report = await this.backfillTenant(prisma, t.id);
      perTenant.push(report);
    }

    return {
      tenantsScanned: perTenant.length,
      perTenant,
      totalContactsCreated: sum(perTenant, (r) => r.contactsCreated),
      totalContactsUpdated: sum(perTenant, (r) => r.contactsUpdated),
      totalConversationsScanned: sum(perTenant, (r) => r.conversationsScanned),
      totalConversationsLinkedToContact: sum(perTenant, (r) => r.conversationsLinkedToContact),
      totalConversationsOwnershipDenormalised: sum(
        perTenant,
        (r) => r.conversationsOwnershipDenormalised,
      ),
      totalConversationsUnlinked: sum(perTenant, (r) => r.conversationsUnlinked),
      totalConversationsAlreadyOwned: sum(perTenant, (r) => r.conversationsAlreadyOwned),
    };
  }

  /**
   * Single-tenant backfill. Runs in one transaction per tenant so
   * the GUC `app.tenant_id` is set exactly once and every read /
   * write inside the transaction is RLS-isolated.
   */
  async backfillTenant(prisma: PrismaClient, tenantId: string): Promise<TenantBackfillReport> {
    const report: TenantBackfillReport = {
      tenantId,
      conversationsScanned: 0,
      contactsCreated: 0,
      contactsUpdated: 0,
      conversationsLinkedToContact: 0,
      conversationsOwnershipDenormalised: 0,
      conversationsUnlinked: 0,
      conversationsAlreadyOwned: 0,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);

      // 1. Pass-1 — collect per-phone aggregate stats so each Contact
      //    gets accurate firstSeenAt / lastSeenAt without N+1 queries.
      //    We also need the captain / open-lead denormalised flags.
      //    The aggregate is small (one row per distinct phone in the
      //    tenant), so we can hold it in memory.
      const aggregates = await this.computePhoneAggregates(tx, tenantId);

      // 2. Pass-2 — upsert one Contact per distinct phone + capture
      //    the resulting id-by-phone map for the conversation step.
      const contactByPhone = new Map<string, string>();
      for (const [phone, agg] of aggregates) {
        const existing = await tx.contact.findUnique({
          where: { tenantId_phone: { tenantId, phone } },
          select: { id: true },
        });
        if (existing) {
          // Re-run: refresh denormalised flags + lastSeenAt only.
          // Never touch displayName / language / originalDisplayName
          // because an agent may have curated them.
          await tx.contact.update({
            where: { id: existing.id },
            data: {
              isCaptain: agg.isCaptain,
              hasOpenLead: agg.hasOpenLead,
              lastSeenAt: agg.lastSeenAt,
            },
          });
          contactByPhone.set(phone, existing.id);
          report.contactsUpdated += 1;
        } else {
          const created = await tx.contact.create({
            data: {
              tenantId,
              phone,
              originalPhone: phone,
              displayName: null,
              originalDisplayName: null,
              language: null,
              firstSeenAt: agg.firstSeenAt,
              lastSeenAt: agg.lastSeenAt,
              isCaptain: agg.isCaptain,
              hasOpenLead: agg.hasOpenLead,
            },
            select: { id: true },
          });
          contactByPhone.set(phone, created.id);
          report.contactsCreated += 1;
        }
      }

      // 3. Pass-3 — for every conversation: set contactId (if NULL)
      //    and denormalise ownership from the linked lead (when both
      //    assignmentSource IS NULL and leadId IS NOT NULL).
      let cursorId: string | undefined;
      for (;;) {
        const batch = (await tx.whatsAppConversation.findMany({
          where: cursorId ? { id: { gt: cursorId } } : {},
          orderBy: { id: 'asc' },
          take: BATCH_SIZE,
          select: {
            id: true,
            phone: true,
            contactId: true,
            assignmentSource: true,
            leadId: true,
            lead: {
              select: {
                assignedToId: true,
                companyId: true,
                countryId: true,
                assignedTo: { select: { teamId: true } },
              },
            },
          },
        })) as Array<{
          id: string;
          phone: string;
          contactId: string | null;
          assignmentSource: string | null;
          leadId: string | null;
          lead: {
            assignedToId: string | null;
            companyId: string | null;
            countryId: string | null;
            assignedTo: { teamId: string | null } | null;
          } | null;
        }>;
        if (batch.length === 0) break;

        for (const conv of batch) {
          report.conversationsScanned += 1;

          const data: Prisma.WhatsAppConversationUncheckedUpdateInput = {};

          // contactId — only set when missing (idempotent re-run).
          if (conv.contactId === null) {
            const contactId = contactByPhone.get(conv.phone);
            if (contactId) {
              data.contactId = contactId;
              report.conversationsLinkedToContact += 1;
            }
          }

          // Ownership denormalisation — only when assignmentSource IS
          // NULL (never overwrite a real assignment).
          if (conv.assignmentSource === null) {
            if (conv.leadId !== null && conv.lead !== null) {
              data.assignedToId = conv.lead.assignedToId;
              data.teamId = conv.lead.assignedTo?.teamId ?? null;
              data.companyId = conv.lead.companyId;
              data.countryId = conv.lead.countryId;
              data.assignmentSource = 'migrated';
              data.assignedAt = new Date();
              report.conversationsOwnershipDenormalised += 1;
            } else {
              // Unlinked. Keep assignedToId NULL — C10B-3 routes
              // these on the next inbound message and (when nobody
              // can be picked) writes a review row with
              // reason='unmatched_after_routing'. We just count for
              // operational visibility.
              report.conversationsUnlinked += 1;
            }
          } else {
            report.conversationsAlreadyOwned += 1;
          }

          if (Object.keys(data).length > 0) {
            await tx.whatsAppConversation.update({
              where: { id: conv.id },
              data,
            });
          }
        }
        cursorId = batch[batch.length - 1]?.id;
      }
    });

    return report;
  }

  /**
   * Build a per-phone aggregate inside the active tenant: earliest +
   * latest activity timestamps + captain / open-lead flags. Using
   * tenant-scoped queries (the tenant GUC is already set by the
   * caller) so RLS keeps the scan correctly isolated.
   *
   * Memory cost = O(distinct phones in tenant). MVP tenants have
   * tens of thousands of conversations at most, all unique-by-phone
   * collapses to a smaller set; safe to hold in memory for the
   * one-shot backfill.
   */
  private async computePhoneAggregates(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    _tenantId: string,
  ): Promise<
    Map<
      string,
      {
        firstSeenAt: Date;
        lastSeenAt: Date;
        isCaptain: boolean;
        hasOpenLead: boolean;
      }
    >
  > {
    const aggregates = new Map<
      string,
      { firstSeenAt: Date; lastSeenAt: Date; isCaptain: boolean; hasOpenLead: boolean }
    >();

    // Conversation-driven phones — every conversation feeds firstSeenAt /
    // lastSeenAt. We scan in batches to keep memory bounded even on
    // tenants with many conversations.
    let cursorId: string | undefined;
    for (;;) {
      const batch = (await tx.whatsAppConversation.findMany({
        where: cursorId ? { id: { gt: cursorId } } : {},
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        select: { id: true, phone: true, createdAt: true, lastMessageAt: true },
      })) as Array<{ id: string; phone: string; createdAt: Date; lastMessageAt: Date }>;
      if (batch.length === 0) break;
      for (const c of batch) {
        const existing = aggregates.get(c.phone);
        if (existing) {
          if (c.createdAt < existing.firstSeenAt) existing.firstSeenAt = c.createdAt;
          if (c.lastMessageAt > existing.lastSeenAt) existing.lastSeenAt = c.lastMessageAt;
        } else {
          aggregates.set(c.phone, {
            firstSeenAt: c.createdAt,
            lastSeenAt: c.lastMessageAt,
            isCaptain: false,
            hasOpenLead: false,
          });
        }
      }
      cursorId = batch[batch.length - 1]?.id;
    }

    if (aggregates.size === 0) return aggregates;

    const phones = Array.from(aggregates.keys());

    // Lookup leads matching these phones; one phone in {phones} is
    // enough — Lead has @@unique([tenantId, phone]) so there is at
    // most one row per phone, but we ask for `id`+`phone`+lifecycle
    // so the captain join + open-lead flag computation is a single
    // pass.
    const leads = await tx.lead.findMany({
      where: { phone: { in: phones } },
      select: {
        id: true,
        phone: true,
        lifecycleState: true,
        captain: { select: { id: true, status: true } },
      },
    });

    for (const l of leads) {
      const agg = aggregates.get(l.phone);
      if (!agg) continue;
      if (l.lifecycleState === 'open') agg.hasOpenLead = true;
      // Captain is "active" when its `status` column is 'active'.
      // A captain row that's been archived stops counting toward
      // isCaptain so a re-acquired phone doesn't get permanently
      // routed to the review queue.
      if (l.captain && l.captain.status === 'active') {
        agg.isCaptain = true;
      }
    }

    return aggregates;
  }
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0);
}
