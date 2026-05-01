import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { AssignmentService } from './assignment.service';
import { getSlaMinutes } from './sla.config';

export type SlaStatus = 'active' | 'breached' | 'paused';

export interface BreachReassignmentResult {
  leadId: string;
  /**
   * `reassigned` — round-robin found a different eligible agent and the
   * lead was updated.
   * `no_eligible_agent` — the picker returned null (e.g. only one agent
   * in the tenant and it was excluded). Lead is marked breached but
   * remains with the original assignee until a human intervenes.
   * `unassigned_breached` — the lead had no assignee at all; we just
   * mark the breach so dashboards can pick it up.
   */
  outcome: 'reassigned' | 'no_eligible_agent' | 'unassigned_breached';
  fromUserId: string | null;
  toUserId: string | null;
}

/**
 * Response-SLA timer + breach scanner.
 *
 * The SLA "clock" lives in three columns on `leads`:
 *   - sla_due_at      timestamp; null while paused
 *   - sla_status      'active' | 'breached' | 'paused'
 *   - last_response_at  timestamp of last agent-driven activity
 *
 * Reset rules are concentrated here so LeadsService + CaptainsService
 * call into a single shaped helper. Breach scanning runs on demand via
 * /sla/run-breaches; cron is out of scope for C11.
 */
