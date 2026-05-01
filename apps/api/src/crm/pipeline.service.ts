import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Read-only access to the tenant's DEFAULT pipeline catalogue.
 *
 * P2-07 introduced first-class `Pipeline` rows — every tenant has
 * exactly one default pipeline (`is_default = TRUE`). Lead lifecycle
 * code (LeadsService, CaptainsService, LeadIngestionService) resolves
 * stage codes against this default, which preserves the pre-P2-07
 * "single shared funnel" contract while leaving room for per
 * (Company × Country) pipelines administered through PipelinesService.
 *
 * Reads are wrapped in `withTenant(...)` so the database's RLS policy
 * is the gate.
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
        select: { id: true, code: true, name: true, order: true, isTerminal: true },
      });
    });
  }

  async findByCodeOrThrow(code: string) {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, async (tx) => {
      const pipelineId = await this.findDefaultPipelineIdInTx(tx);
      return tx.pipelineStage.findUnique({
        where: { pipelineId_code: { pipelineId, code } },
        select: { id: true, code: true, name: true, order: true, isTerminal: true },
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
}
