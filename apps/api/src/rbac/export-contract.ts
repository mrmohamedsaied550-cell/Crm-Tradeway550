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
 * a generic redacted-JSON variant; `json-tenant-backup` (D5.6D-1)
 * is the disaster-recovery snapshot of the entire tenant whose
 * wire format has additional structural guarantees (one section
 * per table, top-level metadata + counts envelope) and is
 * round-trip-restorable by `scripts/restore.sh`.
 */
export type ExportFormat = 'csv' | 'csv-keyvalue' | 'json' | 'json-tenant-backup';

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
   *
   * D5.6C — for `format: 'csv-keyvalue'` exports, each row may
   * carry a private `__field?: string` metadata pointing at the
   * catalogue field (under `primary` resource) that the row
   * represents. The redactor uses it to drop matching rows
   * row-by-row (instead of column-by-column). The serialiser
   * skips it because it is not a declared column.
   */
  readonly rows: readonly Record<string, unknown>[];
  /**
   * D5.6C — when `true`, the serialiser appends a final `\n` so
   * the output ends with a newline. Default `false` preserves
   * D5.6B partner-CSV byte convention. The reports CSV (E1) sets
   * this to `true` to match its pre-D5.6 byte output.
   */
  readonly trailingNewline?: boolean;
}

/**
 * D5.6C — private row-metadata key for csv-keyvalue exports.
 * When `format === 'csv-keyvalue'`, each row may carry
 * `[REDACTION_FIELD_KEY]: '<catalogue.field>'` to mark which
 * catalogue field (under the export's `primary` resource) gates
 * the row. The redactor drops the row when that field appears in
 * the role's deny list; the serialiser ignores the key because
 * it is never listed in `columns`.
 */
export const REDACTION_FIELD_KEY = '__field' as const;

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

// ─── D5.6D-1 — StructuredTenantBackup (json-tenant-backup format) ───
//
// The tenant backup is unique among governed exports: it ships a
// COLLECTION of tables in a single response, each table being a
// `StructuredExport`-shaped column+row pair. The wire-format the
// API returns must remain byte-restore-compatible with the
// pre-D5.6D `TenantBackup` JSON envelope (so `scripts/restore.sh`
// continues to round-trip an export → restore cycle without
// alteration).
//
// The structured representation is internal — it lets the redactor
// + audit service operate on a per-table basis (drop columns from
// `users` independently of `leads`, count rows per table, etc.) —
// and is collapsed back into the legacy `{exportedAt, tenant,
// schemaVersion, rowCap, counts, data}` shape by the export
// interceptor's serialiser. D5.6D-1 introduces the contract; D5.6D-2
// adds redaction + restore-rejection semantics for redacted backups.

/**
 * One table inside a `StructuredTenantBackup`. The `tableName`
 * matches the legacy wire-format key (`users`, `pipelines`, …) and
 * is preserved verbatim by the serialiser. The `export` carries
 * the column declarations + rows for that table.
 */
export interface StructuredTenantBackupTable {
  /** Wire-format key — e.g. `users`, `pipelines`, `leads`. */
  readonly tableName: string;
  /** Column-aware export for this table. `format` is always `'json'`. */
  readonly export: StructuredExport;
}

/**
 * The full structured tenant backup. Shape mirrors the legacy
 * `TenantBackup` interface 1:1 except `data` is replaced by an
 * ordered list of column-aware sub-exports. The interceptor's
 * `json-tenant-backup` serialiser collapses `tables` back into the
 * legacy `data: Record<string, unknown[]>` shape so the wire
 * payload stays restore-compatible.
 *
 * D5.6D-2 — when redaction drops at least one column from any
 * table, the wire envelope gains additional top-level metadata
 * (`backupRedacted: true`, `restorable: false`, `redactionWarning`,
 * `redactedTables`). Full / super-admin / no-deny backups keep the
 * pre-D5.6D-1 wire shape exactly so existing restore tooling
 * (`scripts/restore.sh` and any JSON-restore consumer) continues
 * to round-trip them byte-for-byte.
 */
