import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { isD3EngineV1Enabled } from './d3-feature-flag';
import { SlaService } from './sla.service';

/**
 * C29 — SLA breach scheduler.
 *
 * Runs once a minute by default (configurable via `SLA_SCHEDULER_CRON`)
 * and calls `SlaService.runReassignmentForBreaches` once per active
 * tenant. The SLA logic itself is unchanged — this class is purely the
 * boring "tick, iterate tenants, log a summary" wrapper that the audit
 * called out as missing in the manual-trigger path.
 *
 * Operational notes:
 *   - Disabled when `SLA_SCHEDULER_ENABLED=false`. Tests, local dev, and
 *     k8s pods that opt out (e.g. read-only replicas) leave it off.
 *   - A process-level mutex prevents two ticks from overlapping when a
 *     sweep is slow (e.g. a tenant with many breaches). The next tick
 *     skips with a warn log; it'll pick up the work the tick after.
 *   - Tenants are read directly from the cross-tenant `tenants`
 *     registry (already non-RLS'd by design); the per-tenant scan
 *     itself runs inside `tenantContext.run` so the breach query and
 *     reassignment use the right tenant scope.
 *   - One tenant's failure does NOT block the rest: we catch and log
 *     per tenant.
 */
@Injectable()
export class SlaSchedulerService {
  private readonly logger = new Logger(SlaSchedulerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sla: SlaService,
  ) {}

  /** Returns true when this process should run the scheduler tick. */
  isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env['SLA_SCHEDULER_ENABLED'];
    if (raw === undefined) return env['NODE_ENV'] === 'production';
    return raw === '1' || raw.toLowerCase() === 'true';
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'sla-breach-scan' })
  async tick(): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.running) {
      this.logger.warn('sla.tick: previous run still in progress; skipping this tick');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      await this.runOnce();
    } finally {
      this.running = false;
      this.logger.log(`sla.tick: completed in ${Date.now() - startedAt}ms`);
    }
  }

  /**
   * Public entry point — exposed so `runReassignmentForBreaches` can be
   * triggered from a test, an admin endpoint, or a one-shot CLI without
   * waiting for the cron tick. Returns the per-tenant summary counts.
   */
  async runOnce(now: Date = new Date()): Promise<{
    tenantsScanned: number;
    breachesProcessed: number;
    /** Phase D3 — D3.2: number of threshold transitions written
     *  across all tenants in this tick. Always 0 when D3_ENGINE_V1
     *  is off — the threshold pass is skipped entirely in that
     *  case so legacy behaviour is byte-identical. */
    thresholdTransitions: number;
    failures: number;
  }> {
    const tenants = await this.prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true, code: true },
    });

    // Phase D3 — D3.2: capture the flag value ONCE per tick so a
    // mid-tick env-var flip can't race the per-tenant loop into a
    // mixed state (some tenants threshold-scanned, others not).
    const d3Enabled = isD3EngineV1Enabled();

    let breachesProcessed = 0;
    let thresholdTransitions = 0;
    let failures = 0;
    for (const tenant of tenants) {
      try {
        await tenantContext.run(
          { tenantId: tenant.id, tenantCode: tenant.code, source: 'system' },
          async () => {
            // 1. Legacy breach scanner — UNCHANGED. Runs every tick
            //    regardless of the D3 flag so existing customers
            //    keep current behaviour byte-for-byte under flag-off.
            const breaches = await this.sla.runReassignmentForBreaches(null, now);
            breachesProcessed += breaches.length;

            // 2. D3.2 threshold pass — gated on `D3_ENGINE_V1`. Runs
            //    AFTER the breach scan so any reassignment-driven
            //    SLA reset is reflected in the threshold result the
            //    same tick (rather than emitting a stale transition
            //    for a row whose SLA window just got bumped).
            if (d3Enabled) {
              const transitions = await this.sla.runThresholdRecomputeForTenant(now);
              thresholdTransitions += transitions.length;
            }
          },
        );
      } catch (err) {
        failures += 1;
        // Don't echo the full error message — keep tenants from
        // leaking diagnostic detail across boundaries.
        this.logger.error(`sla.runOnce: tenant ${tenant.code} failed: ${(err as Error).name}`);
      }
    }
    if (breachesProcessed > 0 || thresholdTransitions > 0 || failures > 0) {
      this.logger.log(
        `sla.runOnce: tenants=${tenants.length} breaches=${breachesProcessed} thresholds=${thresholdTransitions} failures=${failures}`,
      );
    }
    return {
      tenantsScanned: tenants.length,
      breachesProcessed,
      thresholdTransitions,
      failures,
    };
  }
}
