import { Injectable } from '@nestjs/common';

import { isRestoreCritical } from '../backup/backup.service';

import type {
  ExportColumn,
  ExportRedactionOutcome,
  StructuredExport,
  StructuredTenantBackup,
  StructuredTenantBackupTable,
  TenantBackupRedactionOutcome,
} from './export-contract';
import { REDACTION_FIELD_KEY } from './export-contract';
import { isRedactable, type CatalogueResource } from './field-catalogue.registry';
import type { ResolvedPermissions } from './permission-resolver.service';
import type { ExportGateOptions } from './export-gate.decorator';

/**
 * Phase D5 — D5.6A: pure column-level redaction service.
 *
 * Walks the `StructuredExport.columns` list, looks up each column's
 * `(resource, field)` pair in `resolved.deniedReadFieldsByResource`,
 * and drops the column when the rule says to. Mixed-resource exports
 * work transparently: a `partner.reconciliation` export's `phone`
 * column (declared as `resource: 'lead', field: 'phone'`) is stripped
 * by a `lead.phone` deny rule, even though the export's primary
 * resource is `partner.reconciliation`.
 *
 * Bypass paths (return `bypassed: true`, structure unchanged):
 *
 *   1. Super-admin — `resolved.role.code === 'super_admin'`.
 *   2. Empty deny lists across every resource referenced by a
 *      column — fast path that avoids re-walking rows when nothing
 *      would be stripped.
 *
 * Hard rules:
 *
 *   • Non-redactable columns survive — `column.redactable === false`
 *     OR `isRedactable(column.resource, column.field) === false`
 *     (the catalogue's per-(resource, field) flag). Lead.id /
 *     captain.id / contact.id columns therefore always survive
 *     even when an admin persists a deny rule.
 *
 *   • Row count is preserved exactly. The redactor never drops
 *     rows; only column families.
 *
 *   • The function is pure — no DB calls, no clock reads, no
 *     mutation of the input. Returns a fresh `StructuredExport`
 *     with a new `columns` list and rows whose dropped keys are
 *     deleted (deep clone via Object.assign + key delete; row
 *     identities differ from the input).
 *
 *   • The audit metadata (`columnsExported`, `columnsRedacted`)
 *     is computed once during the same walk so the audit service
 *     can persist it without a re-scan.
 *
 * D5.6A defines the contract. D5.6B-D consume it via the
 * ExportInterceptor.
 */

@Injectable()
export class ExportRedactionService {
  /**
   * Apply the role's deny rules to a structured export.
   *
   * Behaviour:
   *   • super_admin → bypass; structure unchanged.
   *   • format 'csv' / 'json' → column-level redaction:
   *       — column with deny rule + non-redactable → kept.
   *       — column with deny rule + redactable → dropped from
   *         `columns`; the matching `column.key` is deleted from
   *         every row.
   *   • format 'csv-keyvalue' → row-level redaction (D5.6C):
   *       — each row may carry a private `__field` metadata; if
   *         the value is in the gate's `primary` resource deny
   *         list AND `isRedactable(primary, field)` allows it,
   *         the row is dropped from output. The `__field` key is
   *         stripped from kept rows before serialisation.
   *
   * `gate` is required so the redactor can route the
   * csv-keyvalue lookup at `gate.primary`. For column-level
   * formats the gate is unused at runtime (each column carries
   * its own resource), kept in the signature for symmetry +
   * future cross-format extensions.
   */
  redactColumns(
    structured: StructuredExport,
    resolved: ResolvedPermissions,
    gate: ExportGateOptions,
  ): ExportRedactionOutcome {
    // 1. Super-admin bypass — mirrors PermissionResolverService.
    if (resolved.role.code === 'super_admin') {
      const allKeys =
        structured.format === 'csv-keyvalue'
          ? rowIdentifiersOf(structured)
          : structured.columns.map((c) => c.key);
      return outcome(structured, allKeys, [], true);
    }

    if (structured.format === 'csv-keyvalue') {
      return this.redactKeyValueRows(structured, resolved, gate.primary);
    }

    return this.redactColumnLevel(structured, resolved);
  }

  // ─── column-level (csv / json) ──────────────────────────────

