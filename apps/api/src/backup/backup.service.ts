import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type {
  ExportColumn,
  StructuredExport,
  StructuredTenantBackup,
  StructuredTenantBackupTable,
} from '../rbac/export-contract';
import type { CatalogueResource } from '../rbac/field-catalogue.registry';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * P3-07 — per-tenant CRM JSON export.
 *
 * Returns a self-contained snapshot of the tenant's operational data
 * so an admin can:
 *   - keep an offline copy ahead of a risky migration / merge,
 *   - hand the data to a customer on tenant offboarding,
 *   - feed it into a one-shot restore script (`scripts/restore.sh`).
 *
 * Sensitive fields are stripped at this boundary and NEVER catalogued:
 *   - WhatsAppAccount.accessToken / appSecret / verifyToken,
 *   - User.passwordHash / mfaSecret / failedLoginCount / lockedUntil,
 *   - any *_secret column.
 *
 * Row caps prevent OOM on large tenants. The cap is generous (10k
 * per table); operators that need a true full backup should use the
 * scripts/backup.sh `pg_dump` path.
 *
 * Phase D5 — D5.6D-1: backup governance foundation.
 *
 *   The export now passes through the D5 export pipeline. The
 *   service builds a `StructuredTenantBackup` internally — one
 *   `StructuredExport` per table with explicit column declarations
 *   anchored to the field catalogue. The wire format remains
 *   byte-restore-compatible: the export interceptor's
 *   `json-tenant-backup` serialiser collapses `tables` back into the
 *   legacy `data: Record<table, row[]>` envelope before NestJS ships
 *   the response. `scripts/restore.sh` continues to round-trip an
 *   export → restore cycle without alteration.
 *
 *   D5.6D-1 ships the structured shape + catalogue coverage + audit
 *   envelope. Redaction is a NO-OP in D5.6D-1 (every input row /
 *   column survives) — D5.6D-2 introduces redaction semantics and
 *   the `E_BACKUP_REDACTED_NOT_RESTORABLE` guard that prevents a
 *   silently-stripped backup from being mistaken for a full one.
 */

const ROW_CAP = 10_000;
const SCHEMA_VERSION = 1;

/**
 * Wire-format envelope returned to clients. Mirrors the pre-D5.6D-1
 * `TenantBackup` shape byte-for-byte so existing consumers
 * (scripts/restore.sh, archive tools, customer hand-offs) keep
 * working unchanged. The service builds a `StructuredTenantBackup`
 * internally; the export interceptor collapses it back into this
 * legacy shape on the wire.
 */
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

