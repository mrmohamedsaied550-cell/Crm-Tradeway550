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
  /** Phase C — C2: TRUE for the 11 seeded role templates. Immutable in the UI. */
  isSystem: boolean;
  description: string | null;
  capabilitiesCount: number;
}

/** Phase C — C8: full role payload returned by GET /rbac/roles/:id. */
export interface RoleScopeRow {
  resource: 'lead' | 'captain' | 'followup' | 'whatsapp.conversation';
  scope: 'own' | 'team' | 'company' | 'country' | 'global';
}

export interface RoleFieldPermissionRow {
  resource: string;
  field: string;
  canRead: boolean;
  canWrite: boolean;
}

export interface RoleDetail {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  level: number;
  isActive: boolean;
  isSystem: boolean;
  description: string | null;
  capabilities: readonly string[];
  scopes: readonly RoleScopeRow[];
  fieldPermissions: readonly RoleFieldPermissionRow[];
}

export interface CapabilityCatalogueEntry {
  id: string;
  code: string;
  description: string;
}

export interface FieldCatalogueEntry {
  resource: 'lead';
  field: string;
  sensitive: boolean;
  defaultRead: boolean;
  defaultWrite: boolean;
  labelEn: string;
}

/**
 * Phase C — C9: shape returned by /users/:id/scope-assignments.
 *
 * Joined to the company / country tables so the UI can render
 * names without a follow-up round-trip. The PUT body sends only
 * the id arrays — names are derived server-side.
 */
export interface UserScopeCompanyRef {
  id: string;
  code: string;
  name: string;
}
export interface UserScopeCountryRef {
  id: string;
  code: string;
  name: string;
  companyId: string;
}
export interface UserScopeAssignments {
  companies: readonly UserScopeCompanyRef[];
  countries: readonly UserScopeCountryRef[];
}

export interface PipelineStage {
  id: string;
  code: string;
  name: string;
  order: number;
  isTerminal: boolean;
  /**
   * Phase A — A6: classifies a terminal stage as 'won' or 'lost'.
   * Drives `Lead.lifecycleState` on stage moves. Returned by every
   * stage-lookup endpoint (resolve / stagesOf / list) so the lead
   * detail page can detect lost-stage moves and prompt for a reason.
   */
  terminalKind: 'won' | 'lost' | null;
}

/**
 * Phase 1B — well-known stage codes seeded into the tenant default
 * pipeline. Custom pipelines may define any other codes; the API
 * treats `stage.code` as an open string.
 *
 * `LeadStageCode` is intentionally `string` (not a literal union)
 * so callers can pass codes from custom pipelines. Use
 * `WELL_KNOWN_STAGE_CODES` / `WellKnownLeadStageCode` when you need
 * to special-case one of the canonical 5 (e.g. show the "convert to
 * captain" CTA only when `stage.code === 'converted'`).
 */
export type LeadStageCode = string;
export const WELL_KNOWN_STAGE_CODES = [
  'new',
  'contacted',
  'interested',
  'converted',
  'lost',
] as const;
export type WellKnownLeadStageCode = (typeof WELL_KNOWN_STAGE_CODES)[number];
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
  firstTripAt: string | null;
  tripCount: number;
  createdAt: string;
  updatedAt: string;
}

// ───── Captain documents + trips (P2-09) ─────

