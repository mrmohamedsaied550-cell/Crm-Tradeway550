import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { normalizeE164WithDefault } from '../crm/phone.util';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { requireTenantId } from '../tenants/tenant-context';
import {
  AdapterError,
  type AdapterContext,
  type AdapterTestConnectionResult,
  type PartnerSheetAdapter,
  type RawPartnerRow,
} from './adapters/partner-sheet-adapter';
import { GoogleSheetsAdapter } from './adapters/google-sheets-adapter';
import { ManualUploadAdapter, type ManualUploadContext } from './adapters/manual-upload-adapter';
import { PartnerCredentialsCryptoService } from './partner-credentials-crypto.service';

/**
 * Phase D4 — D4.3: PartnerSyncService — orchestration brain.
 *
 * Single owner of the sync lifecycle:
 *   1. Validate flag + readiness (phone mapping required).
 *   2. Acquire the per-source lock (`last_sync_status='running'`).
 *   3. Resolve the adapter for the source's `adapter` field.
 *   4. Decrypt credentials in-memory (never persisted, never
 *      returned).
 *   5. Resolve tab via discovery rule.
 *   6. Open `PartnerSnapshot { status: 'running' }`.
 *   7. Adapter `fetchRows` → for each row: apply mappings +
 *      transforms → resolve `contactId` from phone → insert
 *      `PartnerRecord`. `rawRow` is ALWAYS preserved.
 *   8. Close snapshot — `success` (zero errors) /
 *      `partial` (some errors but ≥ 1 import) / `failed` (zero
 *      imports OR adapter exception).
 *   9. Update `partner_sources.last_sync_*` + audit row.
 *
 * Concurrency:
 *   • One sync per `(tenant, source)` at a time. The lock is the
 *     row's `last_sync_status='running'` flag, set + checked
 *     inside a single `withTenant` tx.
 *   • Stale lock recovery: any `last_sync_status='running'` whose
 *     started_at is older than `STALE_LOCK_MS` is treated as
 *     abandoned and forcibly closed as `failed`.
 *
 * Errors:
 *   • Controller layer: throw 400/404/409 with closed codes.
 *   • Per-row errors: counted into `rowsError`, snapshot lands as
 *     `partial`. Never abort the whole sync because of one row.
 *   • Adapter exceptions: snapshot lands as `failed` with the
 *     adapter's error message in `source_metadata.errorName`.
 */
@Injectable()
export class PartnerSyncService {
  private readonly logger = new Logger(PartnerSyncService.name);