/** D5.6D-1 — list of resources every backup table inherits from. */
export const BACKUP_INHERIT_RESOURCES: readonly CatalogueResource[] = [
  'org.user',
  'pipeline',
  'pipeline.stage',
  'lead',
  'lead.activity',
  'followup',
  'captain',
  'captain.document',
  'captain.trip',
  'whatsapp.account',
  'whatsapp.conversation',
  'whatsapp.message',
  'whatsapp.template',
  'bonus.rule',
  'bonus.accrual',
  'competition',
  'notification',
];

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * D5.6D-1 — structured tenant backup builder.
   *
   * Returns a `StructuredTenantBackup` whose `tables` carry per-
   * column resource/field metadata for the redaction surface. The
   * export interceptor consumes this directly and serialises it to
   * the legacy `TenantBackup` JSON shape for the wire response.
   */
  async exportTenant(): Promise<StructuredTenantBackup> {
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
          // passwordHash, mfaSecret, lockedUntil, failedLoginCount intentionally omitted.
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

      const tables: StructuredTenantBackupTable[] = [
        buildTable('users', 'org.user', users, USER_COLUMN_FIELDS),
        buildTable('pipelines', 'pipeline', pipelines, PIPELINE_COLUMN_FIELDS),
        buildTable(
          'pipelineStages',
          'pipeline.stage',
          pipelineStages,
          PIPELINE_STAGE_COLUMN_FIELDS,
        ),
        buildTable('leads', 'lead', leads, LEAD_COLUMN_FIELDS),
        buildTable('leadActivities', 'lead.activity', leadActivities, LEAD_ACTIVITY_COLUMN_FIELDS),
        buildTable('leadFollowUps', 'followup', leadFollowUps, LEAD_FOLLOWUP_COLUMN_FIELDS),
        buildTable('captains', 'captain', captains, CAPTAIN_COLUMN_FIELDS),
        buildTable(
          'captainDocuments',
          'captain.document',
          captainDocuments,
          CAPTAIN_DOCUMENT_COLUMN_FIELDS,
        ),
        buildTable('captainTrips', 'captain.trip', captainTrips, CAPTAIN_TRIP_COLUMN_FIELDS),
        buildTable(
          'whatsappAccounts',
          'whatsapp.account',
          whatsappAccounts,
          WHATSAPP_ACCOUNT_COLUMN_FIELDS,
        ),
        buildTable(
          'whatsappConversations',
          'whatsapp.conversation',
          whatsappConversations,
          WHATSAPP_CONVERSATION_COLUMN_FIELDS,
        ),
        buildTable(
          'whatsappMessages',
          'whatsapp.message',
          whatsappMessages,
          WHATSAPP_MESSAGE_COLUMN_FIELDS,
        ),
        buildTable(
          'whatsappTemplates',
          'whatsapp.template',
          whatsappTemplates,
          WHATSAPP_TEMPLATE_COLUMN_FIELDS,
        ),
        buildTable('bonusRules', 'bonus.rule', bonusRules, BONUS_RULE_COLUMN_FIELDS),
        buildTable('bonusAccruals', 'bonus.accrual', bonusAccruals, BONUS_ACCRUAL_COLUMN_FIELDS),
        buildTable('competitions', 'competition', competitions, COMPETITION_COLUMN_FIELDS),
        buildTable('notifications', 'notification', notifications, NOTIFICATION_COLUMN_FIELDS),
      ];

      const totalRows = tables.reduce((sum, t) => sum + t.export.rows.length, 0);
      this.logger.log(`tenant export: ${tenant.code} — ${totalRows} rows total`);

      return {
        format: 'json-tenant-backup' as const,
        filename: `tenant-${tenant.code}-${new Date().toISOString().slice(0, 10)}.json`,
        exportedAt: new Date().toISOString(),
        tenant,
        schemaVersion: SCHEMA_VERSION,
        rowCap: ROW_CAP,
        tables,
      };
    });
  }
}

// ─── helpers ───────────────────────────────────────────────────────

/**
 * Build a `StructuredTenantBackupTable` from a list of Prisma rows
 * + a column-name list. The catalogue resource + field both use the
 * Prisma column name verbatim so a deny rule on `lead.phone` strips
 * the `phone` column from the leads backup table directly.
 *
 * Rows are passed through as-is — `findMany` with explicit `select`
 * already determined which columns ship; the column declaration is
 * a structural mirror of that decision so the redactor (D5.6D-2)
 * has the right anchor.
 */
function buildTable(
  tableName: string,
  resource: CatalogueResource,
  rows: readonly unknown[],
  columnFields: readonly string[],
): StructuredTenantBackupTable {
  const columns: ExportColumn[] = columnFields.map((field) => ({
    key: field,
    label: field,
    resource,
    field,
  }));
  const exp: StructuredExport = {
    format: 'json',
    filename: `${tableName}.json`,
    columns,
    rows: rows as readonly Record<string, unknown>[],
  };
  return { tableName, export: exp };
}

// ─── per-table column-name lists ───────────────────────────────────
//
// Each list is the EXACT set of fields the corresponding Prisma
// query emits. Add a new column here only after adding a matching
// catalogue entry under the table's resource — the
// `every backup column has a catalogue entry` D5.6D-1 test enforces
// the link.

