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
  'bonus.read',
  'competition.read',
  'report.read',
];

const AGENT_ACTIONS: readonly CapabilityCode[] = [
  'lead.activity.write',
  'lead.stage.move',
  'lead.assign',
  'followup.write',
  'followup.complete',
  'whatsapp.message.send',
  'whatsapp.link.lead',
];

const TEAM_LEAD_EXTRAS: readonly CapabilityCode[] = [
  'lead.write',
  'lead.convert',
  'whatsapp.handover',
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
      'followup.write',
      'followup.complete',
      'whatsapp.account.write',
      'whatsapp.message.send',
      'whatsapp.handover',
      'whatsapp.link.lead',
      'bonus.write',
      'competition.write',
      'audit.read',
      'roles.read',
      'capabilities.read',
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
      'followup.write',
      'followup.complete',
      'whatsapp.message.send',
      'whatsapp.handover',
      'whatsapp.link.lead',
      'bonus.write',
      'competition.write',
      'audit.read',
      'roles.read',
      'capabilities.read',
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
    // Read-only across the CRM; QA scoring lands later.
    capabilities: [...READ_ORG, ...READ_CRM, 'audit.read'],
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
