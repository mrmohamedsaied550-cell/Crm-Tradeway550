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
  // Phase D3 — D3.2: emitted by the SLA threshold engine when a lead
  // crosses the ladder buckets (ok ↔ t75 ↔ t100 ↔ t150 ↔ t200). The
  // backend records the row; D3.2 ships the type union + a minimal
  // timeline label so the row renders without a raw enum leak. Full
  // visual treatment (per-bucket tone, threshold ladder) lands in
  // D3.7 polish.
  | 'sla_threshold_crossed'
  // Phase D3 — D3.3: emitted by LeadStageStatusService.setStatus
  // when an agent records a stage-specific status (call disposition,
  // docs-pending sub-state, …). Inert when D3_ENGINE_V1=false.
  | 'stage_status_changed'
  // Phase D3 — D3.4: emitted by RotationService.rotateLead alongside
  // the structured `LeadRotationLog` row + `lead.rotated` audit verb.
  // Sales agents see a sanitised summary (no from/to user names);
  // TL+ see the full chain. Inert when D3_ENGINE_V1=false.
  | 'rotation'
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
  /**
   * Phase D2 — D2.1: multi-attempt fields. Defaults to `1` for first
   * attempts and every legacy row; reactivation cycles (D2.3 onwards)
   * bump it. Optional in the typed surface so older API responses
   * that pre-date D2.1 still parse cleanly.
   */
  attemptIndex?: number;
  previousLeadId?: string | null;
  reactivatedAt?: string | null;
  reactivationRule?: string | null;
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

// ───── WhatsApp (C21 / C22 / C23 + D1.1 ownership) ─────

export type ConversationStatus = 'open' | 'closed';
export type WhatsAppDirection = 'inbound' | 'outbound';
/** D1.1 — provenance of the current ownership row. */
export type AssignmentSource =
  | 'inbound_route'
  | 'manual_handover'
  | 'outbound_self'
  | 'migrated'
  | 'lead_propagation';

/**
 * D1.1 — Contact identity (cleaned, safe projection).
 *
 * The backend exposes only the safe fields to non-super-admin users.
 * `rawProfile`, `originalPhone`, `originalDisplayName` are NEVER
 * returned in this shape and the frontend should never request them.
 */
export interface Contact {
  id: string;
  tenantId: string;
  phone: string;
  displayName: string | null;
  language: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  isCaptain: boolean;
  hasOpenLead: boolean;
  createdAt: string;
  updatedAt: string;
}

/** D1.1 — owner mini-profile included in conversation list / detail. */
export interface ConversationOwner {
  id: string;
  name: string;
  email: string;
  teamId: string | null;
}

/** D1.1 — minimal Contact projection embedded in conversation list. */
export interface ConversationContactSummary {
  id: string;
  phone: string;
  displayName: string | null;
  language: string | null;
  isCaptain: boolean;
  hasOpenLead: boolean;
}

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
  /** C25 — link to a Lead in the same tenant. */
  leadId?: string | null;
  /** D1.1 — C10B-1 ownership chain. */
  contactId?: string | null;
  assignedToId?: string | null;
  teamId?: string | null;
  companyId?: string | null;
  countryId?: string | null;
  assignmentSource?: AssignmentSource | null;
  assignedAt?: string | null;
  /** D1.1 — populated when the backend `include` is asked for. */
  assignedTo?: ConversationOwner | null;
  contact?: ConversationContactSummary | null;
  /** Lead embedded by `findConversationById`; minimal subset for the side panel. */
  lead?: ConversationLeadSummary | null;
  createdAt: string;
  updatedAt: string;
}

/** D1.1 — minimal lead embedded into the conversation detail response.
 *
 * D1.4 — extended with the SLA / next-action / activity fields that
 * the existing `findConversationById` include already returns on the
 * wire (Prisma `include: { lead: { include: { stage: true } } }`
 * brings the full Lead row). The side panel renders them; declaring
 * them here makes the typed surface honest.
 */