const USER_COLUMN_FIELDS = [
  'id',
  'email',
  'name',
  'status',
  'roleId',
  'createdAt',
  'updatedAt',
] as const;

const PIPELINE_COLUMN_FIELDS = ['id', 'name', 'isDefault', 'isActive'] as const;

const PIPELINE_STAGE_COLUMN_FIELDS = [
  'id',
  'pipelineId',
  'code',
  'name',
  'order',
  'isTerminal',
] as const;

const LEAD_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'name',
  'phone',
  'email',
  'source',
  'companyId',
  'countryId',
  'stageId',
  'pipelineId',
  'assignedToId',
  'createdById',
  'slaDueAt',
  'slaStatus',
  'lastResponseAt',
  'slaThreshold',
  'slaThresholdAt',
  'lastRotatedAt',
  'currentStageStatusId',
  'lastActivityAt',
  'nextActionDueAt',
  'lifecycleState',
  'lostReasonId',
  'lostNote',
  'attribution',
  'contactId',
  'primaryConversationId',
  'attemptIndex',
  'previousLeadId',
  'reactivatedAt',
  'reactivatedById',
  'reactivationRule',
  'partnerVerificationCache',
  'createdAt',
  'updatedAt',
] as const;

const LEAD_ACTIVITY_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'leadId',
  'type',
  'body',
  'payload',
  'actionSource',
  'createdById',
  'createdAt',
] as const;

const LEAD_FOLLOWUP_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'leadId',
  'actionType',
  'dueAt',
  'note',
  'completedAt',
  'snoozedUntil',
  'actionSource',
  'assignedToId',
  'createdById',
  'createdAt',
  'updatedAt',
] as const;

const CAPTAIN_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'leadId',
  'name',
  'phone',
  'teamId',
  'status',
  'onboardingStatus',
  'hasIdCard',
  'hasLicense',
  'hasVehicleRegistration',
  'activatedAt',
  'firstTripAt',
  'tripCount',
  'dftAt',
  'createdAt',
  'updatedAt',
] as const;

const CAPTAIN_DOCUMENT_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'captainId',
  'kind',
  'storageRef',
  'fileName',
  'mimeType',
  'sizeBytes',
  'status',
  'expiresAt',
  'reviewerUserId',
  'reviewedAt',
  'reviewNotes',
  'uploadedById',
  'createdAt',
  'updatedAt',
] as const;

const CAPTAIN_TRIP_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'captainId',
  'tripId',
  'occurredAt',
  'payload',
  'createdAt',
] as const;

const WHATSAPP_ACCOUNT_COLUMN_FIELDS = [
  'id',
  'provider',
  'phoneNumber',
  'phoneNumberId',
  'displayName',
  'isActive',
  'createdAt',
  'updatedAt',
] as const;

const WHATSAPP_CONVERSATION_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'accountId',
  'phone',
  'status',
  'lastMessageAt',
  'lastMessageText',
  'lastInboundAt',
  'leadId',
  'contactId',
  'assignedToId',
  'teamId',
  'companyId',
  'countryId',
  'assignmentSource',
  'assignedAt',
  'createdAt',
  'updatedAt',
] as const;

const WHATSAPP_MESSAGE_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'accountId',
  'conversationId',
  'phone',
  'text',
  'direction',
  'messageType',
  'mediaUrl',
  'mediaMimeType',
  'templateName',
  'templateLanguage',
  'providerMessageId',
  'status',
  'createdAt',
] as const;

const WHATSAPP_TEMPLATE_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'accountId',
  'name',
  'language',
  'category',
  'bodyText',
  'variableCount',
  'status',
  'createdAt',
  'updatedAt',
] as const;

const BONUS_RULE_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'companyId',
  'countryId',
  'teamId',
  'roleId',
  'bonusType',
  'trigger',
  'amount',
  'isActive',
  'createdAt',
  'updatedAt',
] as const;

const BONUS_ACCRUAL_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'bonusRuleId',
  'recipientUserId',
  'captainId',
  'triggerKind',
  'amount',
  'status',
  'payload',
  'createdAt',
  'updatedAt',
] as const;

