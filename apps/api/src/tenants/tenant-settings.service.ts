import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { getSlaMinutes } from '../crm/sla.config';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from './tenant-context';
import type { DistributionRule, UpdateTenantSettingsDto } from './tenant-settings.dto';

export interface TenantSettings {
  tenantId: string;
  timezone: string;
  slaMinutes: number;
  defaultDialCode: string;
  /**
   * PL-3 — source→agent overrides consulted before round-robin in
   * LeadsService.autoAssign. Always an array; never null. The
   * fallback value is `[]` so callers can iterate without a guard.
   */
  distributionRules: DistributionRule[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * PL-3 — narrow the JSON column into the typed shape, dropping any
 * row that doesn't satisfy the runtime contract. Defensive against
 * a hand-edited DB row or a stale row from an older schema.
 */
function parseRules(raw: unknown): DistributionRule[] {
  if (!Array.isArray(raw)) return [];
  const out: DistributionRule[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const source = obj['source'];
    const assigneeUserId = obj['assigneeUserId'];
    if (typeof source !== 'string' || typeof assigneeUserId !== 'string') continue;
    if (seen.has(source)) continue;
    seen.add(source);
    out.push({ source: source as DistributionRule['source'], assigneeUserId });
  }
  return out;
}

/**
 * P2-08 — read + write the per-tenant settings row.
 *
 * Reads are tolerant: callers (SlaService.computeDueAt,
 * lead-creating flows that need a default dial code, the
 * "due-today" boundary calculator) tolerate a missing row by
 * falling back to baked-in defaults. The migration seeds one row
 * per existing tenant; future tenants get one via the seed or
 * the lazy `ensureForTenant` helper below.
 *
 * Writes are gated behind the `tenant.settings.write` capability
 * at the controller layer and audit every change.
 */
@Injectable()
export class TenantSettingsService {
  /**
   * Fallback values when a tenant row is missing. Match the
   * migration's column defaults for `timezone` and
   * `defaultDialCode`; for `slaMinutes` we defer to the legacy
   * `LEAD_SLA_MINUTES` env var (via `getSlaMinutes`) so a tenant
   * that hasn't yet acquired a settings row still inherits the
   * pre-P2-08 behaviour. The env default is itself 15 minutes.
   */
  static readonly FALLBACK_TIMEZONE = 'Africa/Cairo';
  static readonly FALLBACK_DIAL_CODE = '+20';

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Active-tenant settings, with a guarantee that we return SOMETHING
   * (the row, or a synthesised fallback). Hot path — every SLA-set
   * write hits this, so we keep it to a single SELECT.
   */
  async getCurrent(): Promise<TenantSettings> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantSettings.findUnique({ where: { tenantId } }),
    );
    if (row) return this.normalize(row);
    return this.synthFallback(tenantId);
  }

  /**
   * Same as `getCurrent` but takes the tenantId explicitly — for
   * callers that have already resolved the tenant outside of the
   * AsyncLocalStorage scope (e.g. webhook ingestion paths).
   */
  async getForTenant(tenantId: string): Promise<TenantSettings> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantSettings.findUnique({ where: { tenantId } }),
    );
    if (row) return this.normalize(row);
    return this.synthFallback(tenantId);
  }

  /**
   * Same as `getForTenant` but reuses an existing transaction. Use
   * this from inside `withTenant(...)` blocks (e.g. SLA reset
   * inside a lead-update tx) to avoid opening a second tx.
   */
  async getInTx(tx: Prisma.TransactionClient, tenantId: string): Promise<TenantSettings> {
    const row = await tx.tenantSettings.findUnique({ where: { tenantId } });
    if (row) return this.normalize(row);
    return this.synthFallback(tenantId);
  }

  /**
   * Upsert variant — used by tests and one-shot tooling that need
   * to *guarantee* the row exists before reading. Production reads
   * tolerate the missing row, so this is rarely needed.
   */
  async ensureForCurrentTenant(): Promise<TenantSettings> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId },
      });
      return this.normalize(row);
    });
  }

  async update(dto: UpdateTenantSettingsDto, actorUserId: string | null): Promise<TenantSettings> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const updated = await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {
          ...(dto.timezone !== undefined && { timezone: dto.timezone }),
          ...(dto.slaMinutes !== undefined && { slaMinutes: dto.slaMinutes }),
          ...(dto.defaultDialCode !== undefined && { defaultDialCode: dto.defaultDialCode }),
          ...(dto.distributionRules !== undefined && {
            distributionRules: dto.distributionRules as Prisma.InputJsonValue,
          }),
        },
        create: {
          tenantId,
          timezone: dto.timezone ?? TenantSettingsService.FALLBACK_TIMEZONE,
          slaMinutes: dto.slaMinutes ?? getSlaMinutes(),
          defaultDialCode: dto.defaultDialCode ?? TenantSettingsService.FALLBACK_DIAL_CODE,
          ...(dto.distributionRules !== undefined && {
            distributionRules: dto.distributionRules as Prisma.InputJsonValue,
          }),
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'tenant.settings.updated',
        entityType: 'tenant_settings',
        entityId: tenantId,
        actorUserId,
        payload: { changes: Object.keys(dto) } as Prisma.InputJsonValue,
      });
      return this.normalize(updated);
    });
  }

  /**
   * Map a raw Prisma row into the typed surface used by callers.
   * The `distributionRules` JSON column is parsed defensively via
   * `parseRules` so a hand-edited DB row can never crash a request.
   */
  private normalize(row: {
    tenantId: string;
    timezone: string;
    slaMinutes: number;
    defaultDialCode: string;
    distributionRules: unknown;
    createdAt: Date;
    updatedAt: Date;
  }): TenantSettings {
    return {
      tenantId: row.tenantId,
      timezone: row.timezone,
      slaMinutes: row.slaMinutes,
      defaultDialCode: row.defaultDialCode,
      distributionRules: parseRules(row.distributionRules),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Keep the synthesised row's shape identical to a real row. */
  private synthFallback(tenantId: string): TenantSettings {
    const now = new Date();
    return {
      tenantId,
      timezone: TenantSettingsService.FALLBACK_TIMEZONE,
      // Honour the legacy LEAD_SLA_MINUTES env var so tenants that
      // pre-date P2-08 keep their old behaviour until the operator
      // explicitly writes a settings row.
      slaMinutes: getSlaMinutes(),
      defaultDialCode: TenantSettingsService.FALLBACK_DIAL_CODE,
      distributionRules: [],
      createdAt: now,
      updatedAt: now,
    };
  }
}
