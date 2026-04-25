import type { User } from '../db/schema/users.js';

export type Role = 'super_admin' | 'manager' | 'team_leader' | 'sales_agent';

const ROLE_LEVEL: Record<Role, number> = {
  super_admin: 100,
  manager: 80,
  team_leader: 60,
  sales_agent: 30,
};

export const CAPABILITIES = {
  // System settings
  'settings.manage': ['super_admin'],
  'companies.manage': ['super_admin', 'manager'],
  'pipeline.manage': ['super_admin', 'manager'],
  'users.manage': ['super_admin', 'manager'],
  'campaigns.manage': ['super_admin', 'manager'],

  // Leads
  'leads.read': ['super_admin', 'manager', 'team_leader', 'sales_agent'],
  'leads.read.all': ['super_admin', 'manager'],
  'leads.read.team': ['team_leader'],
  'leads.read.own': ['sales_agent'],
  'leads.create': ['super_admin', 'manager', 'team_leader', 'sales_agent'],
  'leads.update': ['super_admin', 'manager', 'team_leader', 'sales_agent'],
  'leads.delete': ['super_admin', 'manager'],
  'leads.assign': ['super_admin', 'manager', 'team_leader'],
  'leads.import': ['super_admin', 'manager'],
  'leads.export': ['super_admin', 'manager', 'team_leader'],

  // Approvals
  'approvals.respond': ['super_admin', 'manager', 'team_leader'],

  // Reports
  'reports.read': ['super_admin', 'manager', 'team_leader'],
  'reports.read.all': ['super_admin', 'manager'],
} as const satisfies Record<string, Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export function hasCapability(role: Role, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly Role[]).includes(role);
}

export function roleLevel(role: Role): number {
  return ROLE_LEVEL[role];
}

export function canSupervise(actor: Role, target: Role): boolean {
  return ROLE_LEVEL[actor] > ROLE_LEVEL[target];
}

export type Scope =
  | { type: 'all' }
  | { type: 'country'; countryCode: string }
  | { type: 'team'; teamId: string }
  | { type: 'self'; userId: string };

export function computeScope(user: Pick<User, 'role' | 'countryCode' | 'teamId' | 'id'>): Scope {
  switch (user.role) {
    case 'super_admin':
      return { type: 'all' };
    case 'manager':
      return user.countryCode
        ? { type: 'country', countryCode: user.countryCode }
        : { type: 'all' };
    case 'team_leader':
      return user.teamId
        ? { type: 'team', teamId: user.teamId }
        : { type: 'self', userId: user.id };
    case 'sales_agent':
    default:
      return { type: 'self', userId: user.id };
  }
}
