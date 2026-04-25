import type { Capability, Role } from '@crm/shared';
import { prisma } from './prisma.js';
import { forbidden } from './errors.js';

export interface AuthUser {
  id: string;
  role: Role;
  email: string;
}

const READ_ALL: Capability[] = [
  'user.read',
  'company.read',
  'country.read',
  'companyCountry.read',
  'contact.read',
  'enrollment.read',
  'pipeline.read',
];

const WRITE_ALL: Capability[] = [
  'user.create',
  'user.update',
  'user.assign',
  'company.write',
  'country.write',
  'companyCountry.write',
  'contact.write',
  'enrollment.create',
  'enrollment.update',
  'enrollment.assign',
  'enrollment.changeStage',
  'enrollment.note',
  'pipeline.write',
  'approval.act',
];

const CAPS: Record<Role, Capability[]> = {
  super_admin: [...READ_ALL, ...WRITE_ALL],
  ops_manager: READ_ALL,
  account_manager: [...READ_ALL, ...WRITE_ALL],
  tl_sales: [
    ...READ_ALL,
    'enrollment.create',
    'enrollment.update',
    'enrollment.assign',
    'enrollment.changeStage',
    'enrollment.note',
    'contact.write',
    'user.assign',
  ],
  tl_activation: [
    ...READ_ALL,
    'enrollment.update',
    'enrollment.assign',
    'enrollment.changeStage',
    'enrollment.note',
  ],
  tl_driving: [
    ...READ_ALL,
    'enrollment.update',
    'enrollment.assign',
    'enrollment.changeStage',
    'enrollment.note',
  ],
  qa_specialist: [...READ_ALL, 'enrollment.note'],
  sales_agent: [
    ...READ_ALL,
    'enrollment.create',
    'enrollment.update',
    'enrollment.changeStage',
    'enrollment.note',
    'contact.write',
  ],
  activation_agent: [
    ...READ_ALL,
    'enrollment.update',
    'enrollment.changeStage',
    'enrollment.note',
  ],
  driving_agent: [...READ_ALL, 'enrollment.update', 'enrollment.changeStage', 'enrollment.note'],
  team_member: READ_ALL,
};

export const hasCapability = (role: Role, cap: Capability): boolean =>
  CAPS[role].includes(cap);

export const requireCapability = (user: AuthUser, cap: Capability): void => {
  if (!hasCapability(user.role, cap)) throw forbidden(`Missing capability: ${cap}`);
};

export interface Scope {
  /** null = no restriction (super_admin / ops_manager all-countries-readonly) */
  companyCountryIds: string[] | null;
  /** null = unrestricted; otherwise allowed user ids for this scope (TL = team, agent = self) */
  userIds: string[] | null;
  /** agent: only enrollments assigned to them; TL: team enrollments + unassigned in their cc */
  scopeKind: 'all' | 'country' | 'team' | 'self';
  selfId: string;
}

export async function buildScope(user: AuthUser): Promise<Scope> {
  if (user.role === 'super_admin' || user.role === 'ops_manager' || user.role === 'qa_specialist') {
    return {
      companyCountryIds: null,
      userIds: null,
      scopeKind: 'all',
      selfId: user.id,
    };
  }

  const assignments = await prisma.userAssignment.findMany({
    where: { userId: user.id },
    select: { companyCountryId: true, parentUserId: true },
  });
  const ccIds = assignments.map((a) => a.companyCountryId);

  if (user.role === 'account_manager') {
    return { companyCountryIds: ccIds, userIds: null, scopeKind: 'country', selfId: user.id };
  }

  if (user.role === 'tl_sales' || user.role === 'tl_activation' || user.role === 'tl_driving') {
    const team = await prisma.userAssignment.findMany({
      where: { parentUserId: user.id },
      select: { userId: true },
    });
    const userIds = [user.id, ...team.map((t) => t.userId)];
    return { companyCountryIds: ccIds, userIds, scopeKind: 'team', selfId: user.id };
  }

  // agents (sales/activation/driving) and team_member
  return {
    companyCountryIds: ccIds,
    userIds: [user.id],
    scopeKind: 'self',
    selfId: user.id,
  };
}

/** Build a Prisma `where` filter from a Scope for the `Enrollment` model. */
export function enrollmentScopeWhere(scope: Scope): Record<string, unknown> {
  if (scope.scopeKind === 'all') return {};
  const where: Record<string, unknown> = {};
  if (scope.companyCountryIds !== null) {
    where.companyCountryId = { in: scope.companyCountryIds };
  }
  if (scope.scopeKind === 'self') {
    where.assigneeId = scope.selfId;
  } else if (scope.scopeKind === 'team' && scope.userIds) {
    // team members' assigned + unassigned in their CC
    where.OR = [{ assigneeId: { in: scope.userIds } }, { assigneeId: null }];
  }
  return where;
}

/** Build a Prisma `where` filter from a Scope for the `User` model. */
export function userScopeWhere(scope: Scope): Record<string, unknown> {
  if (scope.scopeKind === 'all') return {};
  if (scope.scopeKind === 'country' || scope.scopeKind === 'team') {
    return {
      assignments: {
        some: { companyCountryId: { in: scope.companyCountryIds ?? [] } },
      },
    };
  }
  return { id: scope.selfId };
}
