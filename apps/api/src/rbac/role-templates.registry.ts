import type { CapabilityCode } from './capabilities.registry';
import type { RoleScopeResource, RoleScopeValue } from './rbac.dto';

/**
 * Phase D5 — D5.16: Role Templates registry.
 *
 * Curated, safe starting points for `POST /rbac/roles/from-template`.
 * The role builder's "Duplicate role" flow inherits every capability
 * the source role carries (including high-risk verbs like
 * `tenant.export`, `roles.write`, `partner.merge.write`); admins
 * have to remember to strip them. Templates flip the default:
 *
 *   • Each template carries an explicit, MINIMAL capability set
 *     for the persona it represents.
 *   • Default scope rows ship the safest reasonable scope per
 *     resource (agents → 'own', TLs → 'team', viewers → 'global'
 *     read-only).
 *   • Default field-permission denies cover the D5.7 / D5.12-A
 *     deny rows (previous-owner identity, rotation actor / notes,
 *     WhatsApp prior-agent messages / handover chain / summary /
 *     internal metadata) so a freshly-created role from a
 *     template never accidentally exposes sensitive operational
 *     history.
 *   • `riskTags` enumerate the D5.15-A risk categories the
 *     template touches so the preview UI can show the right
 *     yellow/red banners BEFORE the admin clicks Create.
 *
 * Design notes:
 *
 *   1. **Registry, not table.** Templates live in code (mirrors
 *      `ROLE_DEFINITIONS` in `roles.registry.ts`). No migration,
 *      no per-tenant seed table — a template change is a
 *      deploy. Tenant-specific templates would be a future
 *      addition (D5.17 candidate); D5.16 ships system templates
 *      only, which is the highest-leverage safety win.
 *
 *   2. **Minimum-viable starting point.** Every template's caps
 *      list is the SMALLEST set that makes the persona
 *      operational. Admins use the role editor's capability tab
 *      (with the D5.14 dependency-check + D5.15-A change-preview
 *      chain) to grow the set if their tenant needs it.
 *
 *   3. **Field-permission denies** are the same SAFE-default
 *      set the agent cohort already gets seeded with via
 *      migration 0040 (D5.7) + the D5.12-A WhatsApp denies.
 *      Templates targeting non-agent personas (TLs / Ops /
 *      Finance / Partner / Viewer) still carry the WhatsApp
 *      handover-summary deny when the persona doesn't legitimately
 *      need to read prior-agent text.
 *
 *   4. **No system role overrides.** Templates do NOT take the
 *      11 system-role codes; the admin always picks a fresh
 *      `code` for the new role. The template provides the
 *      capability/scope/field-perm bundle, not the identity.
 */

// ─── Common bundles (mirror roles.registry.ts shapes) ────────────

const READ_ORG: readonly CapabilityCode[] = [
  'org.company.read',
  'org.country.read',
  'org.team.read',
];

const READ_CRM: readonly CapabilityCode[] = [
  'lead.read',
  'pipeline.read',
  'captain.read',
  'followup.read',
  'whatsapp.account.read',
  'whatsapp.conversation.read',
  'whatsapp.template.read',
  'whatsapp.contact.read',
  'bonus.read',
  'competition.read',
  'report.read',
  'meta.leadsource.read',
  'tenant.settings.read',
];

const AGENT_ACTIONS: readonly CapabilityCode[] = [
  'lead.activity.write',
  'lead.stage.move',
  'lead.assign',
  'lead.stage.status.write',
  'followup.write',
  'followup.complete',
  'whatsapp.message.send',
  'whatsapp.media.send',
  'whatsapp.link.lead',
  'whatsapp.conversation.close',
  'whatsapp.contact.write',
  'captain.document.write',
];

// TL bundle WITHOUT partner.merge.write — that verb is high-risk
// and should be opted into via the role editor, not handed out by
// every TL template by default.
const TEAM_LEAD_SAFE_EXTRAS: readonly CapabilityCode[] = [
  'lead.write',
  'lead.convert',
  'lead.import',
  'lead.rotate',
  'lead.review.read',
  'lead.review.resolve',
  'whatsapp.handover',
  'whatsapp.conversation.assign',
  'whatsapp.conversation.reopen',
  'whatsapp.review.read',
  'partner.source.read',
  'partner.sync.run',
  'partner.verification.read',
  'partner.evidence.write',
  'partner.reconciliation.read',
];

