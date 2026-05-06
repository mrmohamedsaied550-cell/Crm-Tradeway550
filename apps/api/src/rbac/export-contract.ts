import type { CatalogueResource } from './field-catalogue.registry';

/**
 * Phase D5 — D5.6A: Structured export contract.
 *
 * Every export endpoint that opts into governed export semantics
 * (via `@ExportGate`) MUST return a `StructuredExport` instead of a
 * pre-serialised CSV string or a raw `res.send(...)` write. The
 * `ExportInterceptor` reads the structured value, applies
 * column-level redaction via the catalogue / role deny lists,
 * serialises to the requested format, sets download headers,
 * writes a metadata-only audit row, and finally hands a serialised
 * string body to NestJS to ship to the client.
 *
 * Three reasons a structured contract is the only sound foundation:
 *
 *   1. Correctness — parsing + re-serialising a CSV string risks
 *      subtle escape errors (multiline cells, quoted commas,
 *      embedded `"`, RTL/UTF-8). A single canonical serialiser
 *      removes that class of bug.
 *
 *   2. Mixed-resource governance — an export like
 *      `partner.reconciliation.csv` ships columns originating
 *      from `lead` (phone, name) AND `captain` (active date) AND
 *      `partner.verification` (partner active date). Each column
 *      carries its own `(resource, field)` pair so a deny rule on
 *      `lead.phone` strips the column from a partner export
 *      without bleeding into other column families. Plain
 *      column-name matching cannot express this.
 *
 *   3. Auditability — the audit row records `columnsExported` /
 *      `columnsRedacted` / `rowCount` after the redaction
 *      decision, not before. Only structural awareness produces
 *      that distinction; CSV regex cannot.
 *
 * D5.6A defines the contract + the foundation services. D5.6B-D
 * wire individual exports onto the contract.
 */

/**
 * Logical export format. CSV is the only client-facing format
 * shipped today; `csv-keyvalue` is reserved for the reports
 * surface (E1) which uses `section,key,value` triples; `json` is
 * reserved for the tenant backup surface (E5).
 */
export type ExportFormat = 'csv' | 'csv-keyvalue' | 'json';

/**
 * One column in a structured export. The `resource` + `field`
 * pair is the redaction lookup key — the redactor consults
 * `resolved.deniedReadFieldsByResource[column.resource]` and
 * drops the column when `column.field` appears there AND the
 * column is `redactable`.
 */
export interface ExportColumn {
  /** Stable column key — must be unique within the export. Becomes the row Record key. */
  readonly key: string;
  /** Human-friendly header label written to the CSV. */
  readonly label: string;
  /**
   * Catalogue resource this column inherits its deny rule from.
   * NOT necessarily the same as the export's `primary` resource —
   * e.g. a `partner.reconciliation` export's `phone` column has
   * `resource: 'lead'` because the deny rule lives on the lead
   * catalogue.
   */
  readonly resource: CatalogueResource;
  /** Catalogue field key inside that resource. */
  readonly field: string;
  /**
   * Sensitive flag mirrored from the catalogue. Exposed so a future
   * UI hint ("this column is sensitive") can render without a
   * second catalogue lookup. NOT consulted by the redactor.
   */
  readonly sensitive?: boolean;
  /**
   * `false` when this column MUST survive redaction even if the
   * deny list mentions it. Defaults to undefined — the redactor
   * also consults `isRedactable(resource, field)` from the
   * catalogue, so explicit `false` here is for cases where the
   * catalogue doesn't apply (computed columns).
   */
  readonly redactable?: boolean;
}

/**
 * The structured payload an export controller returns. Frozen at
 * the controller boundary; the redactor returns a NEW
 * `StructuredExport` with a filtered column set + filtered rows.
 */
export interface StructuredExport {
  readonly format: ExportFormat;
  /** Suggested download filename. Used to set `Content-Disposition`. */
  readonly filename: string;
  /**
   * Optional preamble lines. CSV serialiser writes each as a
   * comment row prefixed with `# `; JSON serialiser ignores them.
   * Use for `# generated_at: …`, `# filter: …` metadata.
   */
  readonly comments?: readonly string[];
  /** Column declaration. Order is preserved in the output. */
  readonly columns: readonly ExportColumn[];
  /**
   * Row payload. Each row is a flat dictionary keyed by
   * `column.key`. Missing keys serialise as empty strings (CSV)
   * or `null` (JSON). No nested objects supported in D5.6A — the
   * catalogue's dot-paths handle nested-resource deny rules at
   * the column declaration layer instead.
   */
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * Record-shape returned by the redactor. Carries the post-redaction
 * `StructuredExport` plus structural metadata the audit service
 * persists. Defined here so both the redactor and the interceptor
 * import a single contract.
 */
export interface ExportRedactionOutcome {
  readonly redacted: StructuredExport;
  /** Column keys present in the post-redaction shape. */
  readonly columnsExported: readonly string[];
  /** Column keys dropped by the redactor. Empty when bypass / no deny rules. */
  readonly columnsRedacted: readonly string[];
  /** True when the bypass path ran (super-admin, flag off, etc.). */
  readonly bypassed: boolean;
}
