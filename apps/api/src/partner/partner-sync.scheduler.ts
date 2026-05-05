import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { isD4PartnerHubV1Enabled } from './d4-feature-flag';
import { PartnerSyncService } from './partner-sync.service';

/**
 * Phase D4 — D4.3: PartnerSyncSchedulerService.
 *
 * Runs once per minute. Per minute, the scheduler:
 *   1. Resolves the D4 flag once. Off → no-op (fully dormant in
 *      production until explicitly opted in).
 *   2. Lists every active partner source in every tenant whose
 *      `scheduleKind = 'cron'`.
 *   3. For each source, decides whether the configured `cronSpec`
 *      is due in the current minute via the `cron` package's
 *      `CronTime` helper (transitive dep of `@nestjs/schedule`).
 *   4. Triggers `PartnerSyncService.runSync(sourceId,
 *      { trigger: 'cron' })` inside the source's
 *      `tenantContext.run`.
 *
 * Mirrors `SlaSchedulerService` for failure-isolation and overlap
 * protection: a process-level `running` mutex prevents two ticks
 * from interleaving; per-source try/catch keeps one tenant's
 * failure from stopping the rest.
 *
 * The actual sync engine has its own concurrency guard
 * (`partner.sync.already_running`) so even a doubled tick can't
 * trigger two simultaneous runs against the same source.
 */
@Injectable()
export class PartnerSyncSchedulerService {
  private readonly logger = new Logger(PartnerSyncSchedulerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: PartnerSyncService,
  ) {}

  /**
   * Returns true when this process should run the scheduler tick.
   * Mirrors SlaSchedulerService — opt-in via env var; default off
   * outside production so tests / dev workers don't accidentally
   * fire syncs.
   */
  isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env['PARTNER_SYNC_SCHEDULER_ENABLED'];
    if (raw === undefined) return env['NODE_ENV'] === 'production';
    return raw === '1' || raw.toLowerCase() === 'true';
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'partner-sync-tick' })
  async tick(): Promise<void> {
    if (!this.isEnabled()) return;
    if (!isD4PartnerHubV1Enabled()) return;
    if (this.running) {
      this.logger.warn('partner-sync.tick: previous run still in progress; skipping this tick');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      await this.runOnce();
    } finally {
      this.running = false;
      this.logger.log(`partner-sync.tick: completed in ${Date.now() - startedAt}ms`);
    }
  }

  async runOnce(now: Date = new Date()): Promise<{
    sourcesScanned: number;
    syncsTriggered: number;
    failures: number;
  }> {
    // Tenants table is non-RLS; safe to read cross-tenant. Per-
    // tenant scan + sync runs inside `tenantContext.run` so the
    // RLS-protected partner_sources read returns the right rows.
    const tenants = await this.prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true, code: true },
    });

    let sourcesScanned = 0;
    let syncsTriggered = 0;
    let failures = 0;
    for (const tenant of tenants) {
      try {
        await tenantContext.run(
          { tenantId: tenant.id, tenantCode: tenant.code, source: 'system' },
          async () => {
            const sources = await this.prisma.withTenant(tenant.id, (tx) =>
              tx.partnerSource.findMany({
                where: { isActive: true, scheduleKind: 'cron' },
                select: { id: true, cronSpec: true },
              }),
            );
            sourcesScanned += sources.length;
            for (const source of sources) {
              if (!source.cronSpec) continue;
              let due = false;
              try {
                due = isDueInMinute(source.cronSpec, now);
              } catch (err) {
                this.logger.warn(
                  `partner-sync source ${source.id} has invalid cronSpec; skipping: ${(err as Error).message}`,
                );
                continue;
              }
              if (!due) continue;
              try {
                await this.sync.runSync(source.id, {
                  trigger: 'cron',
                  actorUserId: null,
                });
                syncsTriggered += 1;
              } catch (err) {
                failures += 1;
                // The sync engine already wrote a failed snapshot
                // + audit for adapter / business errors; this
                // catch handles the unexpected ones (network blip,
                // transient DB issue, etc.). Don't echo the full
                // message — could leak sensitive paths.
                this.logger.error(
                  `partner-sync source ${source.id} crashed: ${(err as Error).name}`,
                );
              }
            }
          },
        );
      } catch (err) {
        failures += 1;
        this.logger.error(`partner-sync tenant ${tenant.code} crashed: ${(err as Error).name}`);
      }
    }
    if (syncsTriggered > 0 || failures > 0) {
      this.logger.log(
        `partner-sync.runOnce: tenants=${tenants.length} sources=${sourcesScanned} triggered=${syncsTriggered} failures=${failures}`,
      );
    }
    return { sourcesScanned, syncsTriggered, failures };
  }
}

