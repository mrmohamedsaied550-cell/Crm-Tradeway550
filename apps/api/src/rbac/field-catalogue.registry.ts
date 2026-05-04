/**
 * Phase C — C4: field catalogue.
 *
 * The static contract for which (resource, field) pairs are gateable
 * through the field-permission matrix. Two readers consume this:
 *
 *   1. FieldFilterService (this commit) — when a runtime payload is
 *      stripped, the catalogue is informational only; the actual
 *      decision comes from the per-tenant `field_permissions` table
 *      written by C2's role builder.
 *
 *   2. Admin UI matrix (C8) — renders one column per entry per
 *      resource with metadata (sensitive flag, default state) so the
 *      operator knows what they're toggling.
 *
 * Field paths use dot-notation for nested JSON (e.g.
 * `attribution.campaign`) and match the field strings stored in
 * `field_permissions.field`. Top-level columns are written as-is
 * (e.g. `id`, `phone`).
 *
 * Default behaviour for fields NOT in the catalogue: read=TRUE /
 * write=TRUE — restrictions are explicit denials, not whitelists.
 * This keeps the existing 495 tests passing without seed gymnastics.
 *
 * Adding a field later: append to FIELD_CATALOGUE; no migration
 * needed because the field_permissions table is keyed by string,
 * not enum.
 */

export type CatalogueResource = 'lead';

export interface FieldCatalogueEntry {
  readonly resource: CatalogueResource;
  /** Dot-path under the resource shape. */
  readonly field: string;
  /**
   * Sensitive fields are highlighted in the admin matrix UI (C8) so
   * the operator can spot PII / financial values at a glance.
   */
  readonly sensitive: boolean;
  /** Behaviour when no field_permission row exists. */
  readonly defaultRead: boolean;
  readonly defaultWrite: boolean;
  /** Short human-friendly label for the matrix UI (en). */
  readonly labelEn: string;
}

/**
 * Initial catalogue — Lead resource only. C10 will add captain /
 * follow-up / WhatsApp.conversation entries.
 *
 * Lead.id is included even though it's a primary key: sales_agent's
 * seeded deny rule exists for it (per the approved plan), so the
 * runtime filter must be willing to strip it. The admin UI will
 * mark it sensitive so admins know the implication of toggling.
 */
export const FIELD_CATALOGUE: readonly FieldCatalogueEntry[] = [
  // Identity / contact
  {
    resource: 'lead',
    field: 'id',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Lead ID',
  },
  {
    resource: 'lead',
    field: 'name',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Name',
  },
  {
    resource: 'lead',
    field: 'phone',
    sensitive: true,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Phone',
  },
  {
    resource: 'lead',
    field: 'email',
    sensitive: true,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Email',
  },
  // Source + attribution payload (each leaf gateable)
  {
    resource: 'lead',
    field: 'source',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Source (flat)',
  },
  {
    resource: 'lead',
    field: 'attribution',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution (whole payload)',
  },
  {
    resource: 'lead',
    field: 'attribution.source',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · source',
  },
  {
    resource: 'lead',
    field: 'attribution.subSource',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · sub-source',
  },
  {
    resource: 'lead',
    field: 'attribution.campaign',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · campaign',
  },
  {
    resource: 'lead',
    field: 'attribution.adSet',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · ad set',
  },
  {
    resource: 'lead',
    field: 'attribution.ad',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · ad',
  },
  {
    resource: 'lead',
    field: 'attribution.utm',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · UTM',
  },
  // Lifecycle + lost-reason context
  {
    resource: 'lead',
    field: 'lifecycleState',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Lifecycle',
  },
  {
    resource: 'lead',
    field: 'lostReasonId',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Lost reason',
  },
  {
    resource: 'lead',
    field: 'lostNote',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Lost note',
  },
  // Org scope
  {
    resource: 'lead',
    field: 'companyId',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Company',
  },
  {
    resource: 'lead',
    field: 'countryId',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Country',
  },
  {
    resource: 'lead',
    field: 'pipelineId',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Pipeline',
  },
  // Assignment + ownership
  {
    resource: 'lead',
    field: 'assignedToId',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Assignee',
  },
  {
    resource: 'lead',
    field: 'createdById',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Created by',
  },
  // SLA / scheduling
  {
    resource: 'lead',
    field: 'slaStatus',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'SLA status',
  },
  {
    resource: 'lead',
    field: 'slaDueAt',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'SLA due',
  },
  {
    resource: 'lead',
    field: 'nextActionDueAt',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Next action due',
  },
] as const;

export const CATALOGUE_RESOURCES = ['lead'] as const satisfies readonly CatalogueResource[];

/** O(1) lookup: tenants pass `(resource, field)` to test gateability. */
export function isCatalogued(resource: string, field: string): boolean {
  return FIELD_CATALOGUE.some((c) => c.resource === resource && c.field === field);
}