@Injectable()
export class SlaService {
  private readonly logger = new Logger(SlaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: AssignmentService,
    private readonly notifications?: NotificationsService,
    // Optional so the existing hand-instantiated test harnesses
    // (assignment.test.ts, sla.test.ts, ...) keep compiling without
    // also wiring TenantSettingsService. Production wiring always
    // supplies it via the global TenantsModule.
    @Optional() private readonly tenantSettings?: TenantSettingsService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // helpers used by LeadsService / CaptainsService inside their own tx
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Compute when the SLA expires for a freshly-touched lead.
   *
   * Stays synchronous so the existing inline-in-data callsites
   * (`tx.lead.update({ data: { slaDueAt: this.sla.computeDueAt(...) } })`)
   * don't have to be re-written as awaits. When `slaMinutes` is
   * omitted we fall back to the env-var (`LEAD_SLA_MINUTES`); P2-08
   * tenant-aware callers fetch the value once via
   * `getEffectiveSlaMinutes(tenantId)` and pass it down.
   */
  computeDueAt(now: Date = new Date(), slaMinutes?: number): Date {
    const minutes = slaMinutes ?? getSlaMinutes();
    return new Date(now.getTime() + minutes * 60 * 1000);
  }

  /**
   * Resolve the SLA window length for a tenant: settings row when
   * present, env-var fallback when not. Async because the read
   * can hit the DB on first call. Keep this off any hot loop —
   * callers fetch once at the top of a request and reuse.
   */
  async getEffectiveSlaMinutes(tenantId: string): Promise<number> {
    if (!this.tenantSettings) return getSlaMinutes();
    const settings = await this.tenantSettings.getForTenant(tenantId);
    return settings.slaMinutes;
  }

  /**
   * Set sla_due_at = now + window, sla_status = 'active'. Optionally also
   * stamps `last_response_at` (callers pass `markResponse: true` only for
   * agent-driven activity types — see SLA_RESETTING_ACTIVITY_TYPES).
   *
   * P2-08: pass `slaMinutes` to override the env-var fallback with the
   * tenant-configured value. Callers that don't have it readily
   * available can omit and accept the env default.
   */
  async resetForLead(
    tx: Prisma.TransactionClient,
    leadId: string,
    opts: { markResponse?: boolean; now?: Date; slaMinutes?: number } = {},
  ): Promise<void> {
    const now = opts.now ?? new Date();
    await tx.lead.update({
      where: { id: leadId },
      data: {
        slaDueAt: this.computeDueAt(now, opts.slaMinutes),
        slaStatus: 'active',
        ...(opts.markResponse && { lastResponseAt: now }),
      },
    });
  }

  /**
   * Pause the SLA (terminal stages: converted / lost). Clears sla_due_at
   * so the breach scanner ignores the row.
   */
  async pauseForLead(tx: Prisma.TransactionClient, leadId: string): Promise<void> {
    await tx.lead.update({
      where: { id: leadId },
      data: { slaDueAt: null, slaStatus: 'paused' },
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // breach detection + reassignment
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Returns leads currently past their SLA. Filtered by RLS to the active
   * tenant. Excludes terminal-stage leads and already-paused rows.
   */
  async findBreachedLeads(
    now: Date = new Date(),
  ): Promise<Array<{ id: string; assignedToId: string | null; slaDueAt: Date | null }>> {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.lead.findMany({
        where: {
          slaStatus: 'active',
          slaDueAt: { lte: now },
          stage: { isTerminal: false },
        },
        select: { id: true, assignedToId: true, slaDueAt: true },
        orderBy: { slaDueAt: 'asc' },
      }),
    );
  }

  /**
   * Scan all currently-breached leads and try to reassign each via
   * round-robin (excluding the prior assignee). Idempotent — leads
   * already in `breached` status without an eligible reassignee stay
   * marked breached but are not re-touched, so re-running is cheap.
   *
   * Each lead is processed in its own short transaction so a single
   * failing reassignment cannot block the rest of the batch.
   */
  async runReassignmentForBreaches(
    actorUserId: string | null = null,
    now: Date = new Date(),
  ): Promise<BreachReassignmentResult[]> {
    const tenantId = requireTenantId();
    // Resolve the tenant's SLA window once for this run so the
    // "fresh SLA window for the new owner" computation below uses
    // the configured value instead of the env-var fallback.
    const slaMinutes = await this.getEffectiveSlaMinutes(tenantId);
    const breaches = await this.findBreachedLeads(now);
    const results: BreachReassignmentResult[] = [];

    for (const breach of breaches) {
      const result = await this.prisma.withTenant(tenantId, async (tx) => {
        // Re-read inside the transaction to avoid double-processing if
        // another worker has already touched this lead.
        const fresh = await tx.lead.findUnique({
          where: { id: breach.id },
          select: {
            id: true,
            assignedToId: true,
            slaStatus: true,
            slaDueAt: true,
            stage: { select: { isTerminal: true } },
          },
        });
        if (!fresh) {
          return null; // lead deleted in flight
        }
        if (fresh.stage.isTerminal || fresh.slaStatus !== 'active') {
          return null; // already resolved / paused
        }
        if (!fresh.slaDueAt || fresh.slaDueAt.getTime() > now.getTime()) {
          return null; // someone reset SLA between scan and this iteration
        }

        const fromUserId = fresh.assignedToId;
        const overdueByMs = now.getTime() - fresh.slaDueAt.getTime();

        // Always emit the breach activity first so the timeline shows the
        // event even if no reassignment happens.
        await tx.leadActivity.create({
          data: {
            tenantId,
            leadId: fresh.id,
            type: 'sla_breach',
            body: `SLA breached (${Math.round(overdueByMs / 60000)} min overdue)`,
            payload: {
              event: 'sla_breach',
              dueAt: fresh.slaDueAt.toISOString(),
              detectedAt: now.toISOString(),
              priorAssigneeId: fromUserId,
            } as Prisma.InputJsonValue,
            createdById: actorUserId,
          },
        });

        // Mark the lead breached up-front; if reassignment succeeds we
        // reset to 'active' below.
        await tx.lead.update({
          where: { id: fresh.id },
          data: { slaStatus: 'breached' },
        });

        if (fromUserId === null) {
          // Nothing to reassign away from; leave breached for human review.
          return {
            leadId: fresh.id,
            outcome: 'unassigned_breached' as const,
            fromUserId: null,
            toUserId: null,
          };
        }

        const pickedId = await this.assignment.assignLeadViaRoundRobin({
          tx,
          leadId: fresh.id,
          tenantId,
          excludeUserIds: [fromUserId],
          activityType: 'sla_breach',
          actorUserId,
          body: `Auto-reassigned after SLA breach`,
          payload: {
            event: 'sla_reassignment',
            fromUserId,
            dueAt: fresh.slaDueAt.toISOString(),
          },
        });

        if (pickedId) {
          // Successful reassignment — fresh SLA window for the new owner.
          await tx.lead.update({
            where: { id: fresh.id },
            data: {
              slaStatus: 'active',
              slaDueAt: this.computeDueAt(now, slaMinutes),
            },
          });
          // P2-02 — bell the new owner so they pick it up immediately,
          // and the prior owner so they know they lost it.
          if (this.notifications) {
            await this.notifications.createInTx(tx, tenantId, {
              recipientUserId: pickedId,
              kind: 'sla.breach',
              title: 'Lead reassigned to you (SLA breach)',
              body: `You picked up a breached lead from another agent.`,
              payload: { leadId: fresh.id, fromUserId, mode: 'reassigned' },
            });
            await this.notifications.createInTx(tx, tenantId, {
              recipientUserId: fromUserId,
              kind: 'sla.breach',
              title: 'Your lead was reassigned (SLA breach)',
              body: `It was past its response window.`,
              payload: { leadId: fresh.id, toUserId: pickedId, mode: 'reassigned' },
            });
          }
          return {
            leadId: fresh.id,
            outcome: 'reassigned' as const,
            fromUserId,
            toUserId: pickedId,
          };
        }

        // No eligible reassignee — bell the existing owner so they
        // see they're now responsible for an overdue lead.
        if (this.notifications) {
          await this.notifications.createInTx(tx, tenantId, {
            recipientUserId: fromUserId,
            kind: 'sla.breach',
            title: 'Your lead breached SLA',
            body: `No reassignee available — please respond.`,
            payload: { leadId: fresh.id, mode: 'no_eligible_agent' },
          });
        }
        return {
          leadId: fresh.id,
          outcome: 'no_eligible_agent' as const,
          fromUserId,
          toUserId: null,
        };
      });

      if (result) results.push(result);
    }

    if (results.length > 0) {
      this.logger.log(`SLA scan: ${results.length} breach(es) processed`);
    }
    return results;
  }
}
