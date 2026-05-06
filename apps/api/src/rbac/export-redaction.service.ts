import { Injectable } from '@nestjs/common';

import type {
  ExportColumn,
  ExportRedactionOutcome,
  StructuredExport,
  StructuredTenantBackup,
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
   * D5.6D-1 — tenant backup passthrough.
   *
   * The tenant backup ships seventeen tables in a single response.
   * D5.6D-1 introduces the structured contract + audit envelope but
   * does NOT yet apply redaction semantics — every input row /
   * column survives, regardless of role deny rules. The method
   * returns a `bypassed: true` outcome whose per-table counters
   * mirror the input verbatim so the audit row carries the right
   * structural footprint.
   *
   * Why no-op in D5.6D-1:
   *
   *   • The existing `restore.sh` script consumes the legacy
   *     wire-format byte-for-byte. Stripping columns from a
   *     backup would silently produce a file that looks like a
   *     full backup but cannot be restored — a disaster-recovery
   *     anti-pattern. D5.6D-2 introduces the
   *     `E_BACKUP_REDACTED_NOT_RESTORABLE` guard before turning
   *     redaction on.
   *
   *   • Per-table redaction tests (deny-list permutations across
   *     17 tables) need their own commit so a regression in one
   *     table doesn't mask a regression in another.
   *
   *   • The role bundle's deny lists were built for the read-path
   *     UI surface (lead detail page, captain detail page). The
   *     backup shipping under those same deny lists changes the
   *     contract — admins need to opt into "deny applies to
   *     backup" via D5.6D-2's policy switch, not silently inherit
   *     the read-path deny rules.
   *
   * Manual stripping of credentials (passwordHash, accessToken,
   * appSecret, verifyToken) happens at the BackupService boundary
   * via Prisma `select` and is unaffected by this method — those
   * fields never reach the redactor in the first place.
   *
   * D5.6D-2 will replace the body of this method with a per-table
   * walk that calls `redactColumnLevel` on each sub-export, plus a
   * `restoreCriticalIdsSurvived` invariant check that fails the
   * outcome closed if any FK column was dropped.
   */
  redactTenantBackup(
    structured: StructuredTenantBackup,
    _resolved: ResolvedPermissions,
    _gate: ExportGateOptions,
  ): TenantBackupRedactionOutcome {
    const tableNames: string[] = [];
    const rowCountByTable: Record<string, number> = {};
    const columnsExportedByTable: Record<string, readonly string[]> = {};
    const columnsRedactedByTable: Record<string, readonly string[]> = {};
    let totalRows = 0;

    for (const t of structured.tables) {
      tableNames.push(t.tableName);
      const rowCount = t.export.rows.length;
      rowCountByTable[t.tableName] = rowCount;
      columnsExportedByTable[t.tableName] = t.export.columns.map((c) => c.key);
      columnsRedactedByTable[t.tableName] = [];
      totalRows += rowCount;
    }

    return {
      redacted: structured,
      tableNames,
      rowCountByTable,
      columnsExportedByTable,
      columnsRedactedByTable,
      totalRows,
      bypassed: true,
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
