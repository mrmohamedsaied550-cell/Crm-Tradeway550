/**
 * Sprint M1 — typed shape for MetaLeadSource.fieldMapping.
 *
 * Replaces the legacy flat `{ metaKey: leadField }` JSON with a versioned,
 * extensible structure. The version discriminator lets the migration
 * helper (`normaliseFieldMapping`) translate v1 rows on the fly so the
 * service layer never sees the old shape.
 *
 * Target kinds:
 *   • `lead_field`  — write to a known column on the Lead table
 *                     (e.g. `name`, `phone`, `email`).
 *   • `contact_field` — write to a Contact column (e.g. `displayName`).
 *   • `custom_field` — write to a tenant-defined custom field row,
 *                     keyed by its `id` (custom_field_definitions table).
 *   • `ignore`      — explicitly skip this Meta question (record-keeping).
 */

/** Known top-level Lead columns the mapping can target. */
export type MetaLeadFieldKey = 'name' | 'phone' | 'email' | 'source' | 'companyId' | 'countryId';

/** Known top-level Contact columns the mapping can target. */
export type MetaContactFieldKey = 'displayName' | 'language';

/**
 * A single mapping entry. The `metaKey` is the Meta form question's
 * `key` (e.g. `full_name`, `phone_number`, or a hashed custom-question id
 * like `question_abc123`). The `target` discriminates where the answer
 * lands in the CRM.
 */
export type MetaMappingTarget =
  | { kind: 'lead_field'; field: MetaLeadFieldKey }
  | { kind: 'contact_field'; field: MetaContactFieldKey }
  | { kind: 'custom_field'; customFieldId: string /* uuid */ }
  | { kind: 'ignore'; reason?: string };

export interface MetaMappingEntry {
  metaKey: string;
  /** Display label snapshotted from the Meta form for the admin UI. */
  metaLabel?: string;
  target: MetaMappingTarget;
  /**
   * Optional transform applied before writing. Stays small on purpose;
   * complex transforms belong in the ingest service, not the mapping.
   */
  transform?: {
    /** Trim whitespace; on by default for string answers. */
    trim?: boolean;
    /** Lowercase the value (useful for email). */
    lowercase?: boolean;
    /**
     * If `true` and the field has a default-dial-code in TenantSettings,
     * apply it to bare local phone numbers. Only meaningful for phone fields.
     */
    normaliseE164?: boolean;
  };
}

/**
 * The full JSON blob persisted on MetaLeadSource.fieldMapping in v2.
 * `version: 2` is the explicit discriminator; the helper treats anything
 * without a `version` key as v1 and normalises on the fly.
 */
export interface MetaFieldMappingV2 {
  version: 2;
  /**
   * Ordered list of mappings. Order matters when two mappings target the
   * same field — last write wins (deliberate; matches Meta's tolerance
   * for the same answer arriving via different question variants).
   */
  entries: MetaMappingEntry[];
  /**
   * If true, any Meta question key not listed in `entries` is dropped
   * silently. If false (default), unmapped answers are stored in
   * `Lead.attribution.metaRaw` for later analysis.
   */
  strict?: boolean;
}

/**
 * Legacy v1 shape — still on disk for old MetaLeadSource rows. Read-only
 * type; never write this shape. The normaliser converts v1 → v2 at fetch
 * time and the UI saves v2 back, so old rows migrate lazily on edit.
 */
export interface MetaFieldMappingV1 {
  [metaKey: string]: string /* lead field name or custom-field uuid */;
}

export type MetaFieldMappingAny = MetaFieldMappingV2 | MetaFieldMappingV1;

/**
 * Sprint M1 — attribution slice captured from the Meta webhook payload
 * and persisted onto Lead. Names are fetched once at ingest and frozen
 * on the row so renames / archivals on Meta's side don't break old
 * reports.
 */
export interface MetaAdAttribution {
  campaignId: string;
  campaignName: string;
  adsetId: string;
  adsetName: string;
  adId: string;
  adName: string;
}