// Field-permission denies that mirror migration 0040 (D5.7) +
// D5.12-A defaults. Used by every "agent / TL / activation"
// template by default; finance/partner/viewer templates keep them
// because none of those personas legitimately need prior-agent
// text either.
const SAFE_AGENT_FIELD_DENIES: ReadonlyArray<{
  resource: string;
  field: string;
  canRead: boolean;
  canWrite: boolean;
}> = [
  // D5.7 — rotation owner-history surface. Catalogue mirror:
  // `rotation.fromUser` / `toUser` / `actor` / `notes` /
  // `internalPayload`. The legacy `rotation.handoverSummary`
  // deny lives only in migration 0040 (orphaned — no catalogue
  // entry); the meaningful handover-summary deny rides on
  // `whatsapp.conversation.handoverSummary` below.
  { resource: 'rotation', field: 'fromUser', canRead: false, canWrite: false },
  { resource: 'rotation', field: 'toUser', canRead: false, canWrite: false },
  { resource: 'rotation', field: 'actor', canRead: false, canWrite: false },
  { resource: 'rotation', field: 'notes', canRead: false, canWrite: false },
  { resource: 'rotation', field: 'internalPayload', canRead: false, canWrite: false },
  // D5.7 — lead previous-owner / owner-history surface.
  { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: false },
  { resource: 'lead', field: 'ownerHistory', canRead: false, canWrite: false },
  // D5.12-A — WhatsApp prior-agent messages + handover chain +
  // handover summary + internal metadata.
  {
    resource: 'whatsapp.conversation',
    field: 'priorAgentMessages',
    canRead: false,
    canWrite: false,
  },
  {
    resource: 'whatsapp.conversation',
    field: 'handoverChain',
    canRead: false,
    canWrite: false,
  },
  {
    resource: 'whatsapp.conversation',
    field: 'handoverSummary',
    canRead: false,
    canWrite: false,
  },
  {
    resource: 'whatsapp.conversation',
    field: 'internalMetadata',
    canRead: false,
    canWrite: false,
  },
];

// Lighter deny set — TLs see prior-agent text on their team's
// conversations (`priorAgentMessages` allowed) but still don't
// need rotation actor identity / handover summary / internal
// metadata.
const TEAM_LEAD_FIELD_DENIES: ReadonlyArray<{
  resource: string;
  field: string;
  canRead: boolean;
  canWrite: boolean;
}> = [
  { resource: 'rotation', field: 'actor', canRead: false, canWrite: false },
  { resource: 'rotation', field: 'notes', canRead: false, canWrite: false },
  { resource: 'rotation', field: 'internalPayload', canRead: false, canWrite: false },
  {
    resource: 'whatsapp.conversation',
    field: 'handoverSummary',
    canRead: false,
    canWrite: false,
  },
  {
    resource: 'whatsapp.conversation',
    field: 'internalMetadata',
    canRead: false,
    canWrite: false,
  },
];

// ─── Template shape ─────────────────────────────────────────────

export type RoleTemplateCategory =
  | 'agent'
  | 'team_lead'
  | 'admin'
  | 'finance'
  | 'partner'
  | 'qa'
  | 'viewer';

/**
 * Risk tags enumerate the D5.15-A risk categories the template
 * touches. Drives the preview UI's coloured banners + the safe-by-
 * default badge ("This template ships only read access" when the
 * tag list is empty).
 */
export type RoleTemplateRiskTag =
  | 'export_capability'
  | 'tenant_export'
  | 'partner_merge'
  | 'permission_admin'
  | 'permission_preview'
  | 'audit_read'
  | 'high_privilege';

export interface RoleTemplateScope {
  readonly resource: RoleScopeResource;
  readonly scope: RoleScopeValue;
}

export interface RoleTemplateFieldPermission {
  readonly resource: string;
  readonly field: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
}

export interface RoleTemplateDef {
  /** Stable snake_case identifier; references the seed registry. */
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn: string;
  readonly descriptionAr: string;
  readonly category: RoleTemplateCategory;
  /** Default level for the new role. The admin can adjust on save. */
  readonly suggestedLevel: number;
  readonly capabilities: readonly CapabilityCode[];
  readonly scopes: readonly RoleTemplateScope[];
  readonly fieldPermissions: readonly RoleTemplateFieldPermission[];
  readonly riskTags: readonly RoleTemplateRiskTag[];
}

