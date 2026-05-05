import { ALL_CAPABILITY_CODES, type CapabilityCode } from './capabilities.registry';

/**
 * The 11 roles and their capability sets.
 *
 * Source of truth: PRD Master v2.0 §4 (User Roles & Permissions).
 *
 * `level` is a sortable rank used by future scope guards for hierarchy
 * checks (e.g. "is this user at least a Team Leader?").
 *
 * Capability assignment:
 *   - super_admin gets ALL_CAPABILITY_CODES.
 *   - everyone else gets an explicit list. Adding a new capability defaults
 *     to "no role grants it" until the registry is updated — this is by
 *     design so new permissions are granted intentionally.
 */

export interface RoleDef {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly level: number;
  readonly capabilities: readonly CapabilityCode[];
}

const READ_ORG: readonly CapabilityCode[] = [
  'org.company.read',
  'org.country.read',
  'org.team.read',
];

// Read-everything bundle — every role that touches the CRM at all
// reads the catalogue surfaces (pipeline stages, captains list,
// reports). Only `viewer` gets just this; others extend it.
const READ_CRM: readonly CapabilityCode[] = [
  'lead.read',
  'pipeline.read',
  'captain.read',
  'followup.read',
  'whatsapp.account.read',
  'whatsapp.conversation.read',
  'whatsapp.template.read',
  // Phase C — C10B-4: every CRM-touching role can read Contact
  // identity. Write is gated separately via AGENT_ACTIONS.
  'whatsapp.contact.read',
  'bonus.read',
  'competition.read',
  'report.read',
  'meta.leadsource.read',
  'tenant.settings.read',
];

const AGENT_ACTIONS: readonly CapabilityCode[] = [
  'lead.activity.write',
  'lead.stage.move',
  'lead.assign',
  // Phase D3 — D3.3: agents (sales / activation / driving) record
  // stage-specific statuses (call dispositions etc.) on the leads
  // they handle. TLs inherit via AGENT_ACTIONS; ops_manager /
  // account_manager get it explicitly in their role bundles below.
  'lead.stage.status.write',
  'followup.write',
  'followup.complete',
  'whatsapp.message.send',
  'whatsapp.media.send',
  'whatsapp.link.lead',
  // Phase C — C10B-4: agents can close conversations they own + edit
  // cleaned Contact fields. Reopen + assign + review remain at TL+.
  'whatsapp.conversation.close',
  'whatsapp.contact.write',
  'captain.document.write',
];

const TEAM_LEAD_EXTRAS: readonly CapabilityCode[] = [
  'lead.write',
  'lead.convert',
  'lead.import',
  // Phase D3 — D3.4: TLs rotate leads inside their team scope. Ops /
  // Account Manager get it via their explicit role bundles below.
  'lead.rotate',
  'whatsapp.handover',
  // Phase C — C10B-4: TLs reassign + reopen + see the review queue
  // (resolution is admin-only — see ops_manager / account_manager).
  'whatsapp.conversation.assign',
  'whatsapp.conversation.reopen',
  'whatsapp.review.read',
];

