import { ALL_CAPABILITY_CODES, type CapabilityCode } from './capabilities.registry';

/**
 * The 11 Sprint 1 roles and their capability sets.
 *
 * Source of truth: PRD Master v2.0 §4 (User Roles & Permissions) and
 * Sprint 1 Technical Backlog §4.3.
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
      'org.company.read',
      'org.company.write',
      'org.country.read',
      'org.country.write',
      'org.country.holidays.write',
      'org.team.read',
      'org.team.write',
      'users.read',
      'users.write',
      'users.disable',
      'users.reset',
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
      'roles.read',
      'capabilities.read',
    ],
  },
  {
    code: 'tl_sales',
    nameAr: 'قائد فريق المبيعات',
    nameEn: 'Team Leader — Sales',
    level: 60,
    capabilities: ['org.team.read', 'users.read', 'users.write', 'users.reset'],
  },
  {
    code: 'tl_activation',
    nameAr: 'قائد فريق التنشيط',
    nameEn: 'Team Leader — Activation',
    level: 60,
    capabilities: ['org.team.read', 'users.read', 'users.write', 'users.reset'],
  },
  {
    code: 'tl_driving',
    nameAr: 'قائد فريق القيادة',
    nameEn: 'Team Leader — Driving',
    level: 60,
    capabilities: ['org.team.read', 'users.read', 'users.write', 'users.reset'],
  },
  {
    code: 'qa_specialist',
    nameAr: 'أخصائي الجودة',
    nameEn: 'QA Specialist',
    level: 50,
    capabilities: [],
  },
  {
    code: 'sales_agent',
    nameAr: 'وكيل مبيعات',
    nameEn: 'Sales Agent',
    level: 30,
    capabilities: [],
  },
  {
    code: 'activation_agent',
    nameAr: 'وكيل تنشيط',
    nameEn: 'Activation Agent',
    level: 30,
    capabilities: [],
  },
  {
    code: 'driving_agent',
    nameAr: 'وكيل قيادة',
    nameEn: 'Driving Agent',
    level: 30,
    capabilities: [],
  },
  {
    code: 'viewer',
    nameAr: 'مشاهد فقط',
    nameEn: 'Viewer',
    level: 20,
    capabilities: [...READ_ORG, 'users.read', 'roles.read', 'capabilities.read'],
  },
] as const satisfies readonly RoleDef[];

export type RoleCode = (typeof ROLE_DEFINITIONS)[number]['code'];

export const ALL_ROLE_CODES: readonly RoleCode[] = ROLE_DEFINITIONS.map((r) => r.code);
