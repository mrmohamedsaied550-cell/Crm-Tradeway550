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
  | 'status_change'
  | 'assignment'
  | 'auto_assignment'
  | 'sla_breach'
  | 'follow_up'
  | 'document'
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

export interface LeadStatus {
  id: string;
  code: string;
  name: string;
  color: string | null;
}

export interface LeadStatusFull extends LeadStatus {
  tenantId: string;
  stageId: string;
  order: number;
  isDefault: boolean;
  stage?: { code: string; name: string; order: number };
  createdAt: string;
  updatedAt: string;
}

export interface PipelineStageWithStatuses extends PipelineStage {
  statuses: Array<{
    id: string;
    code: string;
    name: string;
    color: string | null;
    order: number;
    isDefault: boolean;
  }>;
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
  statusId: string | null;
  status: LeadStatus | null;
  assignedToId: string | null;
  createdById: string | null;
  slaDueAt: string | null;
  slaStatus: SlaStatus;
  lastResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
  captain?: Pick<Captain, 'id' | 'onboardingStatus'> | null;
}

export type DocumentStatus = 'pending' | 'uploaded' | 'approved' | 'rejected';

export interface LeadDocument {
  id: string;
  tenantId: string;
  leadId: string;
  type: string;
  label: string;
  status: DocumentStatus;
  fileUrl: string | null;
  notes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FollowUpMethod = 'call' | 'whatsapp' | 'email' | 'visit' | 'other';
export type FollowUpStatus = 'pending' | 'completed';

export interface LeadFollowUp {
  id: string;
  tenantId: string;
  leadId: string;
  scheduledAt: string;
  method: FollowUpMethod;
  note: string | null;
  status: FollowUpStatus;
  completedAt: string | null;
  completedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ───── Advanced Filter (C30) ─────

export type FilterOperator =
  | 'eq' | 'neq' | 'contains' | 'not_contains'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in' | 'is_null' | 'is_not_null';

export type FilterField =
  | 'stage' | 'status' | 'source' | 'assignedTo'
  | 'slaStatus' | 'createdAt' | 'updatedAt'
  | 'lastResponseAt' | 'name' | 'phone' | 'email';

export interface FilterCondition {
  field: FilterField;
  operator: FilterOperator;
  value?: string | number | boolean | string[];
}

export interface AdvancedFilterRequest {
  allConditions?: FilterCondition[];
  anyConditions?: FilterCondition[];
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'name' | 'slaDueAt' | 'lastResponseAt';
  sortOrder?: 'asc' | 'desc';
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

// ───── Follow-ups (C36) ─────

export type FollowUpActionType = 'call' | 'whatsapp' | 'email' | 'visit' | 'sms' | 'other';

// ───── Bonuses (C32) ─────

export type BonusType = 'fixed' | 'percentage';
export type BonusAccrualStatus = 'pending' | 'approved' | 'paid' | 'rejected';

export interface BonusRule {
  id: string;
  tenantId: string;
  companyId: string;
  countryId: string;
  teamId: string | null;
  roleId: string | null;
  bonusType: BonusType;
  trigger: string;
  amount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BonusAccrual {
  id: string;
  tenantId: string;
  ruleId: string;
  userId: string;
  leadId: string | null;
  amount: number;
  status: BonusAccrualStatus;
  approvedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ───── Competitions (C33) ─────

export type CompetitionMetric = 'leads_converted' | 'calls_made' | 'revenue' | 'custom';
export type CompetitionStatus = 'draft' | 'active' | 'completed' | 'cancelled';

export interface Competition {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  metric: CompetitionMetric;
  status: CompetitionStatus;
  startsAt: string;
  endsAt: string;
  prize: string | null;
  createdAt: string;
  updatedAt: string;
}