export type CaptainDocumentStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface CaptainDocument {
  id: string;
  tenantId: string;
  captainId: string;
  kind: string;
  storageRef: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: CaptainDocumentStatus;
  expiresAt: string | null;
  reviewerUserId: string | null;
  reviewer?: { id: string; name: string; email: string } | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  uploadedById: string | null;
  uploadedBy?: { id: string; name: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaptainTripRow {
  id: string;
  tenantId: string;
  captainId: string;
  tripId: string;
  occurredAt: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface RecordTripResult {
  tripId: string;
  duplicate: boolean;
  captainId: string;
  firstTripAt: string | null;
  tripCount: number;
  recordId?: string;
}

/**
 * Phase A — A4: rich attribution payload stored on `Lead.attribution`
 * (JSONB on the API side). `source` always mirrors `Lead.source` —
 * the API enforces the invariant. All other fields are optional.
 */
export interface AttributionRef {
  id?: string;
  name?: string;
}
export interface AttributionUtm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}
export interface AttributionPayload {
  source: LeadSource;
  subSource?: string;
  campaign?: AttributionRef;
  adSet?: AttributionRef;
  ad?: AttributionRef;
  utm?: AttributionUtm;
  referrer?: string;
  custom?: Record<string, unknown>;
}

export interface Lead {
  id: string;
  tenantId: string;
  name: string;
  phone: string;
  email: string | null;
  source: LeadSource;
  /**
   * Phase A — A4: rich attribution. Mirrors `source` plus optional
   * sub-source / campaign / ad-set / ad / utm fields. Populated on
   * every create path (manual, Meta webhook, CSV import). Null on
   * very old rows that pre-date A1.
   */
  attribution: AttributionPayload | null;
  /**
   * Phase A — lifecycle classifier derived from the lead's current
   * stage's `terminalKind`. Single source of truth for "is this lead
   * in the funnel, won, lost, or archived?"
   */
  lifecycleState: LeadLifecycleState;
  /** Phase A — required when lifecycleState='lost'. */
  lostReasonId: string | null;
  lostNote: string | null;
  /**
   * Phase 1B — explicit (company × country) scope on the lead.
   * Both nullable: when missing the lead runs on the tenant default
   * pipeline. Populated from the create form / Meta source / CSV
   * import going forward.
   */
  companyId: string | null;
  countryId: string | null;
  /**
   * Phase 1B — denormalised pipeline pointer. Always equals
   * `stage.pipelineId`; carried on the row so Kanban + reporting
   * can filter by pipeline without a join. Nullable today (legacy
   * leads pre-1B); will be promoted to non-null after a backfill
   * window closes.
   */
  pipelineId: string | null;
  stageId: string;
  /**
   * `code` is now an open string (a pipeline can define any code it
   * wants). The `LeadStageCode` literal is kept only as a "well-known
   * codes" reference for callers that still need to pattern-match
   * against the canonical 5 (e.g. "is this lead converted?").
   */
  stage: { code: string; name: string; order: number; isTerminal: boolean };
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
  /**
   * Phase C — C4/C6: per-(resource × field) read/write toggles for
   * the user's role. Empty array on the super_admin bypass. The
   * client-side `permissions.ts` lib + `<FieldGated>` UI consume
   * this list to mirror the server-side filter — UX guidance only;
   * the API is the source of truth.
   */
  fieldPermissions: ReadonlyArray<{
    resource: string;
    field: string;
    canRead: boolean;
    canWrite: boolean;
  }>;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: MeUser;
}

/** P2-10 — `/auth/refresh` shape. Matches LoginResponse on the wire. */
export type RefreshResponse = LoginResponse;

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
  /** P2-12 — most recent inbound timestamp; drives the 24h window. */
  lastInboundAt?: string | null;
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
  /** P2-12 — message kind. Existing rows backfill to 'text'. */
  messageType?: 'text' | 'template' | 'image' | 'document';
  mediaUrl?: string | null;
  mediaMimeType?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
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

// ───── Bonus accruals (P2-03) ─────

export type BonusAccrualStatus = 'pending' | 'paid' | 'void';

export interface BonusAccrual {
  id: string;
  tenantId: string;
  bonusRuleId: string;
  recipientUserId: string;
  captainId: string | null;
  triggerKind: string;
  amount: string; // Decimal-as-string
  status: BonusAccrualStatus;
  payload: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  bonusRule?: { id: string; bonusType: string; trigger: string; amount: string };
  recipient?: { id: string; name: string; email: string };
  captain?: { id: string; name: string; phone: string } | null;
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
  /**
   * Phase A — A5: when set + > now, the row is hidden from `pending`
   * / `overdue` lists and from the bell-badge counters. The lead's
   * `nextActionDueAt` uses `MAX(dueAt, snoozedUntil)` for display.
   * `null` (or in the past) means no active snooze.
   */
  snoozedUntil: string | null;
  assignedToId: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on /follow-ups/mine. */
  lead?: { id: string; name: string; phone: string };
}

/** Phase A — A5: bell-badge counters payload from `/follow-ups/me/summary`. */
export interface FollowUpSummary {
  overdueCount: number;
  dueTodayCount: number;
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

// ───── Tenant settings (P2-08) ─────

/**
 * Per-tenant runtime knobs. Drives SLA window, the default dial code
 * for local-format phone input, and the timezone used by "due today"
 * calculations on the agent workspace.
 */
/**
 * PL-3 — distribution rule. One per source the operator wants to
 * route directly to a specific agent. The autoAssign path checks
 * for a matching rule first; when the listed user is no longer
 * eligible, autoAssign silently falls back to round-robin.
 */
export interface DistributionRule {
  source: LeadSource;
  assigneeUserId: string;
}

export interface TenantSettingsRow {
  tenantId: string;
  timezone: string;
  slaMinutes: number;
  defaultDialCode: string;
  distributionRules: DistributionRule[];
  createdAt: string;
  updatedAt: string;
}

// ───── WhatsApp templates + media (P2-12) ─────

export type WhatsAppTemplateStatus = 'approved' | 'paused' | 'rejected';
export type WhatsAppTemplateCategory = 'marketing' | 'utility' | 'authentication';
export type WhatsAppMessageType = 'text' | 'template' | 'image' | 'document';

export interface WhatsAppTemplateRow {
  id: string;
  tenantId: string;
  accountId: string;
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  bodyText: string;
  variableCount: number;
  status: WhatsAppTemplateStatus;
  createdAt: string;
  updatedAt: string;
}

// ───── Pipelines (P2-07) ─────

/**
 * One administered pipeline definition. The tenant-default carries
 * `isDefault = true` and is the only pipeline the lead-lifecycle
 * code paths resolve stages against. Additional pipelines exist
 * for per-(company × country) overrides.
 */
export interface Pipeline {
  id: string;
  tenantId: string;
  companyId: string | null;
  countryId: string | null;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Present on list endpoints. */
  _count?: { stages: number };
  /** Lightweight join shape from the API. */
  company?: { id: string; code: string; name: string } | null;
  country?: { id: string; code: string; name: string } | null;
  /** Present on detail endpoints. */
  stages?: PipelineStageRow[];
}

export interface PipelineStageRow {
  id: string;
  pipelineId: string;
  tenantId: string;
  code: string;
  name: string;
  order: number;
  isTerminal: boolean;
  /**
   * Phase A — A6: classifies a terminal stage as 'won' or 'lost'.
   * Drives `Lead.lifecycleState` on stage moves. NULL on
   * non-terminal stages and on terminal stages that are neither
   * (admin-configurable via Pipeline Builder).
   */
  terminalKind: 'won' | 'lost' | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Phase A — A6: per-tenant rejection-reason catalogue. Populated by
 * the seed; admins edit via /admin/lost-reasons. The 'other' code is
 * protected from deactivation.
 */
export interface LostReason {
  id: string;
  tenantId: string;
  code: string;
  labelEn: string;
  labelAr: string;
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Phase A — A6: lead lifecycle classifier. Computed from stage.terminalKind. */
export type LeadLifecycleState = 'open' | 'won' | 'lost' | 'archived';

// ───── Meta lead-ad sources (P2-06) ─────

/**
 * Routing config for a Facebook Page (or Page+Form) the tenant runs
 * lead ads on. `appSecret` is intentionally never returned to the
 * client — the API exposes only the public-facing fields.
 */
export interface MetaLeadSource {
  id: string;
  tenantId: string;
  displayName: string;
  pageId: string;
  formId: string | null;
  verifyToken: string;
  defaultSource: LeadSource;
  fieldMapping: Record<string, string>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ───── Distribution Engine (Phase 1A — A8) ─────

export type DistributionStrategyName = 'specific_user' | 'round_robin' | 'weighted' | 'capacity';

export const ALL_DISTRIBUTION_STRATEGIES: readonly DistributionStrategyName[] = [
  'specific_user',
  'round_robin',
  'weighted',
  'capacity',
] as const;

/**
 * Per-user reasons recorded in `lead_routing_logs.excluded_reasons`.
 * Mirrors the `ExclusionReason` union on the API side; UI surfaces
 * these strings in the routing-log row drilldown.
 */
export type DistributionExclusionReason =
  | 'not_eligible_role'
  | 'inactive_user'
  | 'excluded_by_caller'
  | 'wrong_team'
  | 'unavailable'
  | 'out_of_office'
  | 'outside_working_hours'
  | 'at_capacity';

export interface DistributionRuleRow {
  id: string;
  tenantId: string;
  name: string;
  isActive: boolean;
  priority: number;
  source: LeadSource | null;
  companyId: string | null;
  countryId: string | null;
  targetTeamId: string | null;
  strategy: DistributionStrategyName;
  targetUserId: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCapacityRow {
  userId: string;
  tenantId: string;
  weight: number;
  isAvailable: boolean;
  outOfOfficeUntil: string | null;
  maxActiveLeads: number | null;
  /**
   * Per-day { start: "HH:MM", end: "HH:MM" }. The candidate-filter
   * implementation that consumes this lands in a follow-up; the
   * column is stored + read-through as JSON today.
   */
  workingHours: Record<string, { start: string; end: string }> | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadRoutingLogRow {
  id: string;
  tenantId: string;
  leadId: string;
  ruleId: string | null;
  strategy: DistributionStrategyName;
  chosenUserId: string | null;
  candidateCount: number;
  excludedCount: number;
  excludedReasons: Record<string, DistributionExclusionReason>;
  decidedAt: string;
  requestId: string | null;
}
