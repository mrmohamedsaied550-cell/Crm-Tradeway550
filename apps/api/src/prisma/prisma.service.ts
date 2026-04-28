import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PrismaClient wrapped in a Nest provider lifecycle.
 *
 * Exposes `withTenant(tenantId, fn)` — the canonical helper for executing
 * tenant-scoped queries. It opens a Prisma transaction, sets the per-session
 * GUC `app.tenant_id` via `SET LOCAL`, and runs `fn` against the transaction
 * client. Any RLS policy on a tenant-scoped table can then call
 * `current_tenant_id()` (declared in migration 0001_foundations) to enforce
 * isolation. Connection pooling is honoured — `SET LOCAL` is reset at the
 * end of each transaction, so connections are safe to recycle.
 *
 * No tenant-scoped tables exist yet in C6; the helper is the foundation.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Execute `fn` inside a transaction with `SET LOCAL app.tenant_id = $tenantId`.
   *
   * The tenant id is validated as a UUID before being inlined into the SQL —
   * `SET LOCAL` does not accept parameter binding via prepared statements.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!UUID_REGEX.test(tenantId)) {
      throw new Error(`PrismaService.withTenant: invalid tenantId "${tenantId}"`);
    }
    return this.$transaction(async (tx) => {
      // SET LOCAL persists only for this transaction — safe with connection pooling.
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
      return fn(tx);
    });
  }
}