export interface ConversationLeadSummary {
  id: string;
  name: string;
  phone: string;
  stageId: string;
  pipelineId?: string | null;
  lifecycleState: string;
  assignedToId: string | null;
  companyId: string | null;
  countryId: string | null;
  stage?: {
    id: string;
    code: string;
    name: string;
    isTerminal: boolean;
    terminalKind: string | null;
  };
  /** D1.4 — denormalised SLA fields. Optional so older payloads parse. */
  slaStatus?: SlaStatus;
  slaDueAt?: string | null;
  /** D1.4 — soonest pending follow-up's dueAt; null when none. */
  nextActionDueAt?: string | null;
  lastActivityAt?: string | null;
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

// ───── D1.1 — WhatsApp review queue ─────

export type ReviewReason = 'captain_active' | 'duplicate_lead' | 'unmatched_after_routing';
export type ReviewResolution = 'linked_to_lead' | 'linked_to_captain' | 'new_lead' | 'dismissed';

export interface ReviewContextSnapshotEntry {
  text: string;
  createdAt: string;
}

export interface WhatsAppConversationReview {
  id: string;
  tenantId: string;
  conversationId: string;
  contactId: string;
  reason: ReviewReason;
  candidateLeadIds: string[];
  candidateCaptainId: string | null;
  contextSnapshot: ReviewContextSnapshotEntry[] | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedById: string | null;
  resolution: ReviewResolution | null;
  /** Joined when listing/getting; not always present. */
  conversation?: WhatsAppConversation;
  contact?: Contact;
}

export interface ReviewListResult {
  items: WhatsAppConversationReview[];
  total: number;
  limit: number;
  offset: number;
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

/**
 * Phase D2 — D2.5: enriched attempt row returned by
 * `leadsApi.attempts(id)`. Stage / lostReason / assignedTo are
 * pre-joined for display; the UI reads them straight from the row
 * without follow-up fetches.
 */
export interface AttemptHistoryRow {
  id: string;
  attemptIndex: number;
  lifecycleState: string;
  source: string;
  assignedToId: string | null;
  reactivatedAt: string | null;
  reactivationRule: string | null;
  previousLeadId: string | null;
  primaryConversationId: string | null;
  createdAt: string;
  updatedAt: string;
  stage: { code: string; name: string } | null;
  lostReason: { code: string; labelEn: string; labelAr: string } | null;
  assignedTo: { id: string; name: string } | null;
}

/**
 * Response of GET /leads/:id/attempts. `outOfScopeCount` is the
 * count of attempts the operator's role can't see; the UI surfaces
 * it as a single "N previous attempts are outside your access."
 * line at the bottom of the timeline.
 */
export interface AttemptHistoryResult {
  attempts: AttemptHistoryRow[];
  totalAttempts: number;
  outOfScopeCount: number;
  currentLeadId: string;
}

/**
 * Phase D3 — D3.3: stage-specific status surface.
 *
 * `AllowedStatusEntry` is the per-stage catalogue entry — `code` is
 * the stable machine value, `label` / `labelAr` are the display copy
 * the picker + activity timeline render. Empty `allowedStatuses` on
 * the response means the stage has no catalogue configured; the UI
 * renders the "no statuses configured" hint.
 *
 * `StageStatusHistoryRow` mirrors what the service returns for both
 * `currentStatus` (a single row, possibly null) and `history` (every
 * status row recorded for the lead, newest first).
 */
export interface AllowedStatusEntry {
  code: string;
  label: string;
  labelAr: string;
}

export interface StageStatusHistoryRow {
  id: string;
  stageId: string;
  status: string;
  attemptIndex: number;
  notes: string | null;
  createdAt: string;
  setBy: { id: string; name: string } | null;
  /** The stage the status was recorded against — included on history
   *  rows because they may span multiple stages over a lead's life. */
  stage?: { id: string; code: string; name: string };
}

export interface StageStatusesResponse {
  leadId: string;
  stage: { id: string; code: string; name: string };
  currentStatus: StageStatusHistoryRow | null;
  allowedStatuses: AllowedStatusEntry[];
  history: StageStatusHistoryRow[];
}

export interface SetStageStatusResponse {
  leadId: string;
  previousStatus: string | null;
  currentStatus: StageStatusHistoryRow;
}

/**
 * Phase D3 — D3.4: lead rotation surfaces.
 *
 * `RotationOutcome` is the response from `POST /leads/:id/rotate`.
 * `RotationHistoryRow` mirrors `GET /leads/:id/rotations`, with
 * `fromUser` / `toUser` / `actor` / `notes` redacted to NULL by the
 * server when the caller lacks `lead.write` (D2.6 visibility gate).
 * The `canSeeOwners` boolean is the explicit signal so the UI
 * doesn't have to second-guess null vs hidden.
 */
export type HandoverMode = 'full' | 'summary' | 'clean';
export type RotationTrigger =
  | 'manual_tl'
  | 'manual_ops'
  | 'sla_breach'
  | 'agent_unavailable'
  | 'capacity_balance';

export interface RotationOutcome {
  rotationId: string;
  leadId: string;
  fromUserId: string | null;
  toUserId: string | null;
  trigger: RotationTrigger;
  handoverMode: HandoverMode;
  attemptIndex: number;
  cancelledFollowUpCount: number;
}

export interface RotationHistoryRow {
  id: string;
  trigger: string;
  handoverMode: string;
  reasonCode: string | null;
  attemptIndex: number;
  notes: string | null;
  createdAt: string;
  fromUser: { id: string; name: string } | null;
  toUser: { id: string; name: string } | null;
  actor: { id: string; name: string } | null;
}

export interface RotationHistoryResponse {
  leadId: string;
  /** When false, the server stripped fromUser / toUser / actor /
   *  notes from every row. UI renders neutral copy. */
  canSeeOwners: boolean;
  rotations: RotationHistoryRow[];
}

/**
 * Phase D3 — D3.6: TL Review Queue.
 *
 * Reasons, resolutions, and the row + paginated-response shapes the
 * `/lead-reviews` endpoints return. Reason / resolution sets stay
 * separate from `WhatsAppReviewReason` / `WhatsAppReviewResolution`
 * — the two queues mirror each other's UX but never share data
 * shape, so collapsing them would force an awkward middle layer.
 */
export type LeadReviewReason =
  | 'sla_breach_repeat'
  | 'rotation_failed'
  | 'manual_tl_review'
  | 'bottleneck_flagged'
  | 'escalated_by_tl'
  // Phase D4 — D4.6: partner-reconciliation discrepancies promoted
  // into the TL Review Queue. The `reasonPayload` carries
  // `{ partnerSourceId, partnerRecordId?, category, notes? }`.
  | 'partner_missing'
  | 'partner_active_not_in_crm'
  | 'partner_date_mismatch'
  | 'partner_dft_mismatch'
  | 'partner_trips_mismatch';

export type LeadReviewResolution = 'rotated' | 'kept_owner' | 'escalated' | 'dismissed';

export interface LeadReviewRow {
  id: string;
  leadId: string;
  reason: LeadReviewReason;
  reasonPayload: Record<string, unknown> | null;
  assignedTlId: string | null;
  resolution: LeadReviewResolution | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  createdAt: string;
  assignedTl: { id: string; name: string } | null;
  resolvedBy: { id: string; name: string } | null;
  lead: {
    id: string;
    name: string;
    phone: string;
    slaThreshold: string;
    stage: { code: string; name: string };
    assignedTo: { id: string; name: string } | null;
  };
}

export interface LeadReviewsListResponse {
  items: LeadReviewRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Phase D3 — D3.7: agent-workspace "Needs attention now" payload.
 *
 * Three sanitised lists for the calling agent. NEVER carries
 * previous-owner / actor names — the workspace surface intentionally
 * redacts blame fields. The audit page (`/admin/audit`) is the place
 * for full attribution; the workspace is operational, not forensic.
 */
export interface NeedsAttentionResponse {
  rotatedToMe: Array<{
    rotationId: string;
    leadId: string;
    leadName: string;
    phone: string;
    stage: { code: string; name: string };
    rotatedAt: string;
  }>;
  atRiskSla: Array<{
    leadId: string;
    leadName: string;
    phone: string;
    stage: { code: string; name: string };
    threshold: 't150' | 't200';
    thresholdAt: string | null;
  }>;
  openReviews: Array<{
    reviewId: string;
    leadId: string;
    leadName: string;
    phone: string;
    stage: { code: string; name: string };
    reason: LeadReviewReason | string;
    createdAt: string;
  }>;
}

/**
 * Phase D3 — D3.7: SLA escalation policy (per-tenant).
 *
 * Mirrors the backend Zod shape (`EscalationRulesSchema`). The
 * editor at `/admin/tenant-settings` saves the full object; the
 * service computes the diff for the audit row.
 */
export type EscalationAction =
  | 'notify_only'
  | 'notify_and_tag'
  | 'rotate'
  | 'rotate_or_review'
  | 'raise_review';

export type EscalationHandoverMode = 'full' | 'summary' | 'clean';

export interface EscalationThresholdPolicy {
  action: EscalationAction;
  rotateOnFirst: boolean;
  reviewOnRepeatWithinHours: number;
}

export interface EscalationRulesConfig {
  thresholds: {
    t75: EscalationThresholdPolicy;
    t100: EscalationThresholdPolicy;
    t150: EscalationThresholdPolicy;
    t200: EscalationThresholdPolicy;
  };
  defaultHandoverMode: EscalationHandoverMode;
}

/**
 * Phase D4 — D4.2: Partner Data Hub admin shapes.
 *
 * The API NEVER returns raw credentials — only the safe metadata
 * fields below. The plaintext credentials live exclusively in the
 * Create / Update bodies and are encrypted server-side.
 */
export type PartnerAdapter = 'google_sheets' | 'manual_upload';
export type PartnerScheduleKind = 'manual' | 'cron';
export type PartnerTabMode = 'fixed' | 'new_per_period';

export type PartnerTabDiscoveryRule =
  | { kind: 'name_pattern'; pattern: string }
  | { kind: 'most_recently_modified' };

export interface PartnerSourceRow {
  id: string;
  partnerCode: string;
  displayName: string;
  adapter: string;
  companyId: string | null;
  countryId: string | null;
  scheduleKind: string;
  cronSpec: string | null;
  tabMode: string;
  fixedTabName: string | null;
  tabDiscoveryRule: PartnerTabDiscoveryRule | null;
  hasCredentials: boolean;
  lastTestedAt: string | null;
  connectionStatus: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  credentialUpdatedAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PartnerSourcesListResponse {
  items: PartnerSourceRow[];
  total: number;
}

export interface GoogleSheetsCredentialsInput {
  serviceAccountEmail: string;
  privateKey: string;
  sheetId: string;
}

export type PartnerCredentialsInput = GoogleSheetsCredentialsInput | Record<string, unknown>;

export interface CreatePartnerSourceInput {
  partnerCode: string;
  displayName: string;
  adapter: PartnerAdapter;
  companyId?: string | null;
  countryId?: string | null;
  scheduleKind?: PartnerScheduleKind;
  cronSpec?: string | null;
  tabMode?: PartnerTabMode;
  fixedTabName?: string | null;
  tabDiscoveryRule?: PartnerTabDiscoveryRule | null;
  isActive?: boolean;
  credentials?: PartnerCredentialsInput | null;
}

export type UpdatePartnerSourceInput = Partial<CreatePartnerSourceInput>;

export interface PartnerTestConnectionResult {
  status: 'stubbed';
  message: string;
  configIssues: string[];
}

export type PartnerTargetField =
  | 'phone'
  | 'name'
  | 'partner_status'
  | 'partner_active_date'
  | 'partner_dft_date'
  | 'trip_count'
  | 'last_trip_at';

export type PartnerTransformKind = 'passthrough' | 'parse_date' | 'to_e164' | 'lowercase';

export interface PartnerMappingRow {
  id: string;
  partnerSourceId: string;
  sourceColumn: string;
  targetField: string;
  transformKind: string | null;
  transformArgs: Record<string, unknown> | null;
  isRequired: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePartnerMappingInput {
  sourceColumn: string;
  targetField: PartnerTargetField;
  transformKind?: PartnerTransformKind;
  transformArgs?: Record<string, unknown>;
  isRequired?: boolean;
  displayOrder?: number;
}

export interface UpdatePartnerMappingInput {
  sourceColumn?: string;
  targetField?: PartnerTargetField;
  transformKind?: PartnerTransformKind | null;
  transformArgs?: Record<string, unknown> | null;
  isRequired?: boolean;
  displayOrder?: number;
}

export interface PartnerMappingReadiness {
  phoneMapped: boolean;
  missingTargets: string[];
}

/**
 * Phase D4 — D4.3: snapshot + sync result shapes.
 */
export interface PartnerSnapshotRow {
  id: string;
  partnerSourceId: string;
  partnerSource: { id: string; displayName: string; partnerCode: string } | null;
  startedAt: string;
  completedAt: string | null;
  status: string;
  rowsTotal: number;
  rowsImported: number;
  rowsSkipped: number;
  rowsError: number;
  sourceMetadata: Record<string, unknown> | null;
  triggeredBy: { id: string; name: string } | null;
  createdAt: string;
}

export interface PartnerSnapshotsListResponse {
  items: PartnerSnapshotRow[];
  total: number;
}

export interface PartnerSnapshotRecordRow {
  id: string;
  phone: string | null;
  partnerStatus: string | null;
  partnerActiveDate: string | null;
  partnerDftDate: string | null;
  tripCount: number | null;
  lastTripAt: string | null;
  contactResolved: boolean;
  createdAt: string;
}

export interface PartnerSnapshotRecordsResponse {
  items: PartnerSnapshotRecordRow[];
  total: number;
}

export interface PartnerSyncRunResult {
  wasSkipped: boolean;
  reason?: string;
  snapshotId?: string;
  status?: 'success' | 'partial' | 'failed';
  total?: number;
  imported?: number;
  skipped?: number;
  errors?: number;
  resolvedTabName?: string | null;
}

/**
 * Real adapter probe result (D4.3). Status values include
 * `'not_wired'` for the Google Sheets seam.
 */
export interface PartnerConnectionTestResult {
  status: string;
  message: string;
  tabs?: Array<{ name: string; modifiedAt: string | null }>;
}

/**
 * Phase D4 — D4.4: per-source verification projection.
 */
export type PartnerVerificationStatus =
  | 'not_found'
  | 'matched'
  | 'crm_active_partner_missing'
  | 'partner_active_crm_not_active'
  | 'date_mismatch'
  | 'dft_mismatch'
  | 'trips_mismatch';

export interface PartnerVerificationProjection {
  partnerSourceId: string;
  partnerSourceName: string;
  partnerCode: string;
  lastSyncAt: string | null;
  snapshotId: string | null;
  recordId: string | null;
  partnerStatus: string | null;
  partnerActiveDate: string | null;
  partnerDftDate: string | null;
  tripCount: number | null;
  lastTripAt: string | null;
  verificationStatus: PartnerVerificationStatus;
  warnings: string[];
}

export interface PartnerVerificationResult {
  leadId: string;
  phone: string | null;
  hasCaptain: boolean;
  projections: PartnerVerificationProjection[];
}

/**
 * Phase D4 — D4.5: controlled-merge shapes.
 */
export type PartnerMergeableField = 'active_date' | 'dft_date';

export interface PartnerMergeRequest {
  partnerSourceId: string;
  fields: PartnerMergeableField[];
  evidenceNote?: string;
}

export interface PartnerMergeResult {
  leadId: string;
  captainId: string;
  partnerSourceId: string;
  partnerSnapshotId: string;
  partnerRecordId: string;
  evidenceId: string;
  activityId: string;
  changedFields: PartnerMergeableField[];
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

export interface LeadEvidenceRow {
  id: string;
  leadId: string;
  kind: string;
  partnerRecordId: string | null;
  partnerSnapshotId: string | null;
  storageRef: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  notes: string | null;
  capturedBy: { id: string; name: string } | null;
  createdAt: string;
}

/**
 * Phase D4 — D4.8: evidence-only attach. Pins a partner snapshot
 * record to a lead WITHOUT mutating Captain or any CRM column.
 * Capability: `partner.evidence.write`.
 */
export interface PartnerAttachEvidenceRequest {
  partnerSourceId: string;
  partnerRecordId?: string;
  partnerSnapshotId?: string;
  notes?: string;
}

export interface PartnerAttachEvidenceResult {
  evidenceId: string;
  partnerRecordId: string;
  partnerSnapshotId: string;
}

/**
 * Phase D4 — D4.6: partner reconciliation shapes.
 */
export type ReconciliationCategory =
  | 'partner_missing'
  | 'partner_active_not_in_crm'
  | 'partner_date_mismatch'
  | 'partner_dft_mismatch'
  | 'partner_trips_mismatch'
  | 'commission_risk';

export type ReconciliationSeverity = 'info' | 'warning';

export interface ReconciliationItem {
  category: ReconciliationCategory;
  partnerSourceId: string;
  partnerSourceName: string;
  leadId: string | null;
  captainId: string | null;
  contactId: string | null;
  phone: string;
  crmName: string | null;
  crmStage: string | null;
  crmLifecycleState: string | null;
  crmActiveDate: string | null;
  crmDftDate: string | null;
  crmTripCount: number | null;
  partnerStatus: string | null;
  partnerActiveDate: string | null;
  partnerDftDate: string | null;
  partnerTripCount: number | null;
  lastSyncAt: string | null;
  severity: ReconciliationSeverity;
  recommendedAction: string;
}

export interface ReconciliationResult {
  items: ReconciliationItem[];
  counts: Record<ReconciliationCategory, number>;
  generatedAt: string;
}

export interface ReconciliationOpenReviewInput {
  category: ReconciliationCategory;
  leadId: string;
  partnerSourceId: string;
  partnerRecordId?: string;
  notes?: string;
}

export interface ReconciliationOpenReviewResult {
  reviewId: string;
  alreadyOpen: boolean;
}

/**
 * Phase D4 — D4.7: milestone shapes.
 */
export type MilestoneAnchor = 'partner_active_date' | 'partner_dft_date' | 'first_seen_in_partner';

export type MilestoneRisk = 'low' | 'medium' | 'high' | 'expired' | 'completed' | 'unknown';

export interface MilestoneConfigRow {
  id: string;
  partnerSourceId: string;
  partnerSource: { id: string; displayName: string; partnerCode: string } | null;
  code: string;
  displayName: string;
  windowDays: number;
  milestoneSteps: number[];
  anchor: string;
  riskThresholds: { high: number; medium: number } | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MilestoneConfigsListResponse {
  items: MilestoneConfigRow[];
  total: number;
}

export interface CreateMilestoneConfigInput {
  partnerSourceId: string;
  code: string;
  displayName: string;
  windowDays: number;
  milestoneSteps: number[];
  anchor: MilestoneAnchor;
  riskThresholds?: { high: number; medium: number };
  isActive?: boolean;
}

export type UpdateMilestoneConfigInput = Partial<
  Omit<CreateMilestoneConfigInput, 'partnerSourceId'>
>;

export interface MilestoneProgressProjection {
  partnerSourceId: string;
  partnerSourceName: string;
  configId: string;
  configCode: string;
  displayName: string;
  anchor: string;
  anchorAt: string | null;
  windowDays: number;
  windowEndsAt: string | null;
  daysLeft: number | null;
  tripCount: number | null;
  targetTrips: number;
  milestoneSteps: number[];
  currentMilestone: number | null;
  nextMilestone: number | null;
  progressPct: number;
  risk: MilestoneRisk;
  needsPush: boolean;
  reason: string | null;
}

export interface LeadMilestoneProgressResult {
  leadId: string;
  phone: string | null;
  projections: MilestoneProgressProjection[];
}