  /**
   * Stale-lock window. A `running` snapshot older than this is
   * presumed orphaned (e.g. process crash) and forcibly closed as
   * failed before a new run starts. Generous because the only
   * downside of a longer window is a longer wait before a stuck
   * lock auto-resolves.
   */
  private static readonly STALE_LOCK_MS = 30 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: PartnerCredentialsCryptoService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly googleSheets: GoogleSheetsAdapter,
    private readonly manualUpload: ManualUploadAdapter,
  ) {}

  // ─── public API ────────────────────────────────────────────────

  async testConnection(partnerSourceId: string): Promise<AdapterTestConnectionResult> {
    const tenantId = requireTenantId();
    const source = await this.loadActiveSource(tenantId, partnerSourceId);
    const adapter = this.resolveAdapter(source.adapter);
    const ctx = await this.buildAdapterContext(source);
    try {
      const result = await adapter.testConnection(ctx);
      // Update connectionStatus + lastTestedAt — even on
      // not_wired we record the operator's intent so the source
      // detail page surfaces the latest probe time.
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.partnerSource.update({
          where: { id: partnerSourceId },
          data: {
            connectionStatus: result.status,
            lastTestedAt: new Date(),
          },
        });
        await this.audit.writeInTx(tx, tenantId, {
          action: 'partner.source.connection_tested',
          entityType: 'partner_source',
          entityId: partnerSourceId,
          actorUserId: null,
          payload: { status: result.status, message: result.message } as Prisma.InputJsonValue,
        });
      });
      return result;
    } catch (err) {
      const status = err instanceof AdapterError ? this.adapterErrorToStatus(err) : 'unknown';
      const message =
        err instanceof AdapterError ? err.message : `Test failed: ${(err as Error).message}`;
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.partnerSource.update({
          where: { id: partnerSourceId },
          data: { connectionStatus: status, lastTestedAt: new Date() },
        });
      });
      this.logger.warn(`partner-source ${partnerSourceId} test failed: ${status}`);
      return { status, message };
    }
  }

  async runSync(
    partnerSourceId: string,
    opts: {
      trigger: 'manual' | 'manual_upload' | 'cron';
      actorUserId?: string | null;
      manualCsv?: string;
    },
  ): Promise<RunSyncResult> {
    const tenantId = requireTenantId();

    // Pre-flight reads happen outside the lock acquire so the
    // common "phone-mapping missing" error doesn't leave a
    // half-open lock.
    const source = await this.loadActiveSource(tenantId, partnerSourceId);
    if (!source.isActive) {
      throw new BadRequestException({
        code: 'partner.source.disabled',
        message: 'Partner source is disabled.',
      });
    }
    if (opts.trigger === 'manual_upload' && source.adapter !== 'manual_upload') {
      throw new BadRequestException({
        code: 'partner.sync.upload_not_supported',
        message: 'This partner source does not accept manual uploads.',
      });
    }
    if (opts.trigger === 'manual_upload' && !opts.manualCsv) {
      throw new BadRequestException({
        code: 'partner.adapter.invalid_payload',
        message: 'Manual upload requires a non-empty CSV payload.',
      });
    }
    if (source.adapter === 'manual_upload' && opts.trigger === 'cron') {
      // Defensive: cron should never schedule a manual-upload
      // source, but if it does we skip cleanly.
      return { wasSkipped: true, reason: 'manual_upload_not_scheduleable' };
    }

    const mappings = await this.loadMappings(tenantId, partnerSourceId);
    if (!mappings.some((m) => m.targetField === 'phone')) {
      throw new BadRequestException({
        code: 'partner.mapping.phone_required',
        message: 'Phone mapping is required before syncing.',
      });
    }

    // Acquire lock + open snapshot in one tx so concurrent triggers
    // see consistent state.
    const acquired = await this.acquireLockAndOpenSnapshot(
      tenantId,
      partnerSourceId,
      opts.trigger,
      opts.actorUserId ?? null,
    );

    const adapter = this.resolveAdapter(source.adapter);
    const ctx: ManualUploadContext = {
      ...(await this.buildAdapterContext(source)),
      ...(opts.manualCsv !== undefined && { manualCsv: opts.manualCsv }),
    };

    let resolvedTabName: string | null = null;
    try {
      resolvedTabName = await this.resolveTabName(adapter, source, ctx);
    } catch (err) {
      await this.closeSnapshotFailed(
        tenantId,
        partnerSourceId,
        acquired.snapshotId,
        err,
        opts.actorUserId ?? null,
      );
      throw this.adapterErrorToHttp(err);
    }

    let rows: RawPartnerRow[] = [];
    try {
      rows = await adapter.fetchRows(ctx, { tabName: resolvedTabName });
    } catch (err) {
      await this.closeSnapshotFailed(
        tenantId,
        partnerSourceId,
        acquired.snapshotId,
        err,
        opts.actorUserId ?? null,
        resolvedTabName,
      );
      throw this.adapterErrorToHttp(err);
    }

    const settings = await this.tenantSettings.getCurrent();
    const summary = await this.persistRows(
      tenantId,
      partnerSourceId,
      acquired.snapshotId,
      rows,
      mappings,
      settings.defaultDialCode,
    );

    const finalStatus =
      summary.imported === 0 ? 'failed' : summary.errors === 0 ? 'success' : 'partial';

    await this.closeSnapshotFinal(
      tenantId,
      partnerSourceId,
      acquired.snapshotId,
      finalStatus,
      summary,
      resolvedTabName,
      opts.actorUserId ?? null,
    );

    return {
      wasSkipped: false,
      snapshotId: acquired.snapshotId,
      status: finalStatus,
      total: summary.total,
      imported: summary.imported,
      skipped: summary.skipped,
      errors: summary.errors,
      resolvedTabName,
    };
  }

  // ─── adapter wiring ───────────────────────────────────────────

  private resolveAdapter(adapterCode: string): PartnerSheetAdapter {
    if (adapterCode === 'google_sheets') return this.googleSheets;
    if (adapterCode === 'manual_upload') return this.manualUpload;
    throw new BadRequestException({
      code: 'partner.adapter.unknown',
      message: `Unknown adapter: ${adapterCode}`,
    });
  }

  private async buildAdapterContext(source: PartnerSourceRow): Promise<AdapterContext> {
    let credentials: Record<string, unknown> | null = null;
    if (source.encryptedCredentials) {
      try {
        const decrypted = this.crypto.decrypt(source.encryptedCredentials);
        if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
          credentials = decrypted as Record<string, unknown>;
        }
      } catch (err) {
        this.logger.warn(
          `partner-source ${source.id} credential decrypt failed: ${(err as Error).name}`,
        );
        // Don't surface the cryptographic detail; the adapter
        // will see `credentials = null` and surface a typed
        // auth_failed.
      }
    }
    return {
      partnerSourceId: source.id,
      adapter: source.adapter,
      credentials,
      tabMode: source.tabMode,
      fixedTabName: source.fixedTabName,
      tabDiscoveryRule: source.tabDiscoveryRule,
    };
  }

  // ─── tab discovery ────────────────────────────────────────────

  private async resolveTabName(
    adapter: PartnerSheetAdapter,
    source: PartnerSourceRow,
    ctx: AdapterContext,
  ): Promise<string | null> {
    if (source.adapter === 'manual_upload') return null;
    if (source.tabMode === 'fixed') {
      return source.fixedTabName;
    }
    // new_per_period — list tabs and apply rule.
    const tabs = await adapter.listTabs(ctx);
    const rule = source.tabDiscoveryRule as TabDiscoveryRulePersisted | null;
    if (!rule) {
      throw new AdapterError(
        'partner.adapter.invalid_payload',
        'tabDiscoveryRule missing for new_per_period source.',
      );
    }
    if (rule.kind === 'most_recently_modified') {
      const sorted = [...tabs].sort((a, b) => {
        const am = a.modifiedAt ? Date.parse(a.modifiedAt) : 0;
        const bm = b.modifiedAt ? Date.parse(b.modifiedAt) : 0;
        return bm - am;
      });
      const top = sorted[0];
      if (!top) {
        throw new AdapterError('partner.adapter.tab_not_found', 'No tabs found on partner sheet.');
      }
      return top.name;
    }
    // name_pattern — extract YYYY-MM-DD or similar; pick the latest
    // matching tab. The minimal rule we support: replace
    // 'YYYY-MM-DD' / 'YYYYMMDD' / 'YYYY' placeholders with regex
    // and pick the lexicographically max match (works for ISO
    // date suffixes).
    const pattern = String(rule.pattern ?? '').trim();
    if (!pattern) {
      throw new AdapterError(
        'partner.adapter.invalid_payload',
        'tabDiscoveryRule.pattern is empty.',
      );
    }
    const regex = patternToRegex(pattern);
    const matching = tabs.map((t) => t.name).filter((n) => regex.test(n));
    if (matching.length === 0) {
      throw new AdapterError(
        'partner.adapter.tab_not_found',
        `No tab matches pattern "${pattern}".`,
      );
    }
    matching.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    return matching[0] ?? null;
  }

  // ─── lock + snapshot helpers ──────────────────────────────────

  private async acquireLockAndOpenSnapshot(
    tenantId: string,
    partnerSourceId: string,
    trigger: 'manual' | 'manual_upload' | 'cron',
    actorUserId: string | null,
  ): Promise<{ snapshotId: string }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const source = await tx.partnerSource.findFirst({
        where: { id: partnerSourceId, tenantId },
      });
      if (!source) {
        throw new NotFoundException({
          code: 'partner.source.not_found',
          message: `Partner source not found: ${partnerSourceId}`,
        });
      }
      if (source.lastSyncStatus === 'running') {
        // Stale-lock recovery: if the latest running snapshot is
        // older than the stale window, force-close it as failed
        // and let the new run proceed.
        const running = await tx.partnerSnapshot.findFirst({
          where: { tenantId, partnerSourceId, status: 'running' },
          orderBy: { startedAt: 'desc' },
        });
        const isStale =
          running !== null &&
          Date.now() - running.startedAt.getTime() > PartnerSyncService.STALE_LOCK_MS;
        if (running && isStale) {
          await tx.partnerSnapshot.update({
            where: { id: running.id },
            data: {
              status: 'failed',
              completedAt: new Date(),
              sourceMetadata: {
                errorName: 'stale_lock_recovered',
                errorMessage: 'Forced closure: previous run did not complete within stale window.',
              } as Prisma.InputJsonValue,
            },
          });
          this.logger.warn(
            `partner-source ${partnerSourceId} stale running lock recovered (${running.id}).`,
          );
        } else if (running && !isStale) {
          throw new ConflictException({
            code: 'partner.sync.already_running',
            message: 'A sync is already running for this partner source.',
          });
        }
      }
      const snapshot = await tx.partnerSnapshot.create({
        data: {
          tenantId,
          partnerSourceId,
          status: 'running',
          sourceMetadata: { trigger } as Prisma.InputJsonValue,
          ...(actorUserId !== null && { triggeredByUserId: actorUserId }),
        },
      });
      await tx.partnerSource.update({
        where: { id: partnerSourceId },
        data: { lastSyncStatus: 'running' },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'partner.sync.started',
        entityType: 'partner_snapshot',
        entityId: snapshot.id,
        actorUserId,
        payload: { partnerSourceId, trigger } as Prisma.InputJsonValue,
      });
      return { snapshotId: snapshot.id };
    });
  }

  private async closeSnapshotFinal(
    tenantId: string,
    partnerSourceId: string,
    snapshotId: string,
    status: 'success' | 'partial' | 'failed',
    summary: PersistRowsSummary,
    resolvedTabName: string | null,
    actorUserId: string | null,
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const completedAt = new Date();
      const sourceMetadata: Prisma.InputJsonValue = {
        resolvedTabName,
        rowsTotal: summary.total,
        rowsImported: summary.imported,
        rowsSkipped: summary.skipped,
        rowsError: summary.errors,
      } as Prisma.InputJsonValue;
      await tx.partnerSnapshot.update({
        where: { id: snapshotId },
        data: {
          status,
          completedAt,
          rowsTotal: summary.total,
          rowsImported: summary.imported,
          rowsSkipped: summary.skipped,
          rowsError: summary.errors,
          sourceMetadata,
        },
      });
      await tx.partnerSource.update({
        where: { id: partnerSourceId },
        data: { lastSyncAt: completedAt, lastSyncStatus: status },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'partner.sync.completed',
        entityType: 'partner_snapshot',
        entityId: snapshotId,
        actorUserId,
        payload: {
          partnerSourceId,
          status,
          rowsTotal: summary.total,
          rowsImported: summary.imported,
          rowsSkipped: summary.skipped,
          rowsError: summary.errors,
          resolvedTabName,
        } as Prisma.InputJsonValue,
      });
    });
  }

  private async closeSnapshotFailed(
    tenantId: string,
    partnerSourceId: string,
    snapshotId: string,
    err: unknown,
    actorUserId: string | null,
    resolvedTabName: string | null = null,
  ): Promise<void> {
    const errorName = err instanceof AdapterError ? err.code : (err as Error).name;
    const errorMessage = (err as Error).message ?? 'unknown';
    await this.prisma.withTenant(tenantId, async (tx) => {
      const completedAt = new Date();
      await tx.partnerSnapshot.update({
        where: { id: snapshotId },
        data: {
          status: 'failed',
          completedAt,
          sourceMetadata: {
            resolvedTabName,
            errorName,
            errorMessage,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.partnerSource.update({
        where: { id: partnerSourceId },
        data: { lastSyncAt: completedAt, lastSyncStatus: 'failed' },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'partner.sync.failed',
        entityType: 'partner_snapshot',
        entityId: snapshotId,
        actorUserId,
        payload: { partnerSourceId, errorName } as Prisma.InputJsonValue,
      });
    });
  }

  // ─── row persistence ──────────────────────────────────────────

  private async persistRows(
    tenantId: string,
    partnerSourceId: string,
    snapshotId: string,
    rows: RawPartnerRow[],
    mappings: PartnerMappingRow[],
    defaultDialCode: string,
  ): Promise<PersistRowsSummary> {
    let imported = 0;
    let skipped = 0;
    let errors = 0;
    const total = rows.length;

    // Pre-build a quick lookup for mapping resolution.
    const byTarget = new Map<string, PartnerMappingRow>();
    for (const m of mappings) byTarget.set(m.targetField, m);

    // Resolve all phones in batch — one query for the whole snapshot
    // is much cheaper than N findUnique calls. Phones not present
    // simply yield NULL contactId at write time.
    const phonesNeeded = new Set<string>();
    type ParsedRow = {
      phone: string | null;
      partnerStatus: string | null;
      partnerActiveDate: Date | null;
      partnerDftDate: Date | null;
      tripCount: number | null;
      lastTripAt: Date | null;
      raw: RawPartnerRow;
      hasError: boolean;
    };
    const parsed: ParsedRow[] = [];
    for (const raw of rows) {
      try {
        const phoneRaw = byTarget.get('phone')
          ? (raw[byTarget.get('phone')!.sourceColumn] ?? '')
          : '';
        let phone: string | null = null;
        if (phoneRaw.trim().length > 0) {
          try {
            const transform = byTarget.get('phone')?.transformKind ?? 'to_e164';
            phone =
              transform === 'to_e164'
                ? normalizeE164WithDefault(phoneRaw, defaultDialCode)
                : phoneRaw.trim();
            if (phone) phonesNeeded.add(phone);
          } catch {
            phone = null;
          }
        }
        const partnerStatus = applyOptional(byTarget.get('partner_status'), raw, 'string');
        const partnerActiveDate = applyOptional(
          byTarget.get('partner_active_date'),
          raw,
          'date',
        ) as Date | null;
        const partnerDftDate = applyOptional(
          byTarget.get('partner_dft_date'),
          raw,
          'date',
        ) as Date | null;
        const tripCount = applyOptional(byTarget.get('trip_count'), raw, 'int') as number | null;
        const lastTripAt = applyOptional(byTarget.get('last_trip_at'), raw, 'date') as Date | null;
        // Required fields: phone is recommended-required; if the
        // mapping marks it `isRequired` and the value is null, the
        // row counts as an error.
        let hasError = false;
        for (const m of mappings) {
          if (!m.isRequired) continue;
          if (m.targetField === 'phone' && !phone) hasError = true;
          if (m.targetField !== 'phone') {
            const cell = raw[m.sourceColumn];
            if (cell === undefined || cell === null || `${cell}`.trim().length === 0) {
              hasError = true;
            }
          }
        }
        parsed.push({
          phone,
          partnerStatus: partnerStatus as string | null,
          partnerActiveDate,
          partnerDftDate,
          tripCount,
          lastTripAt,
          raw,
          hasError,
        });
        if (hasError) errors += 1;
      } catch (err) {
        // Defence-in-depth: never let a single bad row poison
        // the whole sync. Count it and continue.
        errors += 1;
        parsed.push({
          phone: null,
          partnerStatus: null,
          partnerActiveDate: null,
          partnerDftDate: null,
          tripCount: null,
          lastTripAt: null,
          raw,
          hasError: true,
        });
        this.logger.debug(`partner row parse error: ${(err as Error).message}`);
      }
    }

    // Look up all matching contacts in one go.
    const contactByPhone = new Map<string, string>();
    if (phonesNeeded.size > 0) {
      await this.prisma.withTenant(tenantId, async (tx) => {
        const found = await tx.contact.findMany({
          where: { tenantId, phone: { in: Array.from(phonesNeeded) } },
          select: { id: true, phone: true },
        });
        for (const c of found) contactByPhone.set(c.phone, c.id);
      });
    }

    // Persist all rows in chunks to avoid Postgres parameter
    // pressure on very large CSVs. 500 rows per createMany is a
    // safe default.
    await this.prisma.withTenant(tenantId, async (tx) => {
      const CHUNK = 500;
      for (let i = 0; i < parsed.length; i += CHUNK) {
        const slice = parsed.slice(i, i + CHUNK);
        await tx.partnerRecord.createMany({
          data: slice.map((p) => ({
            tenantId,
            snapshotId,
            partnerSourceId,
            contactId: p.phone ? (contactByPhone.get(p.phone) ?? null) : null,
            phone: p.phone,
            partnerStatus: p.partnerStatus,
            partnerActiveDate: p.partnerActiveDate,
            partnerDftDate: p.partnerDftDate,
            tripCount: p.tripCount,
            lastTripAt: p.lastTripAt,
            rawRow: p.raw as Prisma.InputJsonValue,
          })),
        });
        for (const p of slice) {
          if (p.hasError) {
            // already counted above
          } else if (p.phone) {
            imported += 1;
          } else {
            skipped += 1;
          }
        }
      }
    });

    return { total, imported, skipped, errors };
  }

  // ─── lookup helpers ───────────────────────────────────────────

  private async loadActiveSource(
    tenantId: string,
    partnerSourceId: string,
  ): Promise<PartnerSourceRow> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerSource.findFirst({ where: { id: partnerSourceId, tenantId } }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'partner.source.not_found',
        message: `Partner source not found: ${partnerSourceId}`,
      });
    }
    return row as PartnerSourceRow;
  }

  private async loadMappings(
    tenantId: string,
    partnerSourceId: string,
  ): Promise<PartnerMappingRow[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerFieldMapping.findMany({
        where: { tenantId, partnerSourceId },
      }),
    ) as unknown as Promise<PartnerMappingRow[]>;
  }

  private adapterErrorToStatus(err: AdapterError): string {
    switch (err.code) {
      case 'partner.adapter.auth_failed':
        return 'auth_failed';
      case 'partner.adapter.sheet_not_found':
        return 'sheet_not_found';
      case 'partner.adapter.tab_not_found':
        return 'sheet_not_found';
      case 'partner.adapter.not_wired':
        return 'not_wired';
      default:
        return 'unknown';
    }
  }

  private adapterErrorToHttp(err: unknown): Error {
    if (err instanceof AdapterError) {
      return new BadRequestException({ code: err.code, message: err.message });
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

// ─── helpers ──────────────────────────────────────────────────────

interface PartnerSourceRow {
  id: string;
  adapter: string;
  encryptedCredentials: string | null;
  tabMode: string;
  fixedTabName: string | null;
  tabDiscoveryRule: unknown;
  isActive: boolean;
}

interface PartnerMappingRow {
  id: string;
  partnerSourceId: string;
  sourceColumn: string;
  targetField: string;
  transformKind: string | null;
  transformArgs: unknown;
  isRequired: boolean;
  displayOrder: number;
}

interface PersistRowsSummary {
  total: number;
  imported: number;
  skipped: number;
  errors: number;
}

export interface RunSyncResult {
  /** True when the run was skipped before any snapshot was opened
   *  (e.g. cron triggered against a manual-upload source). All
   *  other fields are absent in that case. */
  wasSkipped: boolean;
  reason?: string;
  snapshotId?: string;
  status?: 'success' | 'partial' | 'failed';
  total?: number;
  imported?: number;
  skipped?: number;
  errors?: number;
  resolvedTabName?: string | null;
}

interface TabDiscoveryRulePersisted {
  kind: 'name_pattern' | 'most_recently_modified';
  pattern?: string;
}

/**
 * Apply an optional cell transform. Empty / missing cells become
 * NULL; transform failures also become NULL — the row error
 * accounting in the caller takes care of "required field missing"
 * via `isRequired`.
 */
function applyOptional(
  mapping: PartnerMappingRow | undefined,
  raw: RawPartnerRow,
  kind: 'string' | 'date' | 'int',
): string | number | Date | null {
  if (!mapping) return null;
  const cell = raw[mapping.sourceColumn];
  if (cell === undefined || cell === null) return null;
  const trimmed = `${cell}`.trim();
  if (trimmed.length === 0) return null;
  const transform = mapping.transformKind ?? 'passthrough';
  try {
    if (kind === 'string') {
      return transform === 'lowercase' ? trimmed.toLowerCase() : trimmed;
    }
    if (kind === 'int') {
      const n = Number.parseInt(trimmed, 10);
      return Number.isFinite(n) ? n : null;
    }
    if (kind === 'date') {
      const t = Date.parse(trimmed);
      return Number.isNaN(t) ? null : new Date(t);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Convert a tab-name pattern with `YYYY-MM-DD` / `YYYYMMDD` /
 * `YYYY` placeholders into a regex. Anything else escapes
 * literally.
 */
function patternToRegex(pattern: string): RegExp {
  // Replace placeholders with capture groups, then escape the
  // remaining literal chars.
  let regex = '';
  let i = 0;
  const placeholders: Array<{ token: string; pattern: string }> = [
    { token: 'YYYY-MM-DD', pattern: '\\d{4}-\\d{2}-\\d{2}' },
    { token: 'YYYYMMDD', pattern: '\\d{8}' },
    { token: 'YYYY', pattern: '\\d{4}' },
  ];
  while (i < pattern.length) {
    const slice = pattern.slice(i);
    const hit = placeholders.find((p) => slice.startsWith(p.token));
    if (hit) {
      regex += hit.pattern;
      i += hit.token.length;
    } else {
      regex += pattern[i]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`);
}