  private redactColumnLevel(
    structured: StructuredExport,
    resolved: ResolvedPermissions,
  ): ExportRedactionOutcome {
    const dropKeys = new Set<string>();
    for (const column of structured.columns) {
      if (this.shouldDropColumn(column, resolved)) {
        dropKeys.add(column.key);
      }
    }

    if (dropKeys.size === 0) {
      return outcome(
        structured,
        structured.columns.map((c) => c.key),
        [],
        false,
      );
    }

    const keptColumns: ExportColumn[] = [];
    for (const column of structured.columns) {
      if (!dropKeys.has(column.key)) keptColumns.push(column);
    }
    const keptRows = structured.rows.map((row) => {
      const clone: Record<string, unknown> = { ...row };
      for (const k of dropKeys) {
        delete clone[k];
      }
      return clone;
    });

    const redacted: StructuredExport = {
      format: structured.format,
      filename: structured.filename,
      ...(structured.comments !== undefined && { comments: structured.comments }),
      ...(structured.trailingNewline !== undefined && {
        trailingNewline: structured.trailingNewline,
      }),
      columns: keptColumns,
      rows: keptRows,
    };
    return outcome(
      redacted,
      keptColumns.map((c) => c.key),
      Array.from(dropKeys),
      false,
    );
  }

  private shouldDropColumn(column: ExportColumn, resolved: ResolvedPermissions): boolean {
    if (column.redactable === false) return false;
    if (!isRedactable(column.resource, column.field)) return false;

    const deny = resolved.deniedReadFieldsByResource[column.resource];
    if (!deny || deny.length === 0) return false;
    return deny.includes(column.field);
  }

  // ─── csv-keyvalue (row-level) ──────────────────────────────

  /**
   * D5.6C — drop rows whose `REDACTION_FIELD_KEY` value matches a
   * deny rule under the gate's primary resource.
   *
   * `columnsRedacted` (in audit terms — repurposed for csv-keyvalue)
   * carries each dropped row's catalogue field (`__field`) so the
   * audit feed reports a stable identifier the role-builder UI
   * can map back to a deny rule. `columnsExported` lists the
   * surviving rows' `section.key` row identifier, which is the
   * user-facing metric name in the CSV — useful when an auditor
   * reviews "what made it into this download". The two arrays
   * therefore intentionally use different identifier shapes:
   *
   *   • columnsRedacted  → catalogue field   (e.g. "summary.activations")
   *   • columnsExported  → row identifier    (e.g. "summary.total_leads",
   *                                                "stage.new")
   *
   * Both forms keep raw metric VALUES out of the audit payload —
   * only structural identifiers ever land in the row.
   */
  private redactKeyValueRows(
    structured: StructuredExport,
    resolved: ResolvedPermissions,
    primary: CatalogueResource,
  ): ExportRedactionOutcome {
    const deny = resolved.deniedReadFieldsByResource[primary] ?? [];
    if (deny.length === 0) {
      return outcome(structured, rowIdentifiersOf(structured), [], false);
    }

    const denySet = new Set(deny);
    const keptRows: Record<string, unknown>[] = [];
    const droppedFields = new Set<string>();

    for (const row of structured.rows) {
      const field = row[REDACTION_FIELD_KEY];
      if (typeof field === 'string' && denySet.has(field) && isRedactable(primary, field)) {
        droppedFields.add(field);
        continue;
      }
      const clone: Record<string, unknown> = { ...row };
      delete clone[REDACTION_FIELD_KEY];
      keptRows.push(clone);
    }

    if (droppedFields.size === 0) {
      return outcome(structured, rowIdentifiersOf(structured), [], false);
    }

    const redacted: StructuredExport = {
      format: structured.format,
      filename: structured.filename,
      ...(structured.comments !== undefined && { comments: structured.comments }),
      ...(structured.trailingNewline !== undefined && {
        trailingNewline: structured.trailingNewline,
      }),
      columns: structured.columns,
      rows: keptRows,
    };
    return outcome(redacted, keptRows.map(rowIdentifier), Array.from(droppedFields), false);
  }

