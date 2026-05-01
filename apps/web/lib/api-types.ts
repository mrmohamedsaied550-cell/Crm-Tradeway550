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

export type CaptainStatus = 'active' | 'inactive' | 'archived';

export interface Captain {
  id: string;
  tenantId: string;
  leadId: string;
  name: string;
  phone: string;
  teamId: string | null;
  status: CaptainStatus;
  onboardingStatus: string;
  hasIdCard: boolean;
  hasLicense: boolean;
  hasVehicleRegistration: boolean;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  /** C37 — denormalised. */
  lastActivityAt?: string | null;
  /** C37 — soonest pending follow-up's dueAt; null when none. */
  nextActionDueAt?: string | null;
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

// ───── WhatsApp (C21 / C22 / C23) ─────

export type ConversationStatus = 'open' | 'closed';
export type WhatsAppDirection = 'inbound' | 'outbound';

export interface WhatsAppConversation {
  id: string;
  tenantId: string;
  accountId: string;
  phone: string;
  status: ConversationStatus;
  lastMessageAt: string;
  lastMessageText: string;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppMessage {
  id: string;
  tenantId: string;
  accountId: string;
  conversationId: string;
  phone: string;
  text: string;
  direction: WhatsAppDirection;
  providerMessageId: string | null;
  status: string;
  createdAt: string;
}

export interface SendConversationMessageResult {
  messageId: string;
  providerMessageId: string;
  conversationId: string;
}

// ───── Bonuses (C32) ─────

export type BonusType =
  | 'first_trip'
  | 'activation'
  | 'trip_milestone'
  | 'conversion_rate'
  | 'manual';

export interface BonusRule {
  id: string;
  tenantId: string;
  companyId: string;
  countryId: string;
  teamId: string | null;
  roleId: string | null;
  bonusType: BonusType;
  trigger: string;
  /** Decimal-as-string from Prisma; render with Number(...) where needed. */
  amount: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ───── Competitions (C33) ─────

export type CompetitionMetric = 'leads_created' | 'activations' | 'first_trips' | 'conversion_rate';

export type CompetitionStatus = 'draft' | 'active' | 'closed';

export interface Competition {
  id: string;
  tenantId: string;
  name: string;
  companyId: string | null;
  countryId: string | null;
  teamId: string | null;
  startDate: string;
  endDate: string;
  metric: CompetitionMetric;
  reward: string;
  status: CompetitionStatus;
  createdAt: string;
  updatedAt: string;
}

// ───── Follow-ups (C36) ─────

export type FollowUpActionType = 'call' | 'whatsapp' | 'visit' | 'other';

export interface LeadFollowUp {
  id: string;
  tenantId: string;
  leadId: string;
  actionType: FollowUpActionType;
  dueAt: string;
  note: string | null;
  completedAt: string | null;
  assignedToId: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on /follow-ups/mine. */
  lead?: { id: string; name: string; phone: string };
}

// ───── WhatsApp accounts (C24A) — read-only client view ─────

/**
 * No-secret projection of a WhatsApp provider account, mirroring the
 * `WhatsAppAccountView` returned by the API. The access token and app
 * secret are never carried over the wire — `hasAppSecret` is the only
 * signal the UI gets about the secret.
 */
export interface WhatsAppAccount {
  id: string;
  tenantId: string;
  displayName: string;
  phoneNumber: string;
  phoneNumberId: string;
  provider: string;
  verifyToken: string;
  hasAppSecret: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
