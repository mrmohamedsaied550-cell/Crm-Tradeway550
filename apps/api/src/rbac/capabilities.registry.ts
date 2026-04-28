/**
 * Sprint 1 capability catalogue.
 *
 * Capability codes are part of the application contract. They are the single
 * source of truth used by:
 *   - the seed (creates one Capability row per entry below),
 *   - the future @Capability() guard (decorator strings type-check against
 *     CapabilityCode),
 *   - the OpenAPI spec ("requires capability foo.bar" annotations).
 *
 * Adding a capability later: append to CAPABILITY_DEFINITIONS, ship a migration
 * is NOT required because the table is global; the next seed run upserts.
 */

export interface CapabilityDef {
  readonly code: string;
  readonly description: string;
}

export const CAPABILITY_DEFINITIONS = [
  // Org setup
  { code: 'org.company.read', description: 'View companies' },
  { code: 'org.company.write', description: 'Create / update companies' },
  { code: 'org.country.read', description: 'View countries' },
  { code: 'org.country.write', description: 'Create / update countries' },
  { code: 'org.country.holidays.write', description: 'Manage country holidays' },
  { code: 'org.team.read', description: 'View teams' },
  { code: 'org.team.write', description: 'Create / update teams' },

  // Users
  { code: 'users.read', description: 'View users' },
  { code: 'users.write', description: 'Create / update users (invite)' },
  { code: 'users.disable', description: 'Disable users' },
  { code: 'users.reset', description: 'Reset user password (re-issue invite)' },

  // System / catalogue
  { code: 'audit.read', description: 'View the audit log' },
  { code: 'roles.read', description: 'View roles' },
  { code: 'capabilities.read', description: 'View capabilities' },
] as const satisfies readonly CapabilityDef[];

export type CapabilityCode = (typeof CAPABILITY_DEFINITIONS)[number]['code'];

export const ALL_CAPABILITY_CODES: readonly CapabilityCode[] = CAPABILITY_DEFINITIONS.map(
  (c) => c.code,
);