// ─── Curated templates ──────────────────────────────────────────

export const ROLE_TEMPLATE_DEFINITIONS: readonly RoleTemplateDef[] = [
  // ─── Viewer (zero risk) ─────────────────────────────────────
  {
    code: 'viewer_readonly',
    nameEn: 'Viewer — Read only',
    nameAr: 'مشاهد للقراءة فقط',
    descriptionEn:
      'Read-only access across the CRM. No exports, no writes, no admin surface. Safe for auditors / observers.',
    descriptionAr:
      'وصول للقراءة فقط على نطاق الـ CRM. بدون تصدير ولا كتابة ولا واجهات إدارية. آمن للمدققين والمراقبين.',
    category: 'viewer',
    suggestedLevel: 20,
    capabilities: [...READ_ORG, ...READ_CRM, 'roles.read', 'capabilities.read'],
    scopes: [
      { resource: 'lead', scope: 'global' },
      { resource: 'captain', scope: 'global' },
      { resource: 'followup', scope: 'global' },
      { resource: 'whatsapp.conversation', scope: 'global' },
    ],
    fieldPermissions: SAFE_AGENT_FIELD_DENIES,
    riskTags: [],
  },

  // ─── Agents (low risk — own scope) ──────────────────────────
  {
    code: 'agent_sales_safe',
    nameEn: 'Sales Agent — Safe',
    nameAr: 'وكيل مبيعات — آمن',
    descriptionEn:
      'Operational agent on the sales pipeline. Sees only their own leads, follow-ups, and WhatsApp conversations. Cannot read previous-owner identity, rotation actors, or prior-agent WhatsApp text.',
    descriptionAr:
      'وكيل تشغيلي على مسار المبيعات. يرى فقط عملاءه ومتابعاته ومحادثاته. لا يستطيع رؤية هوية المالك السابق ولا منفّذي الدوران ولا الرسائل السابقة في واتساب.',
    category: 'agent',
    suggestedLevel: 30,
    capabilities: [...READ_ORG, ...READ_CRM, ...AGENT_ACTIONS],
    scopes: [
      { resource: 'lead', scope: 'own' },
      { resource: 'captain', scope: 'global' },
      { resource: 'followup', scope: 'own' },
      { resource: 'whatsapp.conversation', scope: 'own' },
    ],
    fieldPermissions: SAFE_AGENT_FIELD_DENIES,
    riskTags: [],
  },
  {
    code: 'agent_activation_safe',
    nameEn: 'Activation Agent — Safe',
    nameAr: 'وكيل تنشيط — آمن',
    descriptionEn:
      'Operational agent on the activation pipeline. Same safe defaults as Sales Agent — own-scope leads, no prior-owner / handover visibility.',
    descriptionAr:
      'وكيل تشغيلي على مسار التنشيط. نفس الإعدادات الافتراضية الآمنة لوكيل المبيعات — عملاء بنطاق ”خاص“ بدون رؤية المالك السابق أو سجل التحويلات.',
    category: 'agent',
    suggestedLevel: 30,
    capabilities: [...READ_ORG, ...READ_CRM, ...AGENT_ACTIONS],
    scopes: [
      { resource: 'lead', scope: 'own' },
      { resource: 'captain', scope: 'global' },
      { resource: 'followup', scope: 'own' },
      { resource: 'whatsapp.conversation', scope: 'own' },
    ],
    fieldPermissions: SAFE_AGENT_FIELD_DENIES,
    riskTags: [],
  },
  {
    code: 'agent_driving_safe',
    nameEn: 'Driving Agent — Safe',
    nameAr: 'وكيل قيادة — آمن',
    descriptionEn:
      'Operational agent on the driving pipeline. Same safe defaults as Sales / Activation Agent.',
    descriptionAr:
      'وكيل تشغيلي على مسار القيادة. نفس الإعدادات الافتراضية الآمنة لوكلاء المبيعات والتنشيط.',
    category: 'agent',
    suggestedLevel: 30,
    capabilities: [...READ_ORG, ...READ_CRM, ...AGENT_ACTIONS],
    scopes: [
      { resource: 'lead', scope: 'own' },
      { resource: 'captain', scope: 'global' },
      { resource: 'followup', scope: 'own' },
      { resource: 'whatsapp.conversation', scope: 'own' },
    ],
    fieldPermissions: SAFE_AGENT_FIELD_DENIES,
    riskTags: [],
  },

  // ─── Team Leaders (medium risk — team scope) ────────────────
  {
    code: 'tl_sales_safe',
    nameEn: 'Team Leader — Sales',
    nameAr: 'قائد فريق المبيعات',
    descriptionEn:
      'Sales team leader. Reads + reassigns leads inside their team, runs the Review Queue, and reads partner data. Does NOT receive partner.merge.write by default — opt in via the capability tab if your tenant needs it.',
    descriptionAr:
      'قائد فريق مبيعات. يقرأ ويعيد توزيع العملاء داخل فريقه، ويعمل على قائمة المراجعة، ويقرأ بيانات الشركاء. لا يحصل افتراضيًا على صلاحية دمج الشريك — يمكن تفعيلها لاحقًا من تبويب الصلاحيات.',
    category: 'team_lead',
    suggestedLevel: 60,
    capabilities: [
      ...READ_ORG,
      'users.read',
      'users.write',
      'users.reset',
      ...READ_CRM,
      ...AGENT_ACTIONS,
      ...TEAM_LEAD_SAFE_EXTRAS,
    ],
    scopes: [
      { resource: 'lead', scope: 'team' },
      { resource: 'captain', scope: 'global' },
      { resource: 'followup', scope: 'team' },
      { resource: 'whatsapp.conversation', scope: 'team' },
    ],
    fieldPermissions: TEAM_LEAD_FIELD_DENIES,
    riskTags: [],
  },
  {
    code: 'tl_activation_safe',
    nameEn: 'Team Leader — Activation',
    nameAr: 'قائد فريق التنشيط',
    descriptionEn:
      'Activation team leader. Same operational shape as TL — Sales, scoped to the activation cohort.',
    descriptionAr: 'قائد فريق التنشيط. نفس بنية قائد فريق المبيعات لكن لمسار التنشيط.',
    category: 'team_lead',
    suggestedLevel: 60,
    capabilities: [
      ...READ_ORG,
      'users.read',
      'users.write',
      'users.reset',
      ...READ_CRM,
      ...AGENT_ACTIONS,
      ...TEAM_LEAD_SAFE_EXTRAS,
    ],
    scopes: [
      { resource: 'lead', scope: 'team' },
      { resource: 'captain', scope: 'global' },
      { resource: 'followup', scope: 'team' },
      { resource: 'whatsapp.conversation', scope: 'team' },
    ],
    fieldPermissions: TEAM_LEAD_FIELD_DENIES,
    riskTags: [],
  },

  // ─── QA Reviewer (read + document review) ───────────────────
  {
    code: 'qa_reviewer_safe',
    nameEn: 'QA / Reviewer',
    nameAr: 'مراجع جودة',
    descriptionEn:
      'Read-only across the CRM with audit log access and captain document review. Does NOT carry exports or admin surface.',
    descriptionAr:
      'وصول للقراءة فقط على نطاق الـ CRM مع رؤية سجل التدقيق ومراجعة وثائق الكباتن. لا يحمل صلاحيات تصدير أو واجهات إدارية.',
    category: 'qa',
    suggestedLevel: 50,
    capabilities: [...READ_ORG, ...READ_CRM, 'audit.read', 'captain.document.review', 'roles.read'],
    scopes: [
      { resource: 'lead', scope: 'global' },
      { resource: 'captain', scope: 'global' },
      { resource: 'followup', scope: 'global' },
      { resource: 'whatsapp.conversation', scope: 'global' },
    ],
    fieldPermissions: SAFE_AGENT_FIELD_DENIES,
    riskTags: ['audit_read'],
  },

  // ─── Partner Data Reviewer (no merge by default) ────────────
  {
    code: 'partner_reviewer_safe',
    nameEn: 'Partner Data Reviewer',
    nameAr: 'مراجع بيانات الشركاء',
    descriptionEn:
      'Reads partner sources, verification, and reconciliation. Can attach approval evidence. Does NOT carry partner.merge.write — that is a separate, audited admin verb.',
    descriptionAr:
      'يقرأ مصادر الشركاء والتحقق والمطابقة. يمكنه إرفاق دليل الاعتماد. لا يحمل صلاحية دمج بيانات الشريك — هذه صلاحية إدارية منفصلة ومُدقّقة.',
    category: 'partner',
    suggestedLevel: 55,
    capabilities: [
      ...READ_ORG,
      ...READ_CRM,
      'partner.source.read',
      'partner.verification.read',
      'partner.reconciliation.read',
      'partner.evidence.write',
    ],
    scopes: [
      { resource: 'lead', scope: 'global' },
      { resource: 'captain', scope: 'global' },
      { resource: 'followup', scope: 'global' },
      { resource: 'whatsapp.conversation', scope: 'global' },
    ],
    fieldPermissions: TEAM_LEAD_FIELD_DENIES,
    riskTags: [],
  },

  // ─── Finance / Commission Viewer (template only — finance is NOT a system role) ─
  {
    code: 'finance_commission_viewer',
    nameEn: 'Finance — Commission Viewer',
    nameAr: 'المالية — مشاهد العمولات',
    descriptionEn:
      'Reads partner reconciliation + commission surfaces, runs commission / reconciliation CSV exports, and reads the audit log. Lead surface is read-only and gated by previous-owner denies. Finance is intentionally a TEMPLATE — not an immutable system role — so each tenant can adjust per its policy.',
    descriptionAr:
      'يقرأ سطح المطابقة والعمولة لدى الشركاء، ويصدّر تقارير CSV الخاصة بالعمولة والمطابقة، ويقرأ سجل التدقيق. سطح العملاء للقراءة فقط مع منع رؤية المالك السابق. تم اعتماد دور المالية كـ”قالب“ وليس دورًا نظاميًا حتى يستطيع كل مستأجر تخصيصه.',
    category: 'finance',
    suggestedLevel: 55,
    capabilities: [
      ...READ_ORG,
      'lead.read',
      'pipeline.read',
      'captain.read',
      'followup.read',
      'report.read',
      'partner.source.read',
      'partner.verification.read',
      'partner.reconciliation.read',
      'partner.commission.export',
      'partner.reconciliation.export',
      'audit.read',
      'roles.read',
    ],
    scopes: [
      { resource: 'lead', scope: 'global' },
      { resource: 'captain', scope: 'global' },
      { resource: 'followup', scope: 'global' },
      { resource: 'whatsapp.conversation', scope: 'global' },
    ],
    fieldPermissions: SAFE_AGENT_FIELD_DENIES,
    riskTags: ['export_capability', 'audit_read'],
  },

  // ─── Account Manager — operational (NO admin surface) ───────
  {
    code: 'account_manager_operational',
    nameEn: 'Account Manager — Operational',
    nameAr: 'مدير حساب — تشغيلي',
    descriptionEn:
      'Operational account manager. Reads + writes across leads, captains, follow-ups, and WhatsApp. Does NOT carry roles.write, tenant.export, audit.export, or partner.merge.write — opt in via the capability tab if your tenant needs them.',
    descriptionAr:
      'مدير حساب تشغيلي. يقرأ ويكتب على نطاق العملاء والكباتن والمتابعات وواتساب. لا يحمل افتراضيًا صلاحية إدارة الأدوار أو تصدير المستأجر أو تصدير التدقيق أو دمج الشركاء — يمكن تفعيل أيٍّ منها لاحقًا.',
    category: 'admin',
    suggestedLevel: 80,
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
      'lead.import',
      'lead.reactivate',
      'lead.stage.status.write',
      'lead.rotate',
      'lead.review.read',
      'lead.review.resolve',
      'pipeline.write',
      'meta.leadsource.write',
      'followup.write',
      'followup.complete',
      'whatsapp.message.send',
      'whatsapp.handover',
      'whatsapp.link.lead',
      'whatsapp.template.write',
      'whatsapp.media.send',
      'whatsapp.conversation.assign',
      'whatsapp.conversation.close',
      'whatsapp.conversation.reopen',
      'whatsapp.review.read',
      'whatsapp.review.resolve',
      'whatsapp.contact.write',
      'bonus.write',
      'competition.write',
      'audit.read',
      'roles.read',
      'capabilities.read',
      'tenant.settings.read',
      'distribution.read',
      'distribution.write',
      'captain.document.write',
      'captain.document.review',
      'captain.trip.write',
      'partner.source.read',
      'partner.sync.run',
      'partner.verification.read',
      'partner.evidence.write',
      'partner.reconciliation.read',
    ],
    scopes: [
      { resource: 'lead', scope: 'global' },
      { resource: 'captain', scope: 'global' },
      { resource: 'followup', scope: 'global' },
      { resource: 'whatsapp.conversation', scope: 'global' },
    ],
    fieldPermissions: TEAM_LEAD_FIELD_DENIES,
    riskTags: ['audit_read'],
  },

  // ─── Ops Manager — Governance (HIGH-RISK — full admin) ──────
  {
    code: 'ops_governance',
    nameEn: 'Ops Manager — Governance',
    nameAr: 'مدير عمليات — حوكمة',
    descriptionEn:
      'Full operational + governance surface: roles management, tenant export, every CSV export, partner merge, audit log, permission preview, full WhatsApp admin. EXPLICITLY HIGH-RISK — only grant to a single tenant administrator.',
    descriptionAr:
      'سطح تشغيلي وحوكمي كامل: إدارة الأدوار، تصدير المستأجر، كل تقارير CSV، دمج الشركاء، سجل التدقيق، معاينة الصلاحيات، الإدارة الكاملة لواتساب. عالي الخطورة بشكل صريح — يُمنح لمدير واحد للمستأجر فقط.',
    category: 'admin',
    suggestedLevel: 90,
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
      'lead.import',
      'lead.reactivate',
      'lead.stage.status.write',
      'lead.rotate',
      'lead.review.read',
      'lead.review.resolve',
      'pipeline.write',
      'meta.leadsource.write',
      'followup.write',
      'followup.complete',
      'whatsapp.account.write',
      'whatsapp.message.send',
      'whatsapp.handover',
      'whatsapp.link.lead',
      'whatsapp.template.write',
      'whatsapp.media.send',
      'whatsapp.conversation.assign',
      'whatsapp.conversation.close',
      'whatsapp.conversation.reopen',
      'whatsapp.review.read',
      'whatsapp.review.resolve',
      'whatsapp.contact.write',
      'bonus.write',
      'competition.write',
      'audit.read',
      'roles.read',
      'roles.write',
      'capabilities.read',
      'tenant.settings.write',
      'tenant.duplicate_rules.write',
      'tenant.export',
      'distribution.read',
      'distribution.write',
      'captain.document.write',
      'captain.document.review',
      'captain.trip.write',
      'partner.source.read',
      'partner.source.write',
      'partner.sync.run',
      'partner.verification.read',
      'partner.merge.write',
      'partner.evidence.write',
      'partner.reconciliation.read',
      'partner.reconciliation.resolve',
      'partner.milestone.write',
      'lead.export',
      'report.export',
      'partner.reconciliation.export',
      'partner.commission.export',
      'audit.export',
      'permission.preview',
    ],
    scopes: [
      { resource: 'lead', scope: 'global' },
      { resource: 'captain', scope: 'global' },
      { resource: 'followup', scope: 'global' },
      { resource: 'whatsapp.conversation', scope: 'global' },
    ],
    fieldPermissions: [],
    riskTags: [
      'export_capability',
      'tenant_export',
      'partner_merge',
      'permission_admin',
      'permission_preview',
      'audit_read',
      'high_privilege',
    ],
  },
] as const satisfies readonly RoleTemplateDef[];

export type RoleTemplateCode = (typeof ROLE_TEMPLATE_DEFINITIONS)[number]['code'];

const BY_CODE: ReadonlyMap<string, RoleTemplateDef> = new Map(
  ROLE_TEMPLATE_DEFINITIONS.map((t) => [t.code, t]),
);

export function getRoleTemplate(code: string): RoleTemplateDef | null {
  return BY_CODE.get(code) ?? null;
}

export function listRoleTemplates(): readonly RoleTemplateDef[] {
  return ROLE_TEMPLATE_DEFINITIONS;
}
