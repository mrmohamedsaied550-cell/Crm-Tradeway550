import type { StructuredExport } from './export-contract';

/**
 * Phase D5 — D5.6A: canonical CSV serialiser.
 *
 * Single source of truth for converting a `StructuredExport` into
 * a CSV string. Every escape-aware byte that leaves the API as a
 * CSV download must pass through this function. Hand-rolled
 * (rather than a dependency) because the rules are tight and
 * stable: comma + quote + newline escaping, RFC 4180 compliant,
 * Unicode-safe.
 *
 * Rules:
 *
 *   • Output uses LF line endings (`\n`). The classic RFC mandates
 *     CRLF, but CRLF on a Linux server inside a CSV used by Excel
 *     on macOS produces an extra blank row in some readers; LF
 *     is what every existing builder in the repo emits today
 *     (`buildCsv` in partner-milestones, `exportCsv` in the
 *     reconciliation service). LF is therefore the project
 *     convention; the serialiser preserves it for byte-identity
 *     against pre-D5.6 outputs.
 *
 *   • Cells are wrapped in double-quotes when they contain any of
 *     `, " \r \n`. Embedded `"` is doubled to `""`. Empty cells
 *     are written as the empty string (no quotes).
 *
 *   • Numbers (`number`, `bigint`) are stringified directly — no
 *     quoting. `boolean` becomes `true` / `false`. `null` /
 *     `undefined` become the empty string. Date instances become
 *     ISO 8601 strings (UTC). Anything else is `String(value)`.
 *
 *   • Comments are emitted as raw lines prefixed by the supplied
 *     comment lines from the `StructuredExport`. The caller
 *     prepends the `#` if it wants a comment marker — the
 *     serialiser is verbatim. Empty `comments` array emits no
 *     preamble.
 *
 *   • The header row is the column `label`s joined by `,`. The
 *     row order matches `structured.columns`.
 *
 *   • Column-row matching uses `column.key`; missing keys in a
 *     row become empty cells. Extra keys in a row are silently
 *     ignored (defensive — the redactor strips columns; row
 *     keys may legitimately outlive the column list).
 *
 *   • Output does NOT include a trailing newline. The two existing
 *     D4 builders (`partner-reconciliation.service.exportCsv` and
 *     `partner-milestones buildCsv`) both end with `lines.join('\n')`
 *     — no trailing newline — so byte-equality with the legacy
 *     output requires the same convention here. The reports CSV
 *     (D5.6C) will carry its own trailing-newline shim.
 *
 * Determinism: same input → same byte output. Required for
 * golden-file tests + future cross-region replay.
 *
 * Pure function — no I/O, no clock reads, no mutation of the
 * input.
 */
export function serializeCsv(structured: StructuredExport): string {
  if (structured.format !== 'csv' && structured.format !== 'csv-keyvalue') {
    throw new Error(
      `serializeCsv: unsupported format '${structured.format}'. Only 'csv' and 'csv-keyvalue' are CSV-style.`,
    );
  }

  const lines: string[] = [];

  // ─── 1. Comments preamble ────────────────────────────────────
  if (structured.comments && structured.comments.length > 0) {
    for (const c of structured.comments) {
      lines.push(c);
    }
  }

  // ─── 2. Header ───────────────────────────────────────────────
  lines.push(structured.columns.map((c) => csvEscape(c.label)).join(','));

  // ─── 3. Rows ─────────────────────────────────────────────────
  for (const row of structured.rows) {
    const cells = structured.columns.map((c) => csvEscape(formatCell(row[c.key])));
    lines.push(cells.join(','));
  }

  return lines.join('\n');
}

/**
 * RFC 4180-style quoting. Exposed so callers (outside the
 * structured contract) can escape ad-hoc values when forced into
 * a non-tabular shape — e.g. the section/key/value reports CSV.
 * D5.6C will use it; D5.6A simply re-uses it inside `serializeCsv`.
 */
export function csvEscape(value: string): string {
  if (value.length === 0) return '';
  // Quote when any of: comma, double-quote, CR, LF.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Coerce an arbitrary cell value into a CSV string. Accepts the
 * primitive types most controllers actually return; throws on
 * objects (which should be flattened by the controller before the
 * row is built — nested shapes are out of scope for D5.6A).
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      // NaN / Infinity render as the empty string — Excel chokes on them.
      return Number.isFinite(value) ? value.toString() : '';
    case 'bigint':
      return value.toString();
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      if (value instanceof Date) {
        return value.toISOString();
      }
      throw new TypeError(
        `serializeCsv/formatCell: unsupported value type '${typeof value}'. Flatten nested values to a primitive in the controller.`,
      );
  }
}
