import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Read-only access to the per-tenant pipeline catalogue.
 *
 * Reads are wrapped in `withTenant(...)` so the database's RLS policy is
 * the actual gate. Writes (create/reorder/disable a stage) are admin
 * operations and arrive in a later chunk along with the no-code Pipeline
 * Builder UI from the PRD.
 */
@Injectable()
export class PipelineService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.pipelineStage.findMany({
        orderBy: { order: 'asc' },
        select: { id: true, code: true, name: true, order: true, isTerminal: true },
      }),
    );
  }

  async findByCodeOrThrow(code: string) {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.pipelineStage.findUnique({
        where: { tenantId_code: { tenantId, code } },
        select: { id: true, code: true, name: true, order: true, isTerminal: true },
      }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'pipeline.stage.not_found',
        message: `Pipeline stage not found: ${code}`,
      });
    }
    return row;
  }
}
