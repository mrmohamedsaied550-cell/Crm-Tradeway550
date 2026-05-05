import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DistributionService } from '../distribution/distribution.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { requireTenantId } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { AssignmentService } from './assignment.service';
import { getSlaMinutes } from './sla.config';
import { SlaThresholdsService, type SlaThreshold } from './sla-thresholds.service';
// Phase D3 — D3.4: RotationService is wired as a constructor dep
// (`@Optional()`) so D3.5 can route SLA-breach reassignment through
// the rotation engine without another service-shape change. D3.4
// itself does NOT change `runReassignmentForBreaches` body — the
// legacy inline path stays the only SLA-breach handler under both
// flag-on and flag-off. Activating the seam is a D3.5 concern.
import { RotationService } from './rotation.service';

/**
 * Phase D3 — D3.2: shape returned by `recomputeThreshold` when the
 * threshold bucket changes. Returns NULL on no-op (paused / closed /
 * already-on-this-bucket).
 */
export interface ThresholdTransition {
  leadId: string;
  from: SlaThreshold;
  to: SlaThreshold;
  ratio: number;
  elapsedMinutes: number;
  budgetMinutes: number;
  slaDueAt: Date;
}

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
    // P3-02 — optional so tests don't need to wire the realtime
    // module to exercise breach reassignment.
    @Optional() private readonly realtime?: RealtimeService,
    /**
     * A5.5 — when injected, breach reassignment runs through the
     * Distribution Engine (with bypassRules=true so we don't send
     * the lead back to the same target the rule already chose).
     * @Optional so legacy test harnesses keep compiling; production
     * always provides it via the @Global DistributionModule. When
     * undefined, breach reassignment falls back to the legacy
     * AssignmentService — same behaviour as pre-cutover.
     */
    @Optional() private readonly distribution?: DistributionService,
    /**
     * Phase D3 — D3.2: pure threshold engine. @Optional so existing
     * test harnesses that hand-construct SlaService without it keep
     * compiling. When undefined, `recomputeThreshold` is a no-op
     * (returns null) — the legacy binary breach path stays the
     * only SLA behaviour. Production wiring (CrmModule) always
     * provides it.
     */
    @Optional() private readonly thresholds?: SlaThresholdsService,
    /**
     * Phase D3 — D3.4: rotation engine. Optional so legacy test
     * harnesses keep compiling. When wired AND D3_ENGINE_V1=true,
     * SLA-breach reassignment routes through `RotationService`
     * (writes a structured `LeadRotationLog` row + the `lead.rotated`
     * audit verb in addition to the legacy `sla_breach` activity).
     * When unwired or flag-off, the existing inline reassignment
     * path runs unchanged.
     */
    @Optional() private readonly rotation?: RotationService,
  ) {}

  /**
   * Phase D3 — D3.4 seam for D3.5: route an SLA-breach reassignment
   * through the rotation engine (when wired AND `D3_ENGINE_V1` is on).
   * Currently UNUSED — `runReassignmentForBreaches` keeps the legacy
   * inline path. D3.5 flips this seam to active by replacing the
   * inline reassignment block in `runReassignmentForBreaches` with
   * a call to this method.
   *
   * The method is intentionally tiny: a thin shim that asserts the
   * dependency is wired and delegates to `RotationService.rotateLead`
   * with `trigger: 'sla_breach'` and `handoverMode: 'full'` (the
   * locked product default for SLA-driven auto-rotations). Returning
   * the rotation outcome lets the caller fold it into its existing
   * per-tenant log line.
   */
  async routeSlaBreachThroughRotation(input: {
    leadId: string;
    actorUserId: string | null;
    reasonCode?: string;
  }) {
    if (!this.rotation) {
      throw new Error('SlaService: RotationService not wired (D3.5 must inject it)');
    }
    return this.rotation.rotateLead({
      leadId: input.leadId,
      trigger: 'sla_breach',
      handoverMode: 'full',
      ...(input.reasonCode !== undefined && { reasonCode: input.reasonCode }),
      actorUserId: input.actorUserId,
    });
  }

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
  // Phase D3 — D3.2: SLA threshold engine
  //
  // Pure read fallback for the per-stage / tenant-wide budget, plus a
  // recompute method the scheduler tick (and future on-demand callers)
  // use to keep `lead.sla_threshold` + `lead.sla_threshold_at` honest.
  //
  // Design choices:
  //   - The pure math lives in SlaThresholdsService (no DB calls).
  //     This file only persists the result + emits an activity row
  //     on transitions.
  //   - When the threshold doesn't change, `recomputeThreshold`
  //     returns null and writes nothing — the scheduler can scan the
  //     entire active fleet every minute without producing churn.
  //   - When it DOES change, we update in a single tx: the lead row
  //     (slaThreshold + slaThresholdAt) AND the LeadActivity. Either
  //     both land or neither does — no audit drift if a partial commit
  //     races a manual stage move.
  //   - This method does NOT trigger rotation, escalation, notifications,
  //     or any side effect beyond the activity row. Those land in
  //     D3.4 / D3.5 behind the same `D3_ENGINE_V1` flag.
  //   - Existing `slaStatus` semantics are preserved bit-for-bit. The
  //     new threshold ladder coexists with the legacy binary breach;
  //     they will be unified in a later D3 chunk once consumers have
  //     migrated.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Resolve the effective SLA minutes for a stage, with tenant fallback.
   *
   *   stage.slaMinutes  ?? tenantSettings.slaMinutes
   *
   * NULL result if neither is configured — caller must treat that as
   * "no SLA budget" (no threshold bucket can be assigned). Returns
   * the budget as a number of minutes.
   *
   * Used by the threshold engine. Future D3 chunks will route the
   * existing `resetForLead` callsites through this helper too so per-
   * stage SLA is honoured at lead-create / stage-move time; D3.2
   * leaves those callsites unchanged on purpose (legacy behaviour
   * preserved for flag-off — see `D3_ENGINE_V1` in `d3-feature-flag.ts`).
   */
  async resolveSlaMinutesForStage(
    tx: Prisma.TransactionClient,
    stageId: string,
  ): Promise<number | null> {
    const tenantId = requireTenantId();
    const stage = await tx.pipelineStage.findUnique({
      where: { id: stageId },
      select: { slaMinutes: true },
    });
    if (stage?.slaMinutes != null) return stage.slaMinutes;
    if (this.tenantSettings) {
      const settings = await this.tenantSettings.getForTenant(tenantId);
      return settings.slaMinutes;
    }
    // Test harnesses without TenantSettingsService fall back to the
    // env-default — same as `getEffectiveSlaMinutes`.
    return getSlaMinutes();
  }

  /**
   * Recompute the SLA threshold bucket for a single lead. No-op (returns
   * null) when:
   *   - The threshold engine isn't wired (`thresholds` undefined).
   *   - The lead is non-'open' (terminal / archived).
   *   - The lead's `slaStatus` is 'paused' or 'breached' — paused has no
   *     timer; breached is handled by the legacy binary path and we
   *     don't want to double-emit transitions on top of it.
   *   - The lead has no `slaDueAt` (paused with cleared due-at).
   *   - The computed bucket equals the lead's current `sla_threshold`.
   *
   * On a real transition: updates `lead.sla_threshold` and
   * `lead.sla_threshold_at` and appends ONE `LeadActivity` row of
   * type `sla_threshold_crossed` carrying `{from, to, ratio,
   * budgetMinutes, elapsedMinutes, slaDueAt}` in its payload. Returns
   * the transition for the caller to fold into batch-summary logs.
   */
  async recomputeThreshold(
    tx: Prisma.TransactionClient,
    leadId: string,
    now: Date = new Date(),
  ): Promise<ThresholdTransition | null> {
    if (!this.thresholds) return null;
    const tenantId = requireTenantId();
    const lead = await tx.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        slaDueAt: true,
        slaStatus: true,
        slaThreshold: true,
        lifecycleState: true,
        stage: { select: { id: true, slaMinutes: true, isTerminal: true } },
      },
    });
    if (!lead) return null;
    if (lead.lifecycleState !== 'open') return null;
    if (lead.stage.isTerminal) return null;
    if (lead.slaStatus !== 'active') return null;
    if (!lead.slaDueAt) return null;

    const budgetMinutes = await this.resolveSlaMinutesForStage(tx, lead.stage.id);
    const result = this.thresholds.computeBucket({
      slaDueAt: lead.slaDueAt,
      budgetMinutes,
      now,
    });
    if (result.noOp) return null;

    const fromBucket = (lead.slaThreshold ?? 'ok') as SlaThreshold;
    const toBucket = result.threshold;
    if (fromBucket === toBucket) return null;

    await tx.lead.update({
      where: { id: leadId },
      data: { slaThreshold: toBucket, slaThresholdAt: now },
    });
    await tx.leadActivity.create({
      data: {
        tenantId,
        leadId,
        type: 'sla_threshold_crossed',
        actionSource: 'system',
        body: `SLA threshold ${fromBucket} → ${toBucket}`,
        payload: {
          event: 'sla_threshold_crossed',
          from: fromBucket,
          to: toBucket,
          ratio: result.ratio,
          budgetMinutes: result.budgetMinutes,
          elapsedMinutes: result.elapsedMinutes,
          slaDueAt: lead.slaDueAt.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    return {
      leadId,
      from: fromBucket,
      to: toBucket,
      ratio: result.ratio,
      elapsedMinutes: result.elapsedMinutes,
      budgetMinutes: result.budgetMinutes,
      slaDueAt: lead.slaDueAt,
    };
  }

  /**
   * Tenant-wide threshold sweep. Iterates every open lead with an
   * active SLA timer in batches (default 200) and recomputes its
   * threshold under a single shared `now`. Returns the list of
   * actual transitions for the scheduler's per-tenant log line.
   *
   * Each lead is recomputed in its own transaction so a single bad
   * row cannot block the rest of the tenant's sweep — same isolation
   * pattern as `runReassignmentForBreaches`.
   *
   * Caller is responsible for the feature-flag check and the tenant
   * context — this method assumes both are already in place.
   */
  async runThresholdRecomputeForTenant(
    now: Date = new Date(),
    options: { batchSize?: number } = {},
  ): Promise<ThresholdTransition[]> {
    if (!this.thresholds) return [];
    const tenantId = requireTenantId();
    const batchSize = options.batchSize ?? 200;

    // Hot-path query backed by the `(tenant, sla_threshold, sla_due_at)`
    // index added in D3.1. We deliberately skip 't200' rows — once a
    // lead has crossed the highest threshold there's nothing more for
    // this engine to do until the lead transitions out of 'open' (at
    // which point the lifecycle filter would skip it anyway).
    const candidates = await this.prisma.withTenant(tenantId, (tx) =>
      tx.lead.findMany({
        where: {
          slaStatus: 'active',
          slaDueAt: { not: null, lte: now },
          lifecycleState: 'open',
          stage: { isTerminal: false },
          slaThreshold: { in: ['ok', 't75', 't100', 't150'] },
        },
        select: { id: true },
        take: batchSize * 50, // hard cap so a runaway tenant can't starve siblings
        orderBy: { slaDueAt: 'asc' },
      }),
    );

    const transitions: ThresholdTransition[] = [];
    for (const cand of candidates) {
      try {
        const t = await this.prisma.withTenant(tenantId, (tx) =>
          this.recomputeThreshold(tx, cand.id, now),
        );
        if (t) transitions.push(t);
      } catch (err) {
        // Per-row failure shouldn't kill the sweep. Log and continue.
        this.logger.warn(`sla.recomputeThreshold ${cand.id} failed: ${(err as Error).name}`);
      }
    }
    if (transitions.length > 0) {
      this.logger.log(`sla.thresholds: ${transitions.length} transition(s) for tenant ${tenantId}`);
    }
    return transitions;
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

        // A5.5 — breach reassignment runs through DistributionService
        // (with bypassRules=true so we don't route back to the same
        // target the original rule already chose). The decision +
        // its routing-log row land in the same tx as the lead update,
        // so a partial commit is impossible.
        //
        // Falls back to the legacy AssignmentService when
        // DistributionService is unavailable — keeps existing test
        // harnesses that don't wire it green.
        let pickedId: string | null;
        if (this.distribution) {
          const decision = await this.distribution.route(
            {
              tenantId,
              leadId: fresh.id,
              source: null, // breach reassignment ignores source
              companyId: null,
              countryId: null,
              currentAssigneeId: fromUserId,
              bypassRules: true,
            },
            tx,
          );
          pickedId = decision.chosenUserId;
          if (pickedId) {
            // Apply the decision: lead.assignedToId update +
            // sla_breach activity row + last_assigned_at bump (drives
            // the round_robin clock if that's the tenant default).
            await tx.lead.update({
              where: { id: fresh.id },
              data: { assignedToId: pickedId },
            });
            await tx.leadActivity.create({
              data: {
                tenantId,
                leadId: fresh.id,
                type: 'sla_breach',
                body: `Auto-reassigned after SLA breach`,
                payload: {
                  event: 'sla_reassignment',
                  fromUserId,
                  toUserId: pickedId,
                  strategy: decision.strategy,
                  ruleId: decision.ruleId,
                  dueAt: fresh.slaDueAt.toISOString(),
                } as Prisma.InputJsonValue,
                createdById: actorUserId,
              },
            });
            await tx.user.update({
              where: { id: pickedId },
              data: { lastAssignedAt: new Date() },
            });
          }
        } else {
          // Legacy fallback path — same as pre-A5.5 behaviour. Tests
          // that don't wire DistributionService take this branch.
          pickedId = await this.assignment.assignLeadViaRoundRobin({
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
        }

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

      if (result) {
        results.push(result);
        // P3-02 — fire a `lead.assigned` event for successful breach
        // reassignments so the new owner's workspace lights up the
        // lead immediately. Notifications already emit a separate
        // `notification.created` for the bell — this one is for the
        // leads list itself. Skipped on no_eligible_agent /
        // unassigned_breached because nothing changed for any user.
        if (this.realtime && result.outcome === 'reassigned' && result.toUserId) {
          try {
            this.realtime.emitToUser(tenantId, result.toUserId, {
              type: 'lead.assigned',
              leadId: result.leadId,
              toUserId: result.toUserId,
              fromUserId: result.fromUserId,
              reason: 'sla_breach',
            });
          } catch {
            /* swallowed — best-effort push */
          }
        }
      }
    }

    if (results.length > 0) {
      this.logger.log(`SLA scan: ${results.length} breach(es) processed`);
    }
    return results;
  }
}