export const ROLE_DEFINITIONS = [
  {
    code: 'super_admin',
    nameAr: 'المشرف العام',
    nameEn: 'Super Admin',
    level: 100,
    capabilities: ALL_CAPABILITY_CODES,
  },
  {
    code: 'ops_manager',
    nameAr: 'مدير العمليات',
    nameEn: 'Operations Manager',
    level: 90,
    capabilities: [
      ...READ_ORG,
      'org.company.write',
      'org.country.write',
      'org.country.holidays.write',
      'org.team.write',
      'users.read',
      'users.write',
      'users.disable',
      'users.reset',
      ...READ_CRM,
      'lead.write',
      'lead.assign',
      'lead.stage.move',
      'lead.activity.write',
      'lead.convert',
      'lead.import',
      // Phase D2 — D2.2: manual reactivation override.
      'lead.reactivate',
      // Phase D3 — D3.3: stage-status write surface (mirrors agents).
      'lead.stage.status.write',
      // Phase D3 — D3.4: rotate leads (cross-team scope for ops).
      'lead.rotate',
      'pipeline.write',
      'meta.leadsource.write',
      'followup.write',
      'followup.complete',
      'whatsapp.account.write',
      'whatsapp.message.send',
      'whatsapp.handover',
      'whatsapp.link.lead',
      'whatsapp.template.write',
      'whatsapp.media.send',
      // Phase C — C10B-4: full WhatsApp admin surface.
      'whatsapp.conversation.assign',
      'whatsapp.conversation.close',
      'whatsapp.conversation.reopen',
      'whatsapp.review.read',
      'whatsapp.review.resolve',
      'whatsapp.contact.write',
      'bonus.write',
      'competition.write',
      'audit.read',
      'roles.read',
      'roles.write',
      'capabilities.read',
      'tenant.settings.write',
      // Phase D2 — D2.2: dedicated grant for the duplicate-rules JSON.
      'tenant.duplicate_rules.write',
      'tenant.export',
      'distribution.read',
      'distribution.write',
      'captain.document.write',
      'captain.document.review',
      'captain.trip.write',
    ],
  },
  {
    code: 'account_manager',
    nameAr: 'مدير الحساب',
    nameEn: 'Account Manager',
    level: 80,
    capabilities: [
      ...READ_ORG,
      'org.team.write',
      'users.read',
      'users.write',
      'users.disable',
      'users.reset',
      ...READ_CRM,
      'lead.write',
      'lead.assign',
      'lead.stage.move',
      'lead.activity.write',
      'lead.convert',
      'lead.import',
      // Phase D2 — D2.2: manual reactivation override (mirrors ops_manager).
      'lead.reactivate',
      // Phase D3 — D3.3: stage-status write surface (mirrors agents).
      'lead.stage.status.write',
      // Phase D3 — D3.4: rotate leads (mirrors ops_manager).
      'lead.rotate',
      'pipeline.write',
      'meta.leadsource.write',
      'followup.write',
      'followup.complete',
      'whatsapp.message.send',
      'whatsapp.handover',
      'whatsapp.link.lead',
      'whatsapp.template.write',
      'whatsapp.media.send',
      // Phase C — C10B-4: full WhatsApp admin surface (mirrors ops_manager).
      'whatsapp.conversation.assign',
      'whatsapp.conversation.close',
      'whatsapp.conversation.reopen',
      'whatsapp.review.read',
      'whatsapp.review.resolve',
      'whatsapp.contact.write',
      'bonus.write',
      'competition.write',
      'audit.read',
      'roles.read',
      'roles.write',
      'capabilities.read',
      'tenant.settings.write',
      // Phase D2 — D2.2: dedicated grant for the duplicate-rules JSON.
      'tenant.duplicate_rules.write',
      'tenant.export',
      'distribution.read',
      'distribution.write',
      'captain.document.write',
      'captain.document.review',
      'captain.trip.write',
    ],
  },
  {
    code: 'tl_sales',
    nameAr: 'قائد فريق المبيعات',
    nameEn: 'Team Leader — Sales',
    level: 60,
    capabilities: [
      ...READ_ORG,
      'users.read',
      'users.write',
      'users.reset',
      ...READ_CRM,
      ...AGENT_ACTIONS,
      ...TEAM_LEAD_EXTRAS,
    ],
  },
  {
    code: 'tl_activation',
    nameAr: 'قائد فريق التنشيط',
    nameEn: 'Team Leader — Activation',
    level: 60,
    capabilities: [
      ...READ_ORG,
      'users.read',
      'users.write',
      'users.reset',
      ...READ_CRM,
      ...AGENT_ACTIONS,
      ...TEAM_LEAD_EXTRAS,
    ],
  },
  {
    code: 'tl_driving',
    nameAr: 'قائد فريق القيادة',
    nameEn: 'Team Leader — Driving',
    level: 60,
    capabilities: [
      ...READ_ORG,
      'users.read',
      'users.write',
      'users.reset',
      ...READ_CRM,
      ...AGENT_ACTIONS,
      ...TEAM_LEAD_EXTRAS,
    ],
  },
  {
    code: 'qa_specialist',
    nameAr: 'أخصائي الجودة',
    nameEn: 'QA Specialist',
    level: 50,
    // Read-only across the CRM; QA scoring lands later. P2-09 also
    // grants document review so QA can sign off on captain
    // onboarding paperwork.
    capabilities: [...READ_ORG, ...READ_CRM, 'audit.read', 'captain.document.review'],
  },
  {
    code: 'sales_agent',
    nameAr: 'وكيل مبيعات',
    nameEn: 'Sales Agent',
    level: 30,
    capabilities: [...READ_ORG, ...READ_CRM, ...AGENT_ACTIONS],
  },
  {
    code: 'activation_agent',
    nameAr: 'وكيل تنشيط',
    nameEn: 'Activation Agent',
    level: 30,
    capabilities: [...READ_ORG, ...READ_CRM, ...AGENT_ACTIONS],
  },
  {
    code: 'driving_agent',
    nameAr: 'وكيل قيادة',
    nameEn: 'Driving Agent',
    level: 30,
    capabilities: [...READ_ORG, ...READ_CRM, ...AGENT_ACTIONS],
  },
  {
    code: 'viewer',
    nameAr: 'مشاهد فقط',
    nameEn: 'Viewer',
    level: 20,
    capabilities: [...READ_ORG, ...READ_CRM, 'users.read', 'roles.read', 'capabilities.read'],
  },
] as const satisfies readonly RoleDef[];

export type RoleCode = (typeof ROLE_DEFINITIONS)[number]['code'];

export const ALL_ROLE_CODES: readonly RoleCode[] = ROLE_DEFINITIONS.map((r) => r.code);
