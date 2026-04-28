/**
 * TypeScript shapes mirroring the backend DTOs.
 *
 * These are hand-written so the web bundle doesn't have to import the API's
 * Prisma types. They cover only the fields the C13 admin screens read.
 */

export interface Company {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Country {
  id: string;
  tenantId: string;
  companyId: string;
  code: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Team {
  id: string;
  tenantId: string;
  countryId: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type UserStatus = 'active' | 'invited' | 'disabled';

export interface AdminUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  phone: string | null;
  language: string;
  roleId: string;
  teamId: string | null;
  status: UserStatus;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface RoleSummary {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  level: number;
  capabilitiesCount: number;
}

export interface PipelineStage {
  id: string;
  code: string;
  name: string;
  order: number;
  isTerminal: boolean;
}

export type LeadStageCode = 'new' | 'contacted' | 'interested' | 'converted' | 'lost';
export type LeadSource = 'manual' | 'meta' | 'tiktok' | 'whatsapp' | 'import';
export type SlaStatus = 'active' | 'breached' | 'paused';
export type LeadActivityType =
  | 'note'
  | 'call'
  | 'stage_change'
  | 'assignment'
  | 'auto_assignment'
  | 'sla_breach'
  | 'system';

export interface Captain {
  id: string;
  onboardingStatus: string;
  hasIdCard: boolean;
  hasLicense: boolean;
  hasVehicleRegistration: boolean;
  activatedAt: string | null;
}

export interface Lead {
  id: string;
  tenantId: string;
  name: string;
  phone: string;
  email: string | null;
  source: LeadSource;
  stageId: string;
  stage: { code: LeadStageCode; name: string; order: number; isTerminal: boolean };
  assignedToId: string | null;
  createdById: string | null;
  slaDueAt: string | null;
  slaStatus: SlaStatus;
  lastResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
  captain?: Pick<Captain, 'id' | 'onboardingStatus'> | null;
}

export interface LeadActivity {
  id: string;
  type: LeadActivityType;
  body: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
  createdById: string | null;
}

export interface MeUser {
  id: string;
  email: string;
  name: string;
  language: string;
  roleId: string;
  role: {
    id: string;
    code: string;
    nameAr: string;
    nameEn: string;
    level: number;
  };
  capabilities: readonly string[];
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: MeUser;
}
