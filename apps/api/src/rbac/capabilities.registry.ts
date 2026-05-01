/**
 * Capability catalogue.
 *
 * Capability codes are part of the application contract. They are the single
 * source of truth used by:
 *   - the seed (creates one Capability row per entry below),
 *   - the @RequireCapability() guard,
 *   - the OpenAPI spec ("requires capability foo.bar" annotations).
 *
 * Adding a capability later: append to CAPABILITY_DEFINITIONS, no migration
 * needed because the table is global; the next seed run upserts.
 */

export interface CapabilityDef {
  readonly code: string;
  readonly description: string;
}

export const CAPABILITY_DEFINITIONS = [
  // Org setup
  { code: 'org.company.read', description: 'View companies' },
  { code: 'org.company.write', description: 'Create / update / delete companies' },
  { code: 'org.country.read', description: 'View countries' },
  { code: 'org.country.write', description: 'Create / update / delete countries' },
  { code: 'org.country.holidays.write', description: 'Manage country holidays' },
  { code: 'org.team.read', description: 'View teams' },
  { code: 'org.team.write', description: 'Create / update / delete teams' },

  // Users
  { code: 'users.read', description: 'View users' },
  { code: 'users.write', description: 'Create / update users (invite)' },
  { code: 'users.disable', description: 'Disable users' },
  { code: 'users.reset', description: 'Reset user password (re-issue invite)' },

  // CRM — leads (P2-01)
  { code: 'lead.read', description: 'View leads' },
  { code: 'lead.write', description: 'Create / update / delete leads' },
  { code: 'lead.assign', description: 'Assign / auto-assign leads' },
  { code: 'lead.stage.move', description: 'Move a lead between pipeline stages' },
  { code: 'lead.activity.write', description: 'Log notes / calls on a lead' },
  { code: 'lead.convert', description: 'Convert a lead to a captain' },
  { code: 'lead.import', description: 'Bulk-import leads (CSV / external feed)' },

  // Meta lead-source registration (P2-06)
  { code: 'meta.leadsource.read', description: 'View Meta lead-ad sources (no secrets)' },
  { code: 'meta.leadsource.write', description: 'Create / update / delete Meta lead-ad sources' },

  // CRM — pipeline catalogue (P2-01 read; P2-07 write)
  { code: 'pipeline.read', description: 'View pipelines + their stages' },
  {
    code: 'pipeline.write',
    description: 'Create / update / delete pipelines and their stages',
  },

  // CRM — captains (P2-01)
  { code: 'captain.read', description: 'View captains' },

  // Follow-ups (P2-01)
  { code: 'followup.read', description: 'View follow-ups (all + mine)' },
  { code: 'followup.write', description: 'Create / delete follow-ups' },
  { code: 'followup.complete', description: 'Mark a follow-up done' },

  // WhatsApp (P2-01)
  { code: 'whatsapp.account.read', description: 'View WhatsApp accounts (no secrets)' },
  { code: 'whatsapp.account.write', description: 'Create / update / enable / disable accounts' },
  { code: 'whatsapp.conversation.read', description: 'View conversations + messages' },
  { code: 'whatsapp.message.send', description: 'Send a text message in a conversation' },
  { code: 'whatsapp.handover', description: 'Hand a conversation off to another agent' },
  { code: 'whatsapp.link.lead', description: 'Link a conversation to a lead' },

  // Bonuses (P2-01)
  { code: 'bonus.read', description: 'View bonus rules' },
  { code: 'bonus.write', description: 'Create / update / enable / disable / delete bonus rules' },

  // Competitions (P2-01)
  { code: 'competition.read', description: 'View competitions + leaderboard' },
  {
    code: 'competition.write',
    description: 'Create / update / status-change / delete competitions',
  },

  // Reports (P2-01)
  { code: 'report.read', description: 'View tenant-level reports' },

  // System / catalogue
  { code: 'audit.read', description: 'View the audit log' },
  { code: 'roles.read', description: 'View roles' },
  { code: 'capabilities.read', description: 'View capabilities' },

  // Tenant settings (P2-08)
  { code: 'tenant.settings.read', description: 'View tenant-level settings' },
  { code: 'tenant.settings.write', description: 'Update tenant-level settings' },
] as const satisfies readonly CapabilityDef[];

export type CapabilityCode = (typeof CAPABILITY_DEFINITIONS)[number]['code'];

export const ALL_CAPABILITY_CODES: readonly CapabilityCode[] = CAPABILITY_DEFINITIONS.map(
  (c) => c.code,
);
