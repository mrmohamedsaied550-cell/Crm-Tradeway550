/**
 * Phase D5 — D5.9: client-side mirror of safe field-catalogue metadata.
 *
 * The server's authoritative catalogue lives in
 * `apps/api/src/rbac/field-catalogue.registry.ts`. Shipping the
 * full registry to the SPA would couple the build artefact size to
 * the role-builder UI; instead this mirror covers ONLY the fields
 * the SPA's `<RedactedFieldBadge>` renders today (the surfaces
 * touched by D5.7 + D5.8).
 *
 * Every entry carries:
 *   • `resource` + `field` — match the server `field_permissions`
 *     row so `isFieldDenied(resource, field)` can light up.
 *   • `labelEn` / `labelAr` — strings the badge displays. Mirror
 *     the server catalogue verbatim so an admin reviewing the
 *     deny rule in the role-builder UI sees the same label the
 *     end-user sees.
 *
 * The mirror is purely informational. It is NOT consulted for
 * permission decisions; callers consult `lib/permissions.ts` for
 * that. A field absent from this mirror is rendered with the
 * generic "Hidden by your role" copy, no field-specific label —
 * the badge still works.
 */

export interface ClientCatalogueEntry {
  readonly resource: string;
  readonly field: string;
  readonly labelEn: string;
  readonly labelAr: string;
}

const ENTRIES: readonly ClientCatalogueEntry[] = [
  // D5.7 — rotation history field-permission gates.
  {
    resource: 'rotation',
    field: 'fromUser',
    labelEn: 'From user',
    labelAr: 'من المستخدم',
  },
  {
    resource: 'rotation',
    field: 'toUser',
    labelEn: 'To user',
    labelAr: 'إلى المستخدم',
  },
  {
    resource: 'rotation',
    field: 'actor',
    labelEn: 'Rotation actor',
    labelAr: 'منفّذ الدوران',
  },
  {
    resource: 'rotation',
    field: 'notes',
    labelEn: 'Rotation notes',
    labelAr: 'ملاحظات الدوران',
  },

  // D5.7 — lead-side ownership history.
  {
    resource: 'lead',
    field: 'previousOwner',
    labelEn: 'Previous owner',
    labelAr: 'المالك السابق',
  },
  {
    resource: 'lead',
    field: 'ownerHistory',
    labelEn: 'Owner history',
    labelAr: 'سجل الملاك',
  },

  // D5.8 — out-of-scope attempt count.
  {
    resource: 'lead',
    field: 'outOfScopeAttemptCount',
    labelEn: 'Out-of-scope attempt count',
    labelAr: 'عدد المحاولات خارج الصلاحية',
  },

  // D5.8 — TL Review Queue context fields.
  {
    resource: 'lead.review',
    field: 'assignedTl',
    labelEn: 'Assigned TL',
    labelAr: 'قائد الفريق المُسنَد',
  },
  {
    resource: 'lead.review',
    field: 'ownerContext',
    labelEn: 'Owner context',
    labelAr: 'سياق المالك',
  },
  {
    resource: 'lead.review',
    field: 'partnerContext',
    labelEn: 'Partner context',
    labelAr: 'سياق الشريك',
  },
  {
    resource: 'lead.review',
    field: 'reasonPayload',
    labelEn: 'Review reason payload',
    labelAr: 'حمولة سبب المراجعة',
  },
  {
    resource: 'lead.review',
    field: 'resolutionNotes',
    labelEn: 'Resolution notes',
    labelAr: 'ملاحظات القرار',
  },
];

const BY_KEY: Map<string, ClientCatalogueEntry> = new Map(
  ENTRIES.map((e) => [`${e.resource}::${e.field}`, e]),
);

/**
 * Look up a catalogue entry by `(resource, field)`. Returns
 * `undefined` for fields not in the mirror — callers should fall
 * back to the generic "Hidden by your role" copy.
 */
export function getCatalogueEntry(
  resource: string,
  field: string,
): ClientCatalogueEntry | undefined {
  return BY_KEY.get(`${resource}::${field}`);
}

/**
 * Locale-aware label accessor. Returns the field's English label
 * when locale starts with `en`, the Arabic label otherwise. Returns
 * `null` when the entry is unknown so the badge can fall back to
 * generic copy.
 */
export function getCatalogueLabel(resource: string, field: string, locale: string): string | null {
  const entry = getCatalogueEntry(resource, field);
  if (!entry) return null;
  return locale.toLowerCase().startsWith('ar') ? entry.labelAr : entry.labelEn;
}

export const FIELD_CATALOGUE_MIRROR: readonly ClientCatalogueEntry[] = ENTRIES;