export interface StructuredTenantBackup {
  readonly format: 'json-tenant-backup';
  /** Suggested download filename. Used for `Content-Disposition`. */
  readonly filename: string;
  /** Top-level export timestamp (ISO 8601). */
  readonly exportedAt: string;
  /** Tenant identity envelope. */
  readonly tenant: { readonly id: string; readonly code: string; readonly name: string };
  /** Bumped when the backup wire format changes. */
  readonly schemaVersion: number;
  /** Hard cap on rows per table — see BackupService.ROW_CAP. */
  readonly rowCap: number;
  /** Ordered list of per-table sub-exports. */
  readonly tables: readonly StructuredTenantBackupTable[];
  /**
   * D5.6D-2 — set to `true` ONLY when the redactor actually
   * dropped at least one column from at least one table. A backup
   * whose deny rules all targeted restore-critical columns
   * (rescued by the protection registry) is NOT marked redacted —
   * it remains restorable.
   */
  readonly backupRedacted?: boolean;
  /**
   * D5.6D-2 — `false` when `backupRedacted` is true. The
   * `validateBackupForRestore()` guard refuses to load any
   * envelope whose `restorable === false` flag is set.
   */
  readonly restorable?: boolean;
  /**
   * D5.6D-2 — human-readable warning for the consumer (CLI, API,
   * archive viewer). Empty when not redacted.
   */
  readonly redactionWarning?: string;
  /**
   * D5.6D-2 — per-table summary of the columns the redactor
   * dropped. Only populated when `backupRedacted === true`. Keys
   * are wire-format table names (`leads`, `users`, …); values are
   * the redacted column-key lists (e.g. `['phone', 'email']`).
   */
  readonly redactedTables?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Record-shape returned by the redactor for a tenant backup. Mirrors
 * `ExportRedactionOutcome` but carries per-table counters because the
 * audit row records column-redaction metadata per table.
 *
 * D5.6D-2 enriches the outcome with:
 *   • `protectedColumnsByTable` — columns the redactor refused to
 *     drop because they are listed in
 *     `RESTORE_CRITICAL_FIELDS_BY_TABLE`. Surfaces in the audit
 *     payload so an admin reviewing a redacted backup can see
 *     which deny rules were rescued by the restore-safety gate.
 *   • `backupRedacted` / `restorable` — top-level flags used by
 *     the interceptor to mark the wire envelope and route the
 *     audit row.
 */
export interface TenantBackupRedactionOutcome {
  readonly redacted: StructuredTenantBackup;
  /** Tables present after redaction (same as input). */
  readonly tableNames: readonly string[];
  /** Row count per table after redaction. */
  readonly rowCountByTable: Readonly<Record<string, number>>;
  /** Column keys per table that survived redaction. */
  readonly columnsExportedByTable: Readonly<Record<string, readonly string[]>>;
  /** Column keys per table dropped by the redactor. */
  readonly columnsRedactedByTable: Readonly<Record<string, readonly string[]>>;
  /**
   * D5.6D-2 — column keys per table that the redactor REFUSED to
   * drop because they are restore-critical. These columns survive
   * even when the role's deny list explicitly targets them.
   */
  readonly protectedColumnsByTable: Readonly<Record<string, readonly string[]>>;
  /** Sum of rows across all tables. */
  readonly totalRows: number;
  /** True when bypass ran (super-admin, flag off, no deny rules). */
  readonly bypassed: boolean;
  /**
   * D5.6D-2 — true when at least one column was actually dropped
   * across all tables. Drives the wire envelope's
   * `backupRedacted` flag + the restore-rejection guard.
   */
  readonly backupRedacted: boolean;
  /**
   * D5.6D-2 — false when `backupRedacted === true`. The guard's
   * single source of truth for "this file should never restore".
   */
  readonly restorable: boolean;
}