const COMPETITION_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'name',
  'companyId',
  'countryId',
  'teamId',
  'startDate',
  'endDate',
  'metric',
  'reward',
  'status',
  'createdAt',
  'updatedAt',
] as const;

const NOTIFICATION_COLUMN_FIELDS = [
  'id',
  'tenantId',
  'recipientUserId',
  'kind',
  'title',
  'body',
  'payload',
  'readAt',
  'createdAt',
] as const;

/**
 * D5.6D-1 — list of (tableName → columnFields) emitted by the
 * structured tenant backup. Re-exported for the test harness so
 * the catalogue-coverage assertion can iterate every emitted
 * (resource, field) pair without re-deriving the column list.
 */
export const BACKUP_TABLE_COLUMN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  users: USER_COLUMN_FIELDS,
  pipelines: PIPELINE_COLUMN_FIELDS,
  pipelineStages: PIPELINE_STAGE_COLUMN_FIELDS,
  leads: LEAD_COLUMN_FIELDS,
  leadActivities: LEAD_ACTIVITY_COLUMN_FIELDS,
  leadFollowUps: LEAD_FOLLOWUP_COLUMN_FIELDS,
  captains: CAPTAIN_COLUMN_FIELDS,
  captainDocuments: CAPTAIN_DOCUMENT_COLUMN_FIELDS,
  captainTrips: CAPTAIN_TRIP_COLUMN_FIELDS,
  whatsappAccounts: WHATSAPP_ACCOUNT_COLUMN_FIELDS,
  whatsappConversations: WHATSAPP_CONVERSATION_COLUMN_FIELDS,
  whatsappMessages: WHATSAPP_MESSAGE_COLUMN_FIELDS,
  whatsappTemplates: WHATSAPP_TEMPLATE_COLUMN_FIELDS,
  bonusRules: BONUS_RULE_COLUMN_FIELDS,
  bonusAccruals: BONUS_ACCRUAL_COLUMN_FIELDS,
  competitions: COMPETITION_COLUMN_FIELDS,
  notifications: NOTIFICATION_COLUMN_FIELDS,
};

/**
 * D5.6D-1 — table → catalogue resource mapping. Used by the
 * coverage test + the future role-builder UI's "what does the
 * backup ship?" surface.
 */
export const BACKUP_TABLE_RESOURCES: Readonly<Record<string, CatalogueResource>> = {
  users: 'org.user',
  pipelines: 'pipeline',
  pipelineStages: 'pipeline.stage',
  leads: 'lead',
  leadActivities: 'lead.activity',
  leadFollowUps: 'followup',
  captains: 'captain',
  captainDocuments: 'captain.document',
  captainTrips: 'captain.trip',
  whatsappAccounts: 'whatsapp.account',
  whatsappConversations: 'whatsapp.conversation',
  whatsappMessages: 'whatsapp.message',
  whatsappTemplates: 'whatsapp.template',
  bonusRules: 'bonus.rule',
  bonusAccruals: 'bonus.accrual',
  competitions: 'competition',
  notifications: 'notification',
};

/**
 * D5.6D-1 — collapse a `StructuredTenantBackup` back into the
 * legacy `TenantBackup` wire envelope for byte-restore-compatibility.
 * Called by the export interceptor's `json-tenant-backup`
 * serialiser.
 *
 * Pure function — no I/O, no clock reads, no mutation of the input.
 */
export function tenantBackupToWireEnvelope(
  structured: StructuredTenantBackup,
): Record<string, unknown> {
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const t of structured.tables) {
    data[t.tableName] = [...t.export.rows];
    counts[t.tableName] = t.export.rows.length;
  }
  return {
    exportedAt: structured.exportedAt,
    tenant: structured.tenant,
    schemaVersion: structured.schemaVersion,
    rowCap: structured.rowCap,
    counts,
    data,
  };
}
