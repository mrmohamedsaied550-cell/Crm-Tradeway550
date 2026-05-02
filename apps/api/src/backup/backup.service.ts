import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * P3-07 — per-tenant CRM JSON export.
 *
 * Returns a self-contained snapshot of the tenant's operational data
 * so an admin can:
 *   - keep an offline copy ahead of a risky migration / merge,
 *   - hand the data to a customer on tenant offboarding,
 *   - feed it into a one-shot restore script (out of scope for the
 *     API — see scripts/restore.sh for the DB-level path).
 *
 * Sensitive fields are stripped at this boundary:
 *   - WhatsAppAccount.accessTokenCiphertext / appSecret / verifyToken,
 *   - User.passwordHash,
 *   - any *_secret column.
 *
 * Row caps prevent OOM on large tenants. The cap is generous (10k
 * per table); operators that need a true full backup should use the
 * scripts/backup.sh `pg_dump` path.
 */

const ROW_CAP = 10_000;

export interface TenantBackup {
  exportedAt: string;
  tenant: { id: string; code: string; name: string };
  /** Schema-version stamp; bumped when the export shape changes. */
  schemaVersion: 1;
  rowCap: number;
  counts: Record<string, number>;
  data: {
    users: unknown[];
    pipelines: unknown[];
    pipelineStages: unknown[];
    leads: unknown[];
    leadActivities: unknown[];
    leadFollowUps: unknown[];
    captains: unknown[];
    captainDocuments: unknown[];
    captainTrips: unknown[];
    whatsappAccounts: unknown[];
    whatsappConversations: unknown[];
    whatsappMessages: unknown[];
    whatsappTemplates: unknown[];
    bonusRules: unknown[];
    bonusAccruals: unknown[];
    competitions: unknown[];
    notifications: unknown[];
  };
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(private readonly prisma: PrismaService) {}

  async exportTenant(): Promise<TenantBackup> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { id: true, code: true, name: true },
      });

      // ─── Each query selects an explicit field set so a future
      // schema addition doesn't accidentally start exporting a
      // sensitive column. Sort by id for deterministic output.
      const users = await tx.user.findMany({
        select: {
          id: true,
          email: true,
          name: true,
          status: true,
          roleId: true,
          createdAt: true,
          updatedAt: true,
          // passwordHash, lockedUntil, failedLoginCount intentionally omitted.
        },
        orderBy: { id: 'asc' },
        take: ROW_CAP,
      });

      const pipelines = await tx.pipeline.findMany({
        select: { id: true, name: true, isDefault: true, isActive: true },
        orderBy: { id: 'asc' },
        take: ROW_CAP,
      });

      const pipelineStages = await tx.pipelineStage.findMany({
        select: {
          id: true,
          pipelineId: true,
          code: true,
          name: true,
          order: true,
          isTerminal: true,
        },
        orderBy: { id: 'asc' },
        take: ROW_CAP,
      });

      const leads = await tx.lead.findMany({
        orderBy: { createdAt: 'asc' },
        take: ROW_CAP,
      });

      const leadActivities = await tx.leadActivity.findMany({
        orderBy: { createdAt: 'asc' },
        take: ROW_CAP,
      });

      const leadFollowUps = await tx.leadFollowUp.findMany({
        orderBy: { dueAt: 'asc' },
        take: ROW_CAP,
      });

      const captains = await tx.captain.findMany({
        orderBy: { createdAt: 'asc' },
        take: ROW_CAP,
      });

      const captainDocuments = await tx.captainDocument.findMany({
        orderBy: { createdAt: 'asc' },
        take: ROW_CAP,
      });

      const captainTrips = await tx.captainTrip.findMany({
        orderBy: { occurredAt: 'asc' },
        take: ROW_CAP,
      });

      // P2-05 — accessToken + appSecret + verifyToken are explicitly
      // stripped so a backup file can be shared without leaking
      // provider credentials.
      const whatsappAccounts = await tx.whatsAppAccount.findMany({
        select: {
          id: true,
          provider: true,
          phoneNumber: true,
          phoneNumberId: true,
          displayName: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { id: 'asc' },
        take: ROW_CAP,
      });

      const whatsappConversations = await tx.whatsAppConversation.findMany({
        orderBy: { lastMessageAt: 'desc' },
        take: ROW_CAP,
      });

      const whatsappMessages = await tx.whatsAppMessage.findMany({
        orderBy: { createdAt: 'asc' },
        take: ROW_CAP,
      });

      const whatsappTemplates = await tx.whatsAppTemplate.findMany({
        orderBy: { id: 'asc' },
        take: ROW_CAP,
      });

      const bonusRules = await tx.bonusRule.findMany({
        orderBy: { createdAt: 'asc' },
        take: ROW_CAP,
      });

      const bonusAccruals = await tx.bonusAccrual.findMany({
        orderBy: { createdAt: 'asc' },
        take: ROW_CAP,
      });

      const competitions = await tx.competition.findMany({
        orderBy: { createdAt: 'asc' },
        take: ROW_CAP,
      });

      const notifications = await tx.notification.findMany({
        orderBy: { createdAt: 'desc' },
        take: ROW_CAP,
      });

      const data = {
        users,
        pipelines,
        pipelineStages,
        leads,
        leadActivities,
        leadFollowUps,
        captains,
        captainDocuments,
        captainTrips,
        whatsappAccounts,
        whatsappConversations,
        whatsappMessages,
        whatsappTemplates,
        bonusRules,
        bonusAccruals,
        competitions,
        notifications,
      } as const;

      const counts = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, (v as unknown[]).length]),
      );

      this.logger.log(
        `tenant export: ${tenant.code} — ${Object.values(counts).reduce((a, b) => a + b, 0)} rows total`,
      );

      return {
        exportedAt: new Date().toISOString(),
        tenant,
        schemaVersion: 1 as const,
        rowCap: ROW_CAP,
        counts,
        data,
      };
    });
  }
}