  /**
   * D5.6D-2 — tenant backup redactor.
   *
   * Walks every backup sub-export (one per Prisma table) and
   * applies the role's deny rules per `(column.resource,
   * column.field)` pair. Three layered protections decide whether
   * a column actually drops:
   *
   *   1. Catalogue's `isRedactable(resource, field)` flag
   *      (read-path layer). `lead.id`, `captain.id`, and the
   *      backup-specific `<table>.id` / `<table>.tenantId` entries
   *      carry `redactable: false` so any deny rule against them
   *      is a no-op at this layer.
   *
   *   2. Column-level `column.redactable === false`
   *      (per-export-column override). Backup column declarations
   *      do not set this today; the catalogue carries the
   *      decision.
   *
   *   3. **D5.6D-2 backup-specific** —
   *      `isRestoreCritical(tableName, column.field)`. Even when
   *      catalogue + column-level both allow redaction, the backup
   *      registry (`RESTORE_CRITICAL_FIELDS_BY_TABLE` in
   *      `backup.service.ts`) overrides closed for any column
   *      whose absence would break a JSON-restore tool's ability
   *      to rebuild the row. The dropped-by-catalogue / saved-by-
   *      backup-registry columns land in `protectedColumnsByTable`
   *      so the audit row records WHICH deny rules were rescued
   *      by the restore-safety gate.
   *
   * Bypass paths (return `bypassed: true`, structure unchanged,
   * `backupRedacted: false`, `restorable: true`):
   *
   *   • Super-admin (`role.code === 'super_admin'`) — mirrors
   *     `redactColumns`. Audit still fires for forensic trail; the
   *     bytes match a flag-off backup.
   *
   *   • No deny rules across any backup-table resource — fast
   *     path. Skipped redaction altogether.
   *
   * When at least one column is actually dropped, the outcome
   * carries `backupRedacted: true` + `restorable: false` and the
   * `redacted` `StructuredTenantBackup` propagates those flags
   * (plus `redactedTables` and a `redactionWarning` string) to the
   * wire envelope. The interceptor copies the flags to the audit
   * row so an admin can see "user X downloaded a redacted backup
   * at time T" in the audit feed.
   *
   * Pure function — no I/O, no clock reads, no mutation of input.
   */
  redactTenantBackup(
    structured: StructuredTenantBackup,
    resolved: ResolvedPermissions,
    _gate: ExportGateOptions,
  ): TenantBackupRedactionOutcome {
    // 1. Super-admin bypass.
    if (resolved.role.code === 'super_admin') {
      return tenantBackupBypass(structured);
    }

    // 2. Fast path: empty deny lists across every backup-table
    //    resource referenced by the structured shape.
    const denyMap = resolved.deniedReadFieldsByResource;
    const anyDeny = structured.tables.some((t) => {
      const list = denyMap[t.export.columns[0]?.resource ?? ''];
      if (list && list.length > 0) return true;
      // Conservative: also check per-column resource (mixed-resource
      // tables are rare in backups but possible).
      return t.export.columns.some((c) => (denyMap[c.resource]?.length ?? 0) > 0);
    });
    if (!anyDeny) {
      return tenantBackupBypass(structured);
    }

    // 3. Per-table redaction.
    const tableNames: string[] = [];
    const rowCountByTable: Record<string, number> = {};
    const columnsExportedByTable: Record<string, readonly string[]> = {};
    const columnsRedactedByTable: Record<string, readonly string[]> = {};
    const protectedColumnsByTable: Record<string, readonly string[]> = {};
    const newTables: StructuredTenantBackupTable[] = [];
    let totalRows = 0;
    let backupRedacted = false;
    const redactedSummary: Record<string, readonly string[]> = {};

    for (const t of structured.tables) {
      const dropKeys = new Set<string>();
      const protectedKeys = new Set<string>();

      for (const column of t.export.columns) {
        // Step 1: a deny rule must TARGET this column for any
        // gate to matter.
        const denyList = resolved.deniedReadFieldsByResource[column.resource] ?? [];
        if (!denyList.includes(column.field)) continue;

        // Step 2: rescue layers, in priority order.
        //   2a. Per-export-column override (rare).
        //   2b. Catalogue's `redactable: false` (read-path gate).
        //   2c. Backup-specific restore-critical registry.
        // Either one rescues + lands the column in
        // `protectedColumnsByTable` so the audit row reports the
        // full rescue trail.
        const catalogueProtected =
          column.redactable === false || !isRedactable(column.resource, column.field);
        const registryProtected = isRestoreCritical(t.tableName, column.field);
        if (catalogueProtected || registryProtected) {
          protectedKeys.add(column.key);
          continue;
        }

        // No rescue — actually drop.
        dropKeys.add(column.key);
      }

      tableNames.push(t.tableName);
      protectedColumnsByTable[t.tableName] = Array.from(protectedKeys);

      if (dropKeys.size === 0) {
        // No redaction for this table — keep it verbatim.
        newTables.push(t);
        rowCountByTable[t.tableName] = t.export.rows.length;
        columnsExportedByTable[t.tableName] = t.export.columns.map((c) => c.key);
        columnsRedactedByTable[t.tableName] = [];
        totalRows += t.export.rows.length;
        continue;
      }

      const keptColumns: ExportColumn[] = [];
      for (const column of t.export.columns) {
        if (!dropKeys.has(column.key)) keptColumns.push(column);
      }
      const keptRows = t.export.rows.map((row) => {
        const clone: Record<string, unknown> = { ...row };
        for (const k of dropKeys) {
          delete clone[k];
        }
        return clone;
      });

      const newSub: StructuredExport = {
        format: t.export.format,
        filename: t.export.filename,
        ...(t.export.comments !== undefined && { comments: t.export.comments }),
        ...(t.export.trailingNewline !== undefined && {
          trailingNewline: t.export.trailingNewline,
        }),
        columns: keptColumns,
        rows: keptRows,
      };
      newTables.push({ tableName: t.tableName, export: newSub });

      rowCountByTable[t.tableName] = keptRows.length;
      columnsExportedByTable[t.tableName] = keptColumns.map((c) => c.key);
      const dropArray = Array.from(dropKeys);
      columnsRedactedByTable[t.tableName] = dropArray;
      redactedSummary[t.tableName] = dropArray;
      totalRows += keptRows.length;
      backupRedacted = true;
    }

    if (!backupRedacted) {
      // Every table's deny rules were rescued by the
      // restore-criticality registry — no actual column was
      // dropped. The backup remains restorable.
      return tenantBackupBypass(structured, {
        protectedColumnsByTable,
        bypassed: false,
      });
    }

    const redactionWarning =
      'This backup has fields redacted by RBAC field-permission rules and is NOT restorable. ' +
      'Restore tooling MUST reject this file (E_BACKUP_REDACTED_NOT_RESTORABLE).';

    const redactedBackup: StructuredTenantBackup = {
      format: structured.format,
      filename: structured.filename,
      exportedAt: structured.exportedAt,
      tenant: structured.tenant,
      schemaVersion: structured.schemaVersion,
      rowCap: structured.rowCap,
      tables: newTables,
      backupRedacted: true,
      restorable: false,
      redactionWarning,
      redactedTables: redactedSummary,
    };

    return {
      redacted: redactedBackup,
      tableNames,
      rowCountByTable,
      columnsExportedByTable,
      columnsRedactedByTable,
      protectedColumnsByTable,
      totalRows,
      bypassed: false,
      backupRedacted: true,
      restorable: false,
    };
  }
}