/**
 * Decide whether a 5-field crontab spec is due in the wall-clock
 * minute corresponding to `now`.
 *
 * Supports the standard cron syntax operators most operators use:
 *   • `*`               — wildcard (any value)
 *   • single values     — e.g. `5`
 *   • lists             — e.g. `1,3,5`
 *   • ranges            — e.g. `9-17`
 *   • steps over `*`    — e.g. `*\/5`
 *   • steps over range  — e.g. `0-30/5`
 *   • named months/dows are NOT supported (numbers only).
 *
 * Throws on a malformed spec; the caller skips the source and logs.
 *
 * Field meanings (5-field cron):
 *   minute (0-59) / hour (0-23) / day-of-month (1-31) /
 *   month (1-12) / day-of-week (0-6, Sunday=0).
 *
 * Day-of-month / day-of-week semantics: when both are restricted
 * (neither is `*`), POSIX cron OR's them; we follow the same rule.
 */
export function isDueInMinute(cronSpec: string, now: Date): boolean {
  const fields = cronSpec.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron spec must have 5 fields (minute hour dom month dow); got ${fields.length}.`,
    );
  }
  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];
  const minute = now.getMinutes();
  const hour = now.getHours();
  const dom = now.getDate();
  const month = now.getMonth() + 1;
  const dow = now.getDay();
  const minuteOk = matchField(minF, minute, 0, 59);
  const hourOk = matchField(hourF, hour, 0, 23);
  const monthOk = matchField(monF, month, 1, 12);
  if (!minuteOk || !hourOk || !monthOk) return false;
  const domWild = domF === '*';
  const dowWild = dowF === '*';
  const domOk = matchField(domF, dom, 1, 31);
  const dowOk = matchField(dowF, dow, 0, 6);
  if (domWild && dowWild) return true;
  if (domWild) return dowOk;
  if (dowWild) return domOk;
  // Both restricted → POSIX OR semantics.
  return domOk || dowOk;
}

function matchField(field: string, value: number, lo: number, hi: number): boolean {
  for (const part of field.split(',')) {
    if (matchAtom(part, value, lo, hi)) return true;
  }
  return false;
}

function matchAtom(atom: string, value: number, lo: number, hi: number): boolean {
  // step?  e.g. */5 or 0-30/5
  let stepStart: string = atom;
  let step = 1;
  const slash = atom.indexOf('/');
  if (slash !== -1) {
    stepStart = atom.slice(0, slash);
    const stepRaw = Number.parseInt(atom.slice(slash + 1), 10);
    if (!Number.isFinite(stepRaw) || stepRaw < 1) {
      throw new Error(`Invalid step in cron atom "${atom}".`);
    }
    step = stepRaw;
  }
  // Resolve the (start, end) range that the step iterates over.
  let start: number;
  let end: number;
  if (stepStart === '*' || stepStart === '') {
    start = lo;
    end = hi;
  } else if (stepStart.includes('-')) {
    const [a, b] = stepStart.split('-');
    const aN = Number.parseInt(a ?? '', 10);
    const bN = Number.parseInt(b ?? '', 10);
    if (!Number.isFinite(aN) || !Number.isFinite(bN)) {
      throw new Error(`Invalid range in cron atom "${atom}".`);
    }
    start = aN;
    end = bN;
  } else {
    const v = Number.parseInt(stepStart, 10);
    if (!Number.isFinite(v)) {
      throw new Error(`Invalid value in cron atom "${atom}".`);
    }
    if (slash === -1) {
      // single value
      return v === value;
    }
    // value with step (rare): 5/10 → 5, 15, 25, …
    start = v;
    end = hi;
  }
  if (start < lo || end > hi || start > end) {
    throw new Error(`Out-of-range cron atom "${atom}" (allowed ${lo}-${hi}).`);
  }
  for (let i = start; i <= end; i += step) {
    if (i === value) return true;
  }
  return false;
}
