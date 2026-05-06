import { Injectable } from '@nestjs/common';

import type { ExportColumn, ExportRedactionOutcome, StructuredExport } from './export-contract';
import { isRedactable } from './field-catalogue.registry';
import type { ResolvedPermissions } from './permission-resolver.service';

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
   *   • no deny rule on any column's resource → bypass.
   *   • column with deny rule + non-redactable → kept.
   *   • column with deny rule + redactable → dropped from
   *     `columns`; the matching `column.key` is deleted from
   *     every row.
   */
  redactColumns(
    structured: StructuredExport,
    resolved: ResolvedPermissions,
  ): ExportRedactionOutcome {
    // 1. Super-admin bypass — mirrors PermissionResolverService:
    //    super-admin's `deniedReadFieldsByResource` is already
    //    empty, but a defensive check on `role.code` short-circuits
    //    the column walk for free.
    if (resolved.role.code === 'super_admin') {
      return outcome(
        structured,
        structured.columns.map((c) => c.key),
        [],
        true,
      );
    }

    // 2. Compute drop set — columns whose (resource, field) pair
    //    is in the deny map AND the column is redactable.
    const dropKeys = new Set<string>();
    for (const column of structured.columns) {
      if (this.shouldDrop(column, resolved)) {
        dropKeys.add(column.key);
      }
    }

    if (dropKeys.size === 0) {
      // Fast path — no column changes, return the original
      // structure (no clone) so callers can pin reference equality
      // against the input when nothing changed.
      return outcome(
        structured,
        structured.columns.map((c) => c.key),
        [],
        false,
      );
    }

    // 3. Build the redacted columns + rows. Rows are shallow-cloned
    //    so the input is untouched. Dropped keys are deleted from
    //    the clones.
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

  private shouldDrop(column: ExportColumn, resolved: ResolvedPermissions): boolean {
    // Non-redactable columns always survive. We check both the
    // explicit column flag AND the catalogue (so a column that
    // declares `redactable: undefined` still inherits the
    // catalogue's `redactable: false` decisions for ID columns).
    if (column.redactable === false) return false;
    if (!isRedactable(column.resource, column.field)) return false;

    const deny = resolved.deniedReadFieldsByResource[column.resource];
    if (!deny || deny.length === 0) return false;
    return deny.includes(column.field);
  }
}

function outcome(
  redacted: StructuredExport,
  columnsExported: readonly string[],
  columnsRedacted: readonly string[],
  bypassed: boolean,
): ExportRedactionOutcome {
  return { redacted, columnsExported, columnsRedacted, bypassed };
}
