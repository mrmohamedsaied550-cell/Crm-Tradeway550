import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Read-only access to the calling tenant's pipeline catalogue.
 *
 * Two responsibilities:
 *
 * 1. Tenant-default pipeline access. P2-07 introduced first-class
 *    `Pipeline` rows; every tenant has exactly one default
 *    (`is_default = TRUE`). Pre-1B, the entire lead lifecycle
 *    resolved stage codes against this default — kept as the fallback
 *    for callers that don't yet pass a (company, country) scope.
 *
 * 2. Phase 1B — `resolveForLead({ companyId, countryId })`: picks the
 *    right pipeline for a lead's scope using a deterministic fallback
 *    chain:
 *       (a) exact match on (tenant, company, country)
 *       (b) company-scoped, no country     (tenant, company, NULL)
 *       (c) country-scoped, no company     (tenant, NULL, country)
 *       (d) tenant default                 (tenant, NULL, NULL, isDefault)
 *    The first hit wins. (d) is guaranteed to exist (seed + migration).
 *
 * Reads are wrapped in `withTenant(...)` so the database's RLS policy
 * gates every fetch.
 */
@Injectable()
export class PipelineService {
  constructor(private readonly prisma: PrismaService) {}

  /** Stages of the calling tenant's default pipeline, sorted by order. */
  list() {
    return this.prisma.withTenant(requireTenantId(), async (tx) => {
      const pipelineId = await this.findDefaultPipelineIdInTx(tx);
      return tx.pipelineStage.findMany({
        where: { pipelineId },
        orderBy: { order: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          order: true,
          isTerminal: true,
          terminalKind: true,
        },
      });
    });
  }

