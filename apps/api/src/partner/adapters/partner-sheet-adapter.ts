/**
 * Phase D4 — D4.3: PartnerSheetAdapter contract.
 *
 * Implementations of this interface know how to talk to one
 * partner-feed shape (Google Sheets, manual CSV upload, future
 * REST endpoints, …). Every adapter is server-only — adapters are
 * the ONLY layer allowed to handle decrypted credentials and
 * external network IO. They MUST never return decrypted credentials
 * back to a caller.
 *
 * Three operations:
 *   • testConnection  — probe the target without fetching data.
 *                       Used by the admin "Test connection" button
 *                       and by the sync engine's pre-flight check.
 *   • listTabs        — enumerate available tabs for tab discovery.
 *                       Optional for adapters that don't have a
 *                       tab concept (manual upload returns []).
 *   • fetchRows       — pull every row from the resolved tab. Each
 *                       row is a map keyed by the source column
 *                       header. The sync engine handles mapping +
 *                       transforms after this returns.
 *
 * Errors are surfaced via typed `AdapterError` codes. The sync
 * engine maps them to controlled API errors / failed-snapshot
 * `error_name` values.
 */

export type RawPartnerRow = Record<string, string>;

export interface TabInfo {
  /** Verbatim tab name from the partner system. */
  name: string;
  /** ISO timestamp of the last modification, when the partner
   *  system exposes it. NULL when unknown — discovery rules that
   *  rely on `most_recently_modified` then degrade to alphabetical
   *  order with a warning. */
  modifiedAt: string | null;
}

export interface AdapterTestConnectionResult {
  /** 'ok' | 'auth_failed' | 'sheet_not_found' | 'unknown' | 'not_wired'. */
  status: string;
  /** Operator-facing summary. */
  message: string;
  /** Optional list of resolved tab names; used to populate the
   *  tab-discovery preview in the admin UI. May be empty. */
  tabs?: TabInfo[];
}

export interface AdapterFetchOptions {
  /** Resolved tab name when the source has one. NULL for tab-less
   *  adapters (manual upload). */
  tabName: string | null;
}

export class AdapterError extends Error {
  constructor(
    readonly code:
      | 'partner.adapter.auth_failed'
      | 'partner.adapter.sheet_not_found'
      | 'partner.adapter.tab_not_found'
      | 'partner.adapter.fetch_failed'
      | 'partner.adapter.not_wired'
      | 'partner.adapter.invalid_payload',
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/**
 * Snapshot of the persisted source config that adapters need to
 * operate. Decrypted credentials are passed alongside (never read
 * by the adapter directly from the DB) so the sync engine controls
 * the lifetime of plaintext key material.
 */
export interface AdapterContext {
  partnerSourceId: string;
  adapter: string;
  /** Decrypted credentials object (or NULL when the adapter does
   *  not require credentials, e.g. manual upload). NEVER persisted
   *  by the adapter. */
  credentials: Record<string, unknown> | null;
  /** 'fixed' | 'new_per_period'. */
  tabMode: string;
  fixedTabName: string | null;
  tabDiscoveryRule: unknown;
}

export interface PartnerSheetAdapter {
  readonly adapterCode: string;
  testConnection(ctx: AdapterContext): Promise<AdapterTestConnectionResult>;
  listTabs(ctx: AdapterContext): Promise<TabInfo[]>;
  fetchRows(ctx: AdapterContext, opts: AdapterFetchOptions): Promise<RawPartnerRow[]>;
}
