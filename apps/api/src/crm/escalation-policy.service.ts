import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

import {
  DEFAULT_ESCALATION_RULES,
  type EscalationRulesConfig,
  type HandoverMode,
  type ThresholdPolicy,
  parseEscalationRulesJson,
} from './escalation-rules.dto';

/**
 * Phase D3 — D3.5: read-only escalation policy.
 *
 * Resolves the per-tenant SLA escalation rules: returns the per-
 * threshold action, the default handover mode for rotations, and a
 * single `getPolicy()` for callers that want the whole config.
 *
 * Tolerant of NULL / malformed `tenant_settings.escalation_rules` —
 * falls back to `DEFAULT_ESCALATION_RULES`. Callers therefore
 * always get a fully-populated config without conditional checks.
 *
 * D3.5 is read-only; the admin editor panel lands in D3.7. Writes
 * happen via the existing `tenant_settings` PATCH path once that
 * panel ships (no service-side write today).
 */
@Injectable()
export class EscalationPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the resolved policy for the active tenant. One DB round-
   * trip per call (no in-process cache today — the SLA scheduler
   * tick is per-tenant per minute, well below any caching benefit
   * threshold).
   */
  async getPolicy(): Promise<EscalationRulesConfig> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantSettings.findUnique({
        where: { tenantId },
        select: { escalationRules: true },
      }),
    );
    return parseEscalationRulesJson(row?.escalationRules ?? null);
  }

  /**
   * Resolve the action for a single threshold bucket. `t75` / `t100`
   * / `t150` / `t200` — anything else returns the `t75` default
   * (defensive; the SLA threshold engine only ever emits the four
   * known buckets).
   */
  async policyForThreshold(threshold: 't75' | 't100' | 't150' | 't200'): Promise<ThresholdPolicy> {
    const policy = await this.getPolicy();
    return policy.thresholds[threshold];
  }

  /**
   * Resolve the handover mode the escalation engine should use when
   * a rotation fires. Currently a single tenant-wide value; future
   * D3 chunks may surface per-trigger override.
   */
  async defaultHandoverMode(): Promise<HandoverMode> {
    const policy = await this.getPolicy();
    return policy.defaultHandoverMode;
  }

  /**
   * Pure variant: resolve the action for a threshold from an
   * already-loaded policy. Used by the SLA scheduler's per-tenant
   * tick to avoid a second DB round-trip when it has already
   * called `getPolicy()`.
   */
  resolveThreshold(
    policy: EscalationRulesConfig,
    threshold: 't75' | 't100' | 't150' | 't200',
  ): ThresholdPolicy {
    return policy.thresholds[threshold];
  }

  /** Convenience export — defaults remain a single source of truth
   *  in `escalation-rules.dto.ts`; callers that don't need a service
   *  instance can import the constant directly. Re-exported here so
   *  consumers that already inject the service don't need a second
   *  import. */
  // eslint-disable-next-line class-methods-use-this
  defaults(): EscalationRulesConfig {
    return { ...DEFAULT_ESCALATION_RULES };
  }
}