  /**
   * @deprecated Phase 1B — resolves codes against the tenant DEFAULT
   * pipeline only. Use `findCodeInPipelineOrThrow(pipelineId, code)`
   * with the lead's actual pipeline whenever possible. Kept on the
   * surface because:
   *   • the `list` filter falls back here when the caller passes
   *     `stageCode` (legacy code-based filter),
   *   • the CSV import + Meta webhook resolve `'new'` here as the
   *     entry point (both currently land on the tenant default).
   */
  async findByCodeOrThrow(code: string) {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, async (tx) => {
      const pipelineId = await this.findDefaultPipelineIdInTx(tx);
      return tx.pipelineStage.findUnique({
        where: { pipelineId_code: { pipelineId, code } },
        select: {
          id: true,
          code: true,
          name: true,
          order: true,
          isTerminal: true,
          terminalKind: true,
        },
      });
    });
    if (!row) {
      throw new NotFoundException({
        code: 'pipeline.stage.not_found',
        message: `Pipeline stage not found: ${code}`,
      });
    }
    return row;
  }

  /**
   * Find the calling tenant's default pipeline id inside an existing
   * transaction. Throws if the row is missing — every tenant should
   * carry one (the P2-07 migration + the seed guarantee it).
   */
  async findDefaultPipelineIdInTx(tx: Prisma.TransactionClient): Promise<string> {
    const tenantId = requireTenantId();
    const p = await tx.pipeline.findFirst({
      where: { tenantId, isDefault: true },
      select: { id: true },
    });
    if (!p) {
      throw new NotFoundException({
        code: 'pipeline.default_missing',
        message: `Tenant ${tenantId} has no default pipeline (run the P2-07 migration + seed)`,
      });
    }
    return p.id;
  }

  /**
   * Phase 1B — resolve the right pipeline for a lead's scope.
   *
   * Fallback chain (first match wins):
   *   1. (tenant, company, country) — full match
   *   2. (tenant, company, NULL)    — company-only
   *   3. (tenant, NULL,    country) — country-only
   *   4. (tenant, NULL,    NULL, isDefault=true) — guaranteed
   *
   * Only `isActive = true` pipelines are considered for steps 1-3;
   * the default (step 4) is always returned even if isActive flips,
   * because the system contract requires every tenant to always
   * resolve to *some* pipeline. (Disabling the tenant default is
   * blocked by `pipeline.default_must_stay_active` at the admin
   * surface anyway.)
   */
  async resolveForLead(scope: { companyId?: string | null; countryId?: string | null }): Promise<{
    id: string;
    isDefault: boolean;
    companyId: string | null;
    countryId: string | null;
  }> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) => this.resolveForLeadInTx(tx, scope));
  }

  /**
   * Same as `resolveForLead` but reuses an existing transaction —
   * lets callers (LeadsService.create) atomically resolve + insert
   * inside one tenant-scoped transaction.
   */
  async resolveForLeadInTx(
    tx: Prisma.TransactionClient,
    scope: { companyId?: string | null; countryId?: string | null },
  ): Promise<{
    id: string;
    isDefault: boolean;
    companyId: string | null;
    countryId: string | null;
  }> {
    const tenantId = requireTenantId();
    const select = {
      id: true,
      isDefault: true,
      companyId: true,
      countryId: true,
    } as const;

    const companyId = scope.companyId ?? null;
    const countryId = scope.countryId ?? null;

    if (companyId && countryId) {
      const exact = await tx.pipeline.findFirst({
        where: { tenantId, companyId, countryId, isActive: true },
        select,
      });
      if (exact) return exact;
    }

    if (companyId) {
      const companyOnly = await tx.pipeline.findFirst({
        where: { tenantId, companyId, countryId: null, isActive: true },
        select,
      });
      if (companyOnly) return companyOnly;
    }

    if (countryId) {
      const countryOnly = await tx.pipeline.findFirst({
        where: { tenantId, companyId: null, countryId, isActive: true },
        select,
      });
      if (countryOnly) return countryOnly;
    }

    const def = await tx.pipeline.findFirst({
      where: { tenantId, isDefault: true },
      select,
    });
    if (!def) {
      throw new NotFoundException({
        code: 'pipeline.default_missing',
        message: `Tenant ${tenantId} has no default pipeline (run the P2-07 migration + seed)`,
      });
    }
    return def;
  }

  /**
   * Phase 1B — fetch a stage by id and verify it belongs to a given
   * pipeline. Used by moveStage to prevent cross-pipeline transitions
   * (would corrupt Kanban + reporting).
   */
  async findStageInPipelineOrThrow(
    pipelineId: string,
    stageId: string,
  ): Promise<{
    id: string;
    pipelineId: string;
    code: string;
    name: string;
    order: number;
    isTerminal: boolean;
    /** Phase A — drives Lead.lifecycleState on stage moves. */
    terminalKind: string | null;
  }> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.pipelineStage.findFirst({
        where: { id: stageId, pipelineId },
        select: {
          id: true,
          pipelineId: true,
          code: true,
          name: true,
          order: true,
          isTerminal: true,
          terminalKind: true,
        },
      }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'pipeline.stage.not_in_pipeline',
        message: `Stage ${stageId} does not belong to pipeline ${pipelineId}`,
      });
    }
    return row;
  }

  /**
   * Phase 1B — resolve a stage code against a specific pipeline (not
   * just the tenant default). Used by callers that already know which
   * pipeline they're operating on (lead create, ingestion).
   */
  async findCodeInPipelineOrThrow(
    pipelineId: string,
    code: string,
  ): Promise<{
    id: string;
    code: string;
    name: string;
    order: number;
    isTerminal: boolean;
    terminalKind: string | null;
  }> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.pipelineStage.findUnique({
        where: { pipelineId_code: { pipelineId, code } },
        select: {
          id: true,
          code: true,
          name: true,
          order: true,
          isTerminal: true,
          terminalKind: true,
        },
      }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'pipeline.stage.not_found',
        message: `Pipeline ${pipelineId} has no stage with code "${code}"`,
      });
    }
    return row;
  }
}
