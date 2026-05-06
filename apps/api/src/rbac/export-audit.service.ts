import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';

import type { CatalogueResource } from './field-catalogue.registry';

/**
 * Phase D5 — D5.6A: metadata-only audit for governed exports.
 *
 * Writes one `audit_events` row per export request, action
 * `<resource>.export.completed`. The payload records the
 * structural footprint of the download — endpoint, filters,
 * columns shipped, columns redacted, row count, byte count, flag
 * state — but NEVER any exported row data. Forensic enough to
 * prove "user X downloaded N rows of partner reconciliation with
 * columns A/B/C at time T", small enough to keep the audit table
 * cheap.
 *
 * Failure path: best-effort. The underlying `AuditService.writeEvent`
 * already swallows write failures (so an audit outage never
 * breaks the parent download). This wrapper keeps the same
 * semantics — the operator gets the file even if the audit row
 * fails to land.
 *
 * D5.6A registers the service. D5.6B is the first chunk to call
 * it from a real export controller (via the ExportInterceptor).
 */

export interface ExportAuditInput {
  /**
   * Catalogue resource the export reports against. Becomes the
   * action prefix — `partner.reconciliation.export.completed`,
   * `report.export.completed`, etc.
   */
  readonly resource: CatalogueResource;
  /**
   * Acting user's id. Mirrors the actorUserId field on every
   * other audit row.
   */
  readonly actorUserId: string;
  /**
   * HTTP endpoint the request hit — e.g. `GET /partner/reconciliation/export.csv`.
   * Used by /admin/audit chips to group "all exports of resource X".
   */
  readonly endpoint: string;
  /**
   * Sanitised query / filter snapshot. Pass the parsed DTO; the
   * audit row stores it as-is (so cross-checking which slice of
   * data was downloaded is possible). Callers MUST pre-sanitise
   * any filter that could itself contain PII — partner-source
   * IDs, lead UUIDs, date ranges are fine; an open-text search
   * phrase is not.
   */
  readonly filters: Readonly<Record<string, unknown>>;
  /** Column keys that survived redaction and shipped to the client. */
  readonly columnsExported: readonly string[];
  /** Column keys dropped by the redactor for this caller. */
  readonly columnsRedacted: readonly string[];
  /** Row count after the export ran (no rows are ever dropped by the redactor). */
  readonly rowCount: number;
  /** Size of the serialised payload in bytes. */
  readonly bytesShipped: number;
  /**
   * `D5_DYNAMIC_PERMISSIONS_V1` value at the moment of the export.
   * `'on'` / `'off'`. Lets the audit feed distinguish flag-on
   * shadow-mode exports from real-redaction exports.
   */
  readonly flagState: 'on' | 'off';

  // ─── D5.6D-1 — per-table fields for tenant backup exports ───
  //
  // Optional. Set ONLY by the tenant-backup export path; absent
  // for single-table exports (lead / partner / report). The audit
  // payload includes them when present so an admin reviewing a
  // tenant.export.completed row can see "users had 12 rows / 3
  // columns redacted; leads had 2k rows / 0 columns redacted"
  // without re-running the export. All values are STRUCTURAL
  // (table names, row counts, column keys) — never raw row data.

  /** Backup table names in the order they were emitted. */
  readonly tableNames?: readonly string[];
  /** Row count per table. Sum equals `rowCount`. */
  readonly rowCountByTable?: Readonly<Record<string, number>>;
  /** Column keys per table that survived redaction. */
  readonly columnsExportedByTable?: Readonly<Record<string, readonly string[]>>;
  /** Column keys per table dropped by the redactor. Empty maps in D5.6D-1. */
  readonly columnsRedactedByTable?: Readonly<Record<string, readonly string[]>>;
  /**
   * D5.6D-2 — column keys per table that were rescued from a deny
   * rule because they are restore-critical. Empty maps when the
   * deny list never tried to target a critical column.
   */
  readonly protectedColumnsByTable?: Readonly<Record<string, readonly string[]>>;
  /**
   * D5.6D-2 — `true` when at least one column was actually dropped
   * across all backup tables. Mirrors the wire envelope flag.
   */
  readonly redacted?: boolean;
  /**
   * D5.6D-2 — `false` when `redacted` is true. Mirrors the wire
   * envelope's `restorable` flag so an admin reviewing the audit
   * feed can spot non-restorable backups without re-reading the
   * file.
   */
  readonly restorable?: boolean;
}

@Injectable()
export class ExportAuditService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Write the audit row. Returns the synthesised entityId so a
   * caller (typically the interceptor) can echo it in a response
   * header for support-side correlation.
   */
  async recordExport(input: ExportAuditInput): Promise<{ entityId: string }> {
    const entityId = randomUUID();
    const payload: Record<string, Prisma.InputJsonValue> = {
      endpoint: input.endpoint,
      filters: input.filters as Prisma.InputJsonValue,
      columnsExported: [...input.columnsExported],
      columnsRedacted: [...input.columnsRedacted],
      rowCount: input.rowCount,
      bytesShipped: input.bytesShipped,
      flagState: input.flagState,
    };

    // D5.6D-1 — backfill per-table audit metadata for tenant
    // backups. Single-table exports leave these undefined so the
    // payload stays compact for the common case.
    if (input.tableNames !== undefined) {
      payload['tableNames'] = [...input.tableNames];
    }
    if (input.rowCountByTable !== undefined) {
      payload['rowCountByTable'] = { ...input.rowCountByTable };
    }
    if (input.columnsExportedByTable !== undefined) {
      payload['columnsExportedByTable'] = Object.fromEntries(
        Object.entries(input.columnsExportedByTable).map(([k, v]) => [k, [...v]]),
      );
    }
    if (input.columnsRedactedByTable !== undefined) {
      payload['columnsRedactedByTable'] = Object.fromEntries(
        Object.entries(input.columnsRedactedByTable).map(([k, v]) => [k, [...v]]),
      );
    }
    if (input.protectedColumnsByTable !== undefined) {
      payload['protectedColumnsByTable'] = Object.fromEntries(
        Object.entries(input.protectedColumnsByTable).map(([k, v]) => [k, [...v]]),
      );
    }
    if (input.redacted !== undefined) {
      payload['redacted'] = input.redacted;
    }
    if (input.restorable !== undefined) {
      payload['restorable'] = input.restorable;
    }

    await this.audit.writeEvent({
      action: `${input.resource}.export.completed`,
      entityType: 'export',
      entityId,
      actorUserId: input.actorUserId,
      payload: payload as Prisma.InputJsonValue,
    });

    return { entityId };
  }
}
