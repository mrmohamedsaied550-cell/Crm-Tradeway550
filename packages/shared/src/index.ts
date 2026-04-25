export const ROLES = [
  'super_admin',
  'ops_manager',
  'account_manager',
  'tl_sales',
  'sales_agent',
  'tl_activation',
  'activation_agent',
  'tl_driving',
  'driving_agent',
  'qa_specialist',
  'team_member',
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LEVEL: Record<Role, number> = {
  super_admin: 100,
  ops_manager: 90,
  account_manager: 80,
  tl_sales: 60,
  tl_activation: 60,
  tl_driving: 60,
  qa_specialist: 50,
  sales_agent: 30,
  activation_agent: 30,
  driving_agent: 30,
  team_member: 10,
};

export const CAPABILITIES = [
  'user.read',
  'user.create',
  'user.update',
  'user.assign',
  'company.read',
  'company.write',
  'country.read',
  'country.write',
  'companyCountry.read',
  'companyCountry.write',
  'contact.read',
  'contact.write',
  'enrollment.read',
  'enrollment.create',
  'enrollment.update',
  'enrollment.assign',
  'enrollment.changeStage',
  'enrollment.note',
  'pipeline.read',
  'pipeline.write',
  'approval.act',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type ScopeResource = 'enrollment' | 'user' | 'contact';

export type EnrollmentStageEvent =
  | 'created'
  | 'stage_changed'
  | 'assigned'
  | 'note_added'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_rejected';
