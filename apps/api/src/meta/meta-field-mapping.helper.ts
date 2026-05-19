/**
 * Sprint M2 — runtime helpers for the MetaLeadSource.fieldMapping
 * column.
 *
 * Two responsibilities:
 *   1. `normaliseFieldMapping(raw)` — accept either a V1 flat object
 *      (`{ metaKey: leadField }`) or a V2 versioned envelope and
 *      return a V2 structure. V1 destinations that aren't recognised
 *      become `ignore` entries with an audit `reason` so they appear
 *      in tooling but don't silently misroute a value.
 *   2. `applyMappingV2(fieldData, mapping)` — walk a Meta-style
 *      `field_data` array against a V2 mapping and return the values
 *      bucketed by target kind (lead column / contact column / custom
 *      field id). The existing webhook controller's `applyMapping`
 *      stays in place for tests that exercise the V1-only legacy
 *      path; the new ingest path always normalises first and only
 *      consumes V2 here.
 *
 * The normaliser is deliberately tolerant. The webhook handler runs
 * unauthenticated under load — throwing on malformed source rows
 * would expose ingest to operator typos. We surface bad mappings via
 * the logger and return a sensible default instead.
 */

import { Logger } from '@nestjs/common';

import type {
  MetaFieldMappingV1,
  MetaFieldMappingV2,
  MetaContactFieldKey,
  MetaLeadFieldKey,
  MetaMappingEntry,
  MetaMappingTarget,
} from './meta-field-mapping.types';

const logger = new Logger('MetaFieldMapping');

const LEAD_FIELD_KEYS: ReadonlySet<string> = new Set<MetaLeadFieldKey>([
  'name',
  'phone',
  'email',
  'source',
  'companyId',
  'countryId',
]);
const CONTACT_FIELD_KEYS: ReadonlySet<string> = new Set<MetaContactFieldKey>([
  'displayName',
  'language',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normaliseFieldMapping(raw: unknown): MetaFieldMappingV2 {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (r['version'] === 2 && Array.isArray(r['entries'])) {
      const entries = (r['entries'] as unknown[]).filter(isValidV2Entry);
      return {
        version: 2,
        entries,
        ...(typeof r['strict'] === 'boolean' && { strict: r['strict'] }),
      };
    }
    return migrateV1(r as MetaFieldMappingV1);
  }
  return { version: 2, entries: [] };
}

function migrateV1(v1: MetaFieldMappingV1): MetaFieldMappingV2 {
  const entries: MetaMappingEntry[] = [];
  for (const [metaKey, dst] of Object.entries(v1)) {
    if (typeof metaKey !== 'string' || metaKey.length === 0) continue;
    if (typeof dst !== 'string' || dst.length === 0) continue;
    entries.push({ metaKey, target: resolveLegacyTarget(dst) });
  }
  return { version: 2, entries };
}

function resolveLegacyTarget(dst: string): MetaMappingTarget {
  if (LEAD_FIELD_KEYS.has(dst)) {
    return { kind: 'lead_field', field: dst as MetaLeadFieldKey };
  }
  if (CONTACT_FIELD_KEYS.has(dst)) {
    return { kind: 'contact_field', field: dst as MetaContactFieldKey };
  }
  if (UUID_RE.test(dst)) {
    return { kind: 'custom_field', customFieldId: dst };
  }
  logger.warn(`unknown legacy mapping destination "${dst}"; entry will be ignored`);
  return { kind: 'ignore', reason: `legacy_unknown:${dst}` };
}

function isValidV2Entry(e: unknown): e is MetaMappingEntry {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  if (typeof r['metaKey'] !== 'string' || r['metaKey'].length === 0) return false;
  if (!r['target'] || typeof r['target'] !== 'object') return false;
  const kind = (r['target'] as Record<string, unknown>)['kind'];
  return (
    kind === 'lead_field' ||
    kind === 'contact_field' ||
    kind === 'custom_field' ||
    kind === 'ignore'
  );
}

// ───────────────────────────────────────────────────────────────────
// Applier — bucket the values by target kind. Returns empty objects
// (not null) so callers can treat the result with plain property
// access.
// ───────────────────────────────────────────────────────────────────

export interface AppliedMapping {
  leadFields: Partial<Record<MetaLeadFieldKey, string>>;
  contactFields: Partial<Record<MetaContactFieldKey, string>>;
  customFields: Record<string, string>;
  ignored: string[];
  unmapped: string[];
}

export function applyMappingV2(
  fieldData: ReadonlyArray<{ name: string; values: ReadonlyArray<string> }>,
  mapping: MetaFieldMappingV2,
): AppliedMapping {
  const incoming = new Map<string, string>();
  for (const f of fieldData) {
    const first = f.values[0];
    if (typeof first === 'string' && first.length > 0) {
      incoming.set(f.name, first);
    }
  }

  const out: AppliedMapping = {
    leadFields: {},
    contactFields: {},
    customFields: {},
    ignored: [],
    unmapped: [],
  };

  const claimed = new Set<string>();
  for (const entry of mapping.entries) {
    claimed.add(entry.metaKey);
    const raw = incoming.get(entry.metaKey);
    if (raw === undefined) continue;
    const value = applyTransforms(raw, entry.transform);
    if (value.length === 0) continue;
    switch (entry.target.kind) {
      case 'lead_field':
        out.leadFields[entry.target.field] = value;
        break;
      case 'contact_field':
        out.contactFields[entry.target.field] = value;
        break;
      case 'custom_field':
        out.customFields[entry.target.customFieldId] = value;
        break;
      case 'ignore':
        out.ignored.push(entry.metaKey);
        break;
    }
  }

  if (!mapping.strict) {
    for (const k of incoming.keys()) {
      if (!claimed.has(k)) out.unmapped.push(k);
    }
  }

  return out;
}

function applyTransforms(value: string, transform: MetaMappingEntry['transform']): string {
  let v = value;
  // `trim` defaults to true (matches the docstring on MetaMappingEntry).
  if (transform?.trim !== false) v = v.trim();
  if (transform?.lowercase === true) v = v.toLowerCase();
  // `normaliseE164` is intentionally not applied here. Phone
  // normalisation needs the tenant's `defaultDialCode`, which the
  // ingest service already applies via `normalizeE164WithDefault`
  // downstream. Surfacing it here would double-normalise and lose
  // information on already-canonical inputs.
  return v;
}