function rowIdentifiersOf(structured: StructuredExport): string[] {
  return structured.rows.map(rowIdentifier);
}

/**
 * User-facing identifier for a csv-keyvalue row — derives from
 * the `section` + `key` columns the export emits. Falls back to
 * `<unknown>` only when neither column is present (defensive;
 * never expected in practice).
 */
function rowIdentifier(row: Record<string, unknown>): string {
  const section = row['section'];
  const key = row['key'];
  if (typeof section === 'string' && typeof key === 'string') return `${section}.${key}`;
  if (typeof key === 'string') return key;
  return '<unknown>';
}

function outcome(
  redacted: StructuredExport,
  columnsExported: readonly string[],
  columnsRedacted: readonly string[],
  bypassed: boolean,
): ExportRedactionOutcome {
  return { redacted, columnsExported, columnsRedacted, bypassed };
}

/**
 * D5.6D-2 — produce a fully-bypassing tenant backup outcome
 * (super-admin / no-deny / all-deny-rescued paths). Bytes are
 * unchanged from the input so the wire envelope stays
 * restore-compatible.
 */
function tenantBackupBypass(
  structured: StructuredTenantBackup,
  overrides?: {
    protectedColumnsByTable?: Readonly<Record<string, readonly string[]>>;
    bypassed?: boolean;
  },
): TenantBackupRedactionOutcome {
  const tableNames: string[] = [];
  const rowCountByTable: Record<string, number> = {};
  const columnsExportedByTable: Record<string, readonly string[]> = {};
  const columnsRedactedByTable: Record<string, readonly string[]> = {};
  const protectedColumnsByTable: Record<string, readonly string[]> = {};
  let totalRows = 0;
  for (const t of structured.tables) {
    tableNames.push(t.tableName);
    rowCountByTable[t.tableName] = t.export.rows.length;
    columnsExportedByTable[t.tableName] = t.export.columns.map((c) => c.key);
    columnsRedactedByTable[t.tableName] = [];
    protectedColumnsByTable[t.tableName] = overrides?.protectedColumnsByTable?.[t.tableName] ?? [];
    totalRows += t.export.rows.length;
  }
  return {
    redacted: structured,
    tableNames,
    rowCountByTable,
    columnsExportedByTable,
    columnsRedactedByTable,
    protectedColumnsByTable,
    totalRows,
    bypassed: overrides?.bypassed ?? true,
    backupRedacted: false,
    restorable: true,
  };
}
