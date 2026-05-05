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
  // Phase D2 — D2.2: manual reactivation override. Bypasses the
  // automatic duplicate-decision engine — used when an admin
  // explicitly wants to re-enroll a Won / active-Captain phone.
  // Grant defaults: super_admin (auto), ops_manager, account_manager.
  // The manual-override UI itself lands in D2.4; D2.2 only registers
  // the capability so the seed has it available.
  {
    code: 'lead.reactivate',
    description: 'Manually reactivate a lead (overrides the duplicate-decision engine)',
  },
  // Phase D3 — D3.3: record a stage-specific status (call disposition,
  // documents-pending sub-state, …) on a lead. Granted to every
  // operating role (sales / activation / driving agent + TL+ + ops);
  // viewers and QA stay read-only. The picker UI is gated on this
  // capability; the requireStatusOnExit enforcement (D3.3, flag-on)
  // also reads it.
  {
    code: 'lead.stage.status.write',
    description: 'Record a stage-specific status on a lead',
  },
  // Phase D3 — D3.4: rotate a lead — change its owner in a controlled,
  // audited way. Distinct from `lead.assign` which is the agent-self-
  // claim path; rotation is a TL+/Ops surface that writes a structured
  // `LeadRotationLog` row + `lead.rotated` audit verb.
  // Default grants: TLs (sales/activation/driving), ops_manager,
  // account_manager, super_admin (auto). NOT granted to agents.
  {
    code: 'lead.rotate',
    description: 'Rotate a lead to a different owner (writes a rotation audit row)',
  },
  // Phase D3 — D3.6: TL Review Queue. Read = list/inspect; resolve =
  // close a row with one of (rotated | kept_owner | escalated |
  // dismissed). Granted to TLs (own team) + ops_manager +
  // account_manager + super_admin. NOT granted to agents — sales /
  // activation / driving never see this surface.
  {
    code: 'lead.review.read',
    description: 'View the TL Review Queue (lead reviews)',
  },
  {
    code: 'lead.review.resolve',
    description: 'Resolve a lead-review row (rotated / kept_owner / escalated / dismissed)',
  },

  // Meta lead-source registration (P2-06)
  { code: 'meta.leadsource.read', description: 'View Meta lead-ad sources (no secrets)' },
  { code: 'meta.leadsource.write', description: 'Create / update / delete Meta lead-ad sources' },

  // CRM — pipeline catalogue (P2-01 read; P2-07 write)
  { code: 'pipeline.read', description: 'View pipelines + their stages' },
  {
    code: 'pipeline.write',
    description: 'Create / update / delete pipelines and their stages',
  },

  // CRM — captains (P2-01 + P2-09)
  { code: 'captain.read', description: 'View captains' },
  { code: 'captain.document.write', description: 'Upload / replace captain documents' },
  { code: 'captain.document.review', description: 'Approve / reject captain documents' },
  { code: 'captain.trip.write', description: 'Ingest captain trip telemetry' },

  // Follow-ups (P2-01)
  { code: 'followup.read', description: 'View follow-ups (all + mine)' },
  { code: 'followup.write', description: 'Create / delete follow-ups' },
  { code: 'followup.complete', description: 'Mark a follow-up done' },

  // WhatsApp (P2-01 + P2-12)
  { code: 'whatsapp.account.read', description: 'View WhatsApp accounts (no secrets)' },
  { code: 'whatsapp.account.write', description: 'Create / update / enable / disable accounts' },
  { code: 'whatsapp.conversation.read', description: 'View conversations + messages' },
  { code: 'whatsapp.message.send', description: 'Send a text message in a conversation' },
  { code: 'whatsapp.handover', description: 'Hand a conversation off to another agent' },
  { code: 'whatsapp.link.lead', description: 'Link a conversation to a lead' },
  { code: 'whatsapp.template.read', description: 'View WhatsApp templates (picker dropdown)' },
  { code: 'whatsapp.template.write', description: 'Create / update / delete WhatsApp templates' },
  { code: 'whatsapp.media.send', description: 'Send image / document media in a conversation' },
  // Phase C — C10B-4: WhatsApp ownership + review-queue + contact
  // capabilities. `assign` is admin-style override (vs. handover, the
  // guided agent action). `close / reopen` gate conversation
  // lifecycle. `review.*` gates the duplicate / captain / unmatched
  // queue (created by the C10B-3 inbound flow). `contact.*` gates
  // editing the cleaned identity fields; `contact.write.raw` is the
  // super-admin-only override for the immutable provider snapshot.
  {
    code: 'whatsapp.conversation.assign',
    description: 'Direct assign / reassign a conversation (admin override)',
  },
  { code: 'whatsapp.conversation.close', description: 'Close an open WhatsApp conversation' },
  { code: 'whatsapp.conversation.reopen', description: 'Reopen a previously closed conversation' },
  {
    code: 'whatsapp.review.read',
    description: 'View the WhatsApp duplicate / captain / unmatched review queue',
  },
  {
    code: 'whatsapp.review.resolve',
    description: 'Resolve a review row (link / new lead / dismiss)',
  },
  { code: 'whatsapp.contact.read', description: 'View Contact rows (cleaned customer identity)' },
  {
    code: 'whatsapp.contact.write',
    description: 'Update Contact cleaned fields (displayName, language)',
  },
  {
    code: 'whatsapp.contact.write.raw',
    description: 'Override the immutable Contact provider snapshot (super-admin only)',
  },

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
  /**
   * Phase C — C2: gate role/permission writes (CRUD on roles, scope
   * + field-permission updates, role duplication). Granted to
   * super_admin (auto via ALL_CAPABILITY_CODES), ops_manager, and
   * account_manager.
   */
  {
    code: 'roles.write',
    description: 'Create / update / delete roles + manage scopes and field permissions',
  },
  { code: 'capabilities.read', description: 'View capabilities' },

  // Tenant settings (P2-08)
  { code: 'tenant.settings.read', description: 'View tenant-level settings' },
  { code: 'tenant.settings.write', description: 'Update tenant-level settings' },
  // Phase D2 — D2.2: dedicated capability for the duplicate /
  // reactivation rules JSON. Separate from the broader
  // tenant.settings.write so an Account Manager can't accidentally
  // (or maliciously) flip cool-off cohorts as part of an unrelated
  // settings PATCH. Grant defaults match tenant.settings.write
  // (super_admin auto + ops_manager + account_manager); the admin
  // panel UI lands in D2.4.
  {
    code: 'tenant.duplicate_rules.write',
    description: 'Edit the tenant-level duplicate / reactivation rules JSON',
  },

  // Backup / export (P3-07) — operator-only export of the tenant's
  // CRM rows as JSON. Sensitive fields (access tokens, password
  // hashes) are stripped at the service boundary, but the dump is
  // still considered HIGHLY sensitive — never grant this to agents.
  { code: 'tenant.export', description: 'Download a JSON export of the tenant CRM data' },

  // Distribution engine (Phase 1A — A6) — admin-side controls for
  // the rule engine that decides who a lead is routed to.
  // - read  → list rules / capacities / routing logs in /admin/distribution
  // - write → create / edit / delete rules + per-user capacity rows
  // Granted to super_admin (auto via ALL_CAPABILITY_CODES),
  // ops_manager, and account_manager.
  {
    code: 'distribution.read',
    description: 'View distribution rules, capacities, and routing logs',
  },
  {
    code: 'distribution.write',
    description: 'Create / update / delete distribution rules and agent capacities',
  },

  // Phase D4 — D4.1: Partner Data Hub. Capabilities are registered
  // now so later D4.x chunks (D4.2 admin, D4.3 sync engine, D4.4
  // verification card, D4.5 controlled merge, D4.6 reconciliation,
  // D4.7 milestones) can gate themselves without a per-chunk
  // capability migration. Default grants live in roles.registry.ts
  // — D4.1 ships conservative defaults: TL+ for source.read /
  // sync.run / verification.read / merge.write / evidence.write /
  // reconciliation.read; Ops / Account Manager (and super_admin
  // auto-bypass) for source.write / milestone.write /
  // reconciliation.resolve. Sales / activation / driving agents
  // hold NONE today; D4.4 will reconsider whether agents should
  // hold partner.verification.read for the read-only PartnerData
  // card on their own leads.
  { code: 'partner.source.read', description: 'View partner sources + sync history' },
  {
    code: 'partner.source.write',
    description: 'Create / update / delete partner sources and field mappings',
  },
  { code: 'partner.sync.run', description: 'Trigger a manual partner sync' },
  {
    code: 'partner.verification.read',
    description: 'View partner verification on leads / captains',
  },
  {
    code: 'partner.merge.write',
    description: 'Apply controlled merge of selected partner fields into a lead / captain',
  },
  {
    code: 'partner.evidence.write',
    description: 'Attach approval evidence (partner record / screenshot / note) to a lead',
  },
  {
    code: 'partner.reconciliation.read',
    description: 'View partner reconciliation reports and discrepancy queue',
  },
  {
    code: 'partner.reconciliation.resolve',
    description: 'Acknowledge / resolve partner reconciliation discrepancies',
  },
  {
    code: 'partner.milestone.write',
    description: 'Create / update / delete partner milestone configurations',
  },
] as const satisfies readonly CapabilityDef[];

export type CapabilityCode = (typeof CAPABILITY_DEFINITIONS)[number]['code'];

export const ALL_CAPABILITY_CODES: readonly CapabilityCode[] = CAPABILITY_DEFINITIONS.map(
  (c) => c.code,
);
