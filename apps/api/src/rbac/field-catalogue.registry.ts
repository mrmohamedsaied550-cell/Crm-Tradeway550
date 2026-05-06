/**
 * Phase C — C4 (foundation) / Phase D5 — D5.2 (extension): field
 * catalogue.
 *
 * The static contract for which (resource, field) pairs are gateable
 * through the field-permission matrix. Two readers consume this:
 *
 *   1. FieldFilterService — when a runtime payload is stripped, the
 *      catalogue is informational only; the actual decision comes
 *      from the per-tenant `field_permissions` table written by the
 *      role builder.
 *
 *   2. Admin role-editor matrix UI — renders one row per entry per
 *      resource with metadata (group, sensitive flag, default state)
 *      so the operator knows what they're toggling.
 *
 * Field paths use dot-notation for nested JSON (e.g.
 * `attribution.campaign`) and match the field strings stored in
 * `field_permissions.field`. Top-level columns are written as-is
 * (e.g. `id`, `phone`).
 *
 * Default behaviour for fields NOT in the catalogue: read=TRUE /
 * write=TRUE — restrictions are explicit denials, not whitelists.
 *
 * D5.2 extends the catalogue from lead-only coverage (~23 entries)
 * to fourteen CRM resources (~110 entries). D5.2 itself does NOT
 * wire any service to the new entries — the catalogue is ahead of
 * the runtime so the role-editor UI can already surface the new
 * (resource, field) pairs while later D5.x chunks roll out the
 * redaction interceptor that consults them.
 *
 * Decisions locked in at D5.2:
 *
 *   • `lead.id` is NOT redactable. The UUID is part of the deep-link
 *     URL; hiding it adds no real protection. Marked `redactable: false`.
 *
 *   • Raw partner credentials are NEVER catalogued — the safe
 *     metadata (`hasCredentials`, `credentialUpdatedAt`,
 *     `connectionStatus`) is the gateable surface; the encrypted
 *     blob never leaves the server.
 *
 *   • `defaultRead` stays `true` for every entry to preserve the D4
 *     allow-by-default contract. Sensitive flags drive the UI
 *     warning + a future strict-mode tenant setting; they do NOT
 *     hide fields at runtime today.
 *
 *   • `defaultWrite` is `false` for read-only / system-managed fields
 *     (e.g. `auditEvents`, `partnerSnapshotId`, `dftAt`) so a
 *     role-builder accidentally enabling write on them won't
 *     succeed unless an explicit FieldPermission row is created
 *     AND a service-layer write path is wired (D5.x).
 *
 * Adding a field later: append to FIELD_CATALOGUE; no migration
 * needed because the field_permissions table is keyed by string,
 * not enum.
 */

/**
 * Closed list of resources the matrix UI knows about. Open-string
 * resource values are still accepted at the DTO layer
 * (PutRoleFieldPermissionsSchema uses `z.string()`), so a tenant
 * can persist deny rows for a resource not in this list — they
 * simply won't render in the role editor.
 */
export type CatalogueResource =
  | 'lead'
  | 'lead.activity'
  | 'lead.review'
  | 'rotation'
  | 'followup'
  | 'captain'
  | 'contact'
  | 'partner_source'
  | 'partner.verification'
  | 'partner.evidence'
  | 'partner.reconciliation'
  | 'partner.commission'
  | 'whatsapp.conversation'
  | 'report'
  | 'audit';

/**
 * Logical sub-grouping inside a resource. The role editor groups
 * the matrix table by `group` so 100+ rows scan as 6–8 sections.
 */
export type CatalogueGroup =
  | 'identity'
  | 'attribution'
  | 'lifecycle'
  | 'org'
  | 'assignment'
  | 'sla'
  | 'ownership_history'
  | 'commercial'
  | 'commission'
  | 'partner_data'
  | 'partner_milestone'
  | 'partner_evidence'
  | 'partner_config'
  | 'reconciliation'
  | 'timeline'
  | 'review'
  | 'rotation'
  | 'followup'
  | 'documents'
  | 'whatsapp_basic'
  | 'whatsapp_history'
  | 'whatsapp_review'
  | 'report_shape'
  | 'report_metrics'
  | 'audit_meta'
  | 'audit_payload'
  | 'system'
  | 'raw';

export interface FieldCatalogueEntry {
  readonly resource: CatalogueResource;
  /** Dot-path under the resource shape. */
  readonly field: string;
  /** Sub-group used by the role editor to chunk the matrix. */
  readonly group: CatalogueGroup;
  /**
   * Sensitive fields are highlighted in the role editor so the
   * operator can spot PII / financial / audit-grade fields at a
   * glance. They also become the candidate set for a future
   * tenant-wide "strict deny by default" mode.
   */
  readonly sensitive: boolean;
  /** Behaviour when no field_permission row exists. */
  readonly defaultRead: boolean;
  readonly defaultWrite: boolean;
  /** Short human-friendly label for the matrix UI (en). */
  readonly labelEn: string;
  /** Arabic label — RTL/AR locale picker. */
  readonly labelAr: string;
  /**
   * D5.2 — when `false`, the runtime redaction interceptor (D5.3)
   * MUST NOT strip this field even if a deny row is present. Used
   * for fields whose redaction would break referential integrity
   * (e.g. `lead.id` is part of the URL). Default: `true`.
   */
  readonly redactable?: boolean;
}

/**
 * Helper — declared once so the literal-array entries below stay
 * compact. Every catalogue entry runs through this so the inferred
 * type is exactly `FieldCatalogueEntry`.
 */
function entry(e: FieldCatalogueEntry): FieldCatalogueEntry {
  return e;
}

// ─── lead (existing 23 + D5.2 additions) ────────────────────────────

const LEAD_ENTRIES: readonly FieldCatalogueEntry[] = [
  // Identity
  entry({
    resource: 'lead',
    field: 'id',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Lead ID',
    labelAr: 'معرّف العميل',
    redactable: false,
  }),
  entry({
    resource: 'lead',
    field: 'name',
    group: 'identity',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Name',
    labelAr: 'الاسم',
  }),
  entry({
    resource: 'lead',
    field: 'phone',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Phone',
    labelAr: 'الهاتف',
  }),
  entry({
    resource: 'lead',
    field: 'email',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Email',
    labelAr: 'البريد الإلكتروني',
  }),
  entry({
    resource: 'lead',
    field: 'notes',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Notes',
    labelAr: 'ملاحظات',
  }),

  // Attribution
  entry({
    resource: 'lead',
    field: 'source',
    group: 'attribution',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Source (flat)',
    labelAr: 'المصدر',
  }),
  entry({
    resource: 'lead',
    field: 'campaignName',
    group: 'attribution',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Campaign name',
    labelAr: 'اسم الحملة',
  }),
  entry({
    resource: 'lead',
    field: 'attribution',
    group: 'attribution',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution (whole payload)',
    labelAr: 'الإسناد (الحمولة الكاملة)',
  }),
  entry({
    resource: 'lead',
    field: 'attribution.source',
    group: 'attribution',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · source',
    labelAr: 'الإسناد · المصدر',
  }),
  entry({
    resource: 'lead',
    field: 'attribution.subSource',
    group: 'attribution',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · sub-source',
    labelAr: 'الإسناد · المصدر الفرعي',
  }),
  entry({
    resource: 'lead',
    field: 'attribution.campaign',
    group: 'attribution',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · campaign',
    labelAr: 'الإسناد · الحملة',
  }),
  entry({
    resource: 'lead',
    field: 'attribution.adSet',
    group: 'attribution',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · ad set',
    labelAr: 'الإسناد · المجموعة الإعلانية',
  }),
  entry({
    resource: 'lead',
    field: 'attribution.ad',
    group: 'attribution',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · ad',
    labelAr: 'الإسناد · الإعلان',
  }),
  entry({
    resource: 'lead',
    field: 'attribution.utm',
    group: 'attribution',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Attribution · UTM',
    labelAr: 'الإسناد · UTM',
  }),

  // Lifecycle
  entry({
    resource: 'lead',
    field: 'lifecycleState',
    group: 'lifecycle',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Lifecycle',
    labelAr: 'دورة الحياة',
  }),
  entry({
    resource: 'lead',
    field: 'lostReasonId',
    group: 'lifecycle',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Lost reason',
    labelAr: 'سبب الفقد',
  }),
  entry({
    resource: 'lead',
    field: 'lostNote',
    group: 'lifecycle',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Lost note',
    labelAr: 'ملاحظة الفقد',
  }),

  // Org scope
  entry({
    resource: 'lead',
    field: 'companyId',
    group: 'org',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Company',
    labelAr: 'الشركة',
  }),
  entry({
    resource: 'lead',
    field: 'countryId',
    group: 'org',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Country',
    labelAr: 'الدولة',
  }),
  entry({
    resource: 'lead',
    field: 'pipelineId',
    group: 'org',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Pipeline',
    labelAr: 'خط الأنابيب',
  }),

  // Assignment
  entry({
    resource: 'lead',
    field: 'assignedToId',
    group: 'assignment',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Assignee',
    labelAr: 'المُسنَد إليه',
  }),
  entry({
    resource: 'lead',
    field: 'createdById',
    group: 'assignment',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Created by',
    labelAr: 'أنشأه',
  }),

  // SLA
  entry({
    resource: 'lead',
    field: 'slaStatus',
    group: 'sla',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'SLA status',
    labelAr: 'حالة الـ SLA',
  }),
  entry({
    resource: 'lead',
    field: 'slaDueAt',
    group: 'sla',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'SLA due',
    labelAr: 'موعد الـ SLA',
  }),
  entry({
    resource: 'lead',
    field: 'nextActionDueAt',
    group: 'sla',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Next action due',
    labelAr: 'موعد الإجراء التالي',
  }),

  // Ownership history (D2 / D3 adjacent — replaces the hardcoded
  // `userCanSeeOwnershipHistory` gate planned for D5.7).
  entry({
    resource: 'lead',
    field: 'previousOwner',
    group: 'ownership_history',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Previous owner',
    labelAr: 'المالك السابق',
  }),
  entry({
    resource: 'lead',
    field: 'ownerHistory',
    group: 'ownership_history',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Owner history',
    labelAr: 'سجل الملاك',
  }),

  // Partner-derived projections (read-only on the lead row)
  entry({
    resource: 'lead',
    field: 'partnerVerification',
    group: 'partner_data',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner verification (cached)',
    labelAr: 'التحقق من الشريك (مخزّن)',
  }),
  entry({
    resource: 'lead',
    field: 'partnerMergeActions',
    group: 'partner_data',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner merge actions',
    labelAr: 'إجراءات دمج الشريك',
  }),

  // Commercial / financial
  entry({
    resource: 'lead',
    field: 'commissionFields',
    group: 'commission',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Commission fields (lead-side)',
    labelAr: 'حقول العمولة (جانب العميل)',
  }),

  // Embedded / derived collections
  entry({
    resource: 'lead',
    field: 'timeline',
    group: 'timeline',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Timeline (activity)',
    labelAr: 'الجدول الزمني (النشاط)',
  }),
  entry({
    resource: 'lead',
    field: 'auditEvents',
    group: 'audit_meta',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Audit events on this lead',
    labelAr: 'أحداث التدقيق على هذا العميل',
  }),
];

// ─── lead.activity ─────────────────────────────────────────────────

const LEAD_ACTIVITY_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'lead.activity',
    field: 'type',
    group: 'timeline',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Activity type',
    labelAr: 'نوع النشاط',
  }),
  entry({
    resource: 'lead.activity',
    field: 'actor',
    group: 'timeline',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Actor (who did it)',
    labelAr: 'المنفّذ',
  }),
  entry({
    resource: 'lead.activity',
    field: 'notes',
    group: 'timeline',
    sensitive: true,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Activity notes',
    labelAr: 'ملاحظات النشاط',
  }),
  entry({
    resource: 'lead.activity',
    field: 'payload',
    group: 'timeline',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Activity payload (raw)',
    labelAr: 'حمولة النشاط (خام)',
  }),
  entry({
    resource: 'lead.activity',
    field: 'partnerMergeBeforeAfter',
    group: 'timeline',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner merge before/after diff',
    labelAr: 'فرق قبل/بعد دمج الشريك',
  }),
  entry({
    resource: 'lead.activity',
    field: 'rotationReason',
    group: 'timeline',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Rotation reason',
    labelAr: 'سبب الدوران',
  }),
  entry({
    resource: 'lead.activity',
    field: 'stageStatusNotes',
    group: 'timeline',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Stage-status notes',
    labelAr: 'ملاحظات حالة المرحلة',
  }),
  entry({
    resource: 'lead.activity',
    field: 'systemDetails',
    group: 'system',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'System / debug details',
    labelAr: 'تفاصيل النظام',
  }),
];

// ─── lead.review (TL Review Queue) ─────────────────────────────────

const LEAD_REVIEW_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'lead.review',
    field: 'reason',
    group: 'review',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Review reason',
    labelAr: 'سبب المراجعة',
  }),
  entry({
    resource: 'lead.review',
    field: 'reasonPayload',
    group: 'review',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Reason payload (structured)',
    labelAr: 'حمولة السبب (مهيكلة)',
  }),
  entry({
    resource: 'lead.review',
    field: 'resolution',
    group: 'review',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Resolution',
    labelAr: 'القرار',
  }),
  entry({
    resource: 'lead.review',
    field: 'resolutionNotes',
    group: 'review',
    sensitive: true,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Resolution notes',
    labelAr: 'ملاحظات القرار',
  }),
  entry({
    resource: 'lead.review',
    field: 'assignedTl',
    group: 'review',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Assigned TL',
    labelAr: 'قائد الفريق المُسنَد',
  }),
  entry({
    resource: 'lead.review',
    field: 'ownerContext',
    group: 'review',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Owner context',
    labelAr: 'سياق المالك',
  }),
  entry({
    resource: 'lead.review',
    field: 'partnerContext',
    group: 'review',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner context (D4.8)',
    labelAr: 'سياق الشريك (D4.8)',
  }),
];

// ─── rotation ──────────────────────────────────────────────────────

const ROTATION_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'rotation',
    field: 'fromUser',
    group: 'rotation',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'From user',
    labelAr: 'من المستخدم',
  }),
  entry({
    resource: 'rotation',
    field: 'toUser',
    group: 'rotation',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'To user',
    labelAr: 'إلى المستخدم',
  }),
  entry({
    resource: 'rotation',
    field: 'actor',
    group: 'rotation',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Rotation actor',
    labelAr: 'منفّذ الدوران',
  }),
  entry({
    resource: 'rotation',
    field: 'reason',
    group: 'rotation',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Reason code',
    labelAr: 'رمز السبب',
  }),
  entry({
    resource: 'rotation',
    field: 'notes',
    group: 'rotation',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Rotation notes',
    labelAr: 'ملاحظات الدوران',
  }),
  entry({
    resource: 'rotation',
    field: 'handoverMode',
    group: 'rotation',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Handover mode',
    labelAr: 'وضع التسليم',
  }),
  entry({
    resource: 'rotation',
    field: 'handoverSummary',
    group: 'rotation',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Handover summary',
    labelAr: 'ملخص التسليم',
  }),
  entry({
    resource: 'rotation',
    field: 'internalPayload',
    group: 'raw',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Internal payload (raw)',
    labelAr: 'الحمولة الداخلية (خام)',
  }),
];

// ─── followup ──────────────────────────────────────────────────────

const FOLLOWUP_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'followup',
    field: 'dueAt',
    group: 'followup',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Due at',
    labelAr: 'تاريخ الاستحقاق',
  }),
  entry({
    resource: 'followup',
    field: 'type',
    group: 'followup',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Type',
    labelAr: 'النوع',
  }),
  entry({
    resource: 'followup',
    field: 'note',
    group: 'followup',
    sensitive: true,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Note',
    labelAr: 'ملاحظة',
  }),
  entry({
    resource: 'followup',
    field: 'outcome',
    group: 'followup',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Outcome',
    labelAr: 'النتيجة',
  }),
  entry({
    resource: 'followup',
    field: 'owner',
    group: 'followup',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Owner',
    labelAr: 'المالك',
  }),
  entry({
    resource: 'followup',
    field: 'snoozeReason',
    group: 'followup',
    sensitive: true,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Snooze reason',
    labelAr: 'سبب التأجيل',
  }),
  entry({
    resource: 'followup',
    field: 'internalPayload',
    group: 'raw',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Internal payload (raw)',
    labelAr: 'الحمولة الداخلية (خام)',
  }),
];

// ─── captain ───────────────────────────────────────────────────────

const CAPTAIN_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'captain',
    field: 'id',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Captain ID',
    labelAr: 'معرّف الكابتن',
    redactable: false,
  }),
  entry({
    resource: 'captain',
    field: 'name',
    group: 'identity',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Name',
    labelAr: 'الاسم',
  }),
  entry({
    resource: 'captain',
    field: 'phone',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Phone',
    labelAr: 'الهاتف',
  }),
  entry({
    resource: 'captain',
    field: 'activatedAt',
    group: 'commercial',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Active date',
    labelAr: 'تاريخ التفعيل',
  }),
  entry({
    resource: 'captain',
    field: 'dftAt',
    group: 'commercial',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'DFT date',
    labelAr: 'تاريخ DFT',
  }),
  entry({
    resource: 'captain',
    field: 'tripCount',
    group: 'commercial',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'CRM trip count',
    labelAr: 'عدد رحلات النظام',
  }),
  entry({
    resource: 'captain',
    field: 'partnerMilestoneRisk',
    group: 'partner_milestone',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner milestone risk',
    labelAr: 'خطر علامات الشريك',
  }),
  entry({
    resource: 'captain',
    field: 'commissionAmount',
    group: 'commission',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Commission amount',
    labelAr: 'مبلغ العمولة',
  }),
  entry({
    resource: 'captain',
    field: 'commissionStatus',
    group: 'commission',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Commission status',
    labelAr: 'حالة العمولة',
  }),
  entry({
    resource: 'captain',
    field: 'documentStatus',
    group: 'documents',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Document status',
    labelAr: 'حالة المستندات',
  }),
  entry({
    resource: 'captain',
    field: 'owner',
    group: 'assignment',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Owner / team',
    labelAr: 'المالك / الفريق',
  }),
  entry({
    resource: 'captain',
    field: 'notes',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Notes',
    labelAr: 'ملاحظات',
  }),
  entry({
    resource: 'captain',
    field: 'auditEvents',
    group: 'audit_meta',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Audit events',
    labelAr: 'أحداث التدقيق',
  }),
];

// ─── contact ───────────────────────────────────────────────────────

const CONTACT_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'contact',
    field: 'id',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Contact ID',
    labelAr: 'معرّف جهة الاتصال',
    redactable: false,
  }),
  entry({
    resource: 'contact',
    field: 'name',
    group: 'identity',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Display name',
    labelAr: 'اسم العرض',
  }),
  entry({
    resource: 'contact',
    field: 'phone',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Phone (canonical)',
    labelAr: 'الهاتف (قياسي)',
  }),
  entry({
    resource: 'contact',
    field: 'alternatePhones',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Alternate phones',
    labelAr: 'أرقام بديلة',
  }),
  entry({
    resource: 'contact',
    field: 'whatsappProfileName',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'WhatsApp profile name',
    labelAr: 'اسم ملف واتساب',
  }),
  entry({
    resource: 'contact',
    field: 'source',
    group: 'attribution',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Source',
    labelAr: 'المصدر',
  }),
  entry({
    resource: 'contact',
    field: 'linkedLeads',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Linked leads',
    labelAr: 'العملاء المرتبطون',
  }),
  entry({
    resource: 'contact',
    field: 'linkedCaptains',
    group: 'identity',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Linked captains',
    labelAr: 'الكباتن المرتبطون',
  }),
  entry({
    resource: 'contact',
    field: 'rawMetadata',
    group: 'raw',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Raw provider metadata',
    labelAr: 'بيانات المزوّد الخام',
  }),
];

// ─── partner_source ────────────────────────────────────────────────

const PARTNER_SOURCE_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'partner_source',
    field: 'displayName',
    group: 'partner_config',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Display name',
    labelAr: 'الاسم المعروض',
  }),
  entry({
    resource: 'partner_source',
    field: 'partnerCode',
    group: 'partner_config',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner code',
    labelAr: 'رمز الشريك',
  }),
  entry({
    resource: 'partner_source',
    field: 'company',
    group: 'partner_config',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Company',
    labelAr: 'الشركة',
  }),
  entry({
    resource: 'partner_source',
    field: 'country',
    group: 'partner_config',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Country',
    labelAr: 'الدولة',
  }),
  entry({
    resource: 'partner_source',
    field: 'adapter',
    group: 'partner_config',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Adapter',
    labelAr: 'المحوّل',
  }),
  entry({
    resource: 'partner_source',
    field: 'schedule',
    group: 'partner_config',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Schedule (cron + kind)',
    labelAr: 'الجدولة',
  }),
  entry({
    resource: 'partner_source',
    field: 'tabConfig',
    group: 'partner_config',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Tab config',
    labelAr: 'إعدادات التبويب',
  }),
  // NOTE — raw `credentials` is intentionally NOT catalogued. Only
  // safe metadata about credentials is gateable.
  entry({
    resource: 'partner_source',
    field: 'credentialsMetadata',
    group: 'partner_config',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Credentials metadata (hasCredentials, updatedAt)',
    labelAr: 'بيانات وصفية لبيانات الاعتماد',
  }),
  entry({
    resource: 'partner_source',
    field: 'connectionStatus',
    group: 'partner_config',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Connection status',
    labelAr: 'حالة الاتصال',
  }),
  entry({
    resource: 'partner_source',
    field: 'lastSyncAt',
    group: 'partner_config',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Last sync at',
    labelAr: 'آخر مزامنة',
  }),
  entry({
    resource: 'partner_source',
    field: 'syncHistory',
    group: 'partner_config',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Sync history',
    labelAr: 'سجل المزامنة',
  }),
];

// ─── partner.verification ──────────────────────────────────────────

const PARTNER_VERIFICATION_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'partner.verification',
    field: 'partnerStatus',
    group: 'partner_data',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner status',
    labelAr: 'حالة الشريك',
  }),
  entry({
    resource: 'partner.verification',
    field: 'partnerActiveDate',
    group: 'partner_data',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner active date',
    labelAr: 'تاريخ التفعيل عند الشريك',
  }),
  entry({
    resource: 'partner.verification',
    field: 'partnerDftDate',
    group: 'partner_data',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner DFT date',
    labelAr: 'تاريخ DFT عند الشريك',
  }),
  entry({
    resource: 'partner.verification',
    field: 'tripCount',
    group: 'partner_data',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner trip count',
    labelAr: 'عدد رحلات الشريك',
  }),
  entry({
    resource: 'partner.verification',
    field: 'lastTripAt',
    group: 'partner_data',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Last trip at',
    labelAr: 'آخر رحلة',
  }),
  entry({
    resource: 'partner.verification',
    field: 'verificationStatus',
    group: 'partner_data',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Verification status',
    labelAr: 'حالة التحقق',
  }),
  entry({
    resource: 'partner.verification',
    field: 'warnings',
    group: 'partner_data',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Warnings',
    labelAr: 'تحذيرات',
  }),
  entry({
    resource: 'partner.verification',
    field: 'partnerSourceName',
    group: 'partner_data',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner source name',
    labelAr: 'اسم مصدر الشريك',
  }),
  entry({
    resource: 'partner.verification',
    field: 'partnerSnapshotId',
    group: 'partner_data',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner snapshot id',
    labelAr: 'معرّف لقطة الشريك',
  }),
  entry({
    resource: 'partner.verification',
    field: 'partnerRecordId',
    group: 'partner_data',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner record id',
    labelAr: 'معرّف سجل الشريك',
  }),
  entry({
    resource: 'partner.verification',
    field: 'milestoneProgress',
    group: 'partner_milestone',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Milestone progress',
    labelAr: 'تقدّم العلامات',
  }),
  entry({
    resource: 'partner.verification',
    field: 'commissionRisk',
    group: 'commission',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Commission risk',
    labelAr: 'خطر العمولة',
  }),
];

// ─── partner.evidence ──────────────────────────────────────────────

const PARTNER_EVIDENCE_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'partner.evidence',
    field: 'kind',
    group: 'partner_evidence',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Evidence kind',
    labelAr: 'نوع الدليل',
  }),
  entry({
    resource: 'partner.evidence',
    field: 'capturedBy',
    group: 'partner_evidence',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Captured by',
    labelAr: 'بواسطة',
  }),
  entry({
    resource: 'partner.evidence',
    field: 'notes',
    group: 'partner_evidence',
    sensitive: true,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Evidence notes',
    labelAr: 'ملاحظات الدليل',
  }),
  entry({
    resource: 'partner.evidence',
    field: 'partnerSnapshotId',
    group: 'partner_evidence',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner snapshot id',
    labelAr: 'معرّف لقطة الشريك',
  }),
  entry({
    resource: 'partner.evidence',
    field: 'partnerRecordId',
    group: 'partner_evidence',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner record id',
    labelAr: 'معرّف سجل الشريك',
  }),
  entry({
    resource: 'partner.evidence',
    field: 'fileName',
    group: 'partner_evidence',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'File name',
    labelAr: 'اسم الملف',
  }),
  entry({
    resource: 'partner.evidence',
    field: 'storageRef',
    group: 'partner_evidence',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Storage reference',
    labelAr: 'مرجع التخزين',
  }),
];

// ─── partner.reconciliation ────────────────────────────────────────

const PARTNER_RECONCILIATION_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'partner.reconciliation',
    field: 'category',
    group: 'reconciliation',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Category',
    labelAr: 'الفئة',
  }),
  entry({
    resource: 'partner.reconciliation',
    field: 'crmValues',
    group: 'reconciliation',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'CRM values',
    labelAr: 'قيم النظام',
  }),
  entry({
    resource: 'partner.reconciliation',
    field: 'partnerValues',
    group: 'reconciliation',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner values',
    labelAr: 'قيم الشريك',
  }),
  entry({
    resource: 'partner.reconciliation',
    field: 'recommendedAction',
    group: 'reconciliation',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Recommended action',
    labelAr: 'الإجراء الموصى به',
  }),
  entry({
    resource: 'partner.reconciliation',
    field: 'severity',
    group: 'reconciliation',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Severity',
    labelAr: 'الخطورة',
  }),
  entry({
    resource: 'partner.reconciliation',
    field: 'exportColumns',
    group: 'reconciliation',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'CSV export columns',
    labelAr: 'أعمدة تصدير CSV',
  }),
  entry({
    resource: 'partner.reconciliation',
    field: 'partnerRecordRef',
    group: 'reconciliation',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner record reference',
    labelAr: 'مرجع سجل الشريك',
  }),
];

// ─── partner.commission ─────────────────────────────────────────────
//
// D5.6B — fields surfaced by the commission progress / risk CSVs.
// The CSVs ship per-captain commission progress (target trips,
// current milestone, days left in the window, risk band) and the
// risk-only filtered variant. Catalogue entries here let an admin
// deny commission-window fields per role — Finance keeps `risk` /
// `target_trips` / `current_milestone`; non-finance roles can be
// configured to lose the column. The cap on the export endpoint is
// `partner.commission.export` (D5.6A); this catalogue resource
// gives column-level redaction the right anchor.

const PARTNER_COMMISSION_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'partner.commission',
    field: 'partnerSourceName',
    group: 'partner_milestone',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Partner source name',
    labelAr: 'اسم مصدر الشريك',
  }),
  entry({
    resource: 'partner.commission',
    field: 'configCode',
    group: 'partner_milestone',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Milestone config code',
    labelAr: 'رمز إعداد العلامة',
  }),
  entry({
    resource: 'partner.commission',
    field: 'anchorAt',
    group: 'partner_milestone',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Anchor (window start)',
    labelAr: 'بداية النافذة',
  }),
  entry({
    resource: 'partner.commission',
    field: 'windowEndsAt',
    group: 'partner_milestone',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Window ends at',
    labelAr: 'نهاية النافذة',
  }),
  entry({
    resource: 'partner.commission',
    field: 'daysLeft',
    group: 'partner_milestone',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Days remaining',
    labelAr: 'الأيام المتبقية',
  }),
  entry({
    resource: 'partner.commission',
    field: 'targetTrips',
    group: 'commission',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Target trips',
    labelAr: 'عدد الرحلات الهدف',
  }),
  entry({
    resource: 'partner.commission',
    field: 'currentMilestone',
    group: 'commission',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Current milestone',
    labelAr: 'العلامة الحالية',
  }),
  entry({
    resource: 'partner.commission',
    field: 'nextMilestone',
    group: 'commission',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Next milestone',
    labelAr: 'العلامة التالية',
  }),
  entry({
    resource: 'partner.commission',
    field: 'risk',
    group: 'commission',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Commission risk band',
    labelAr: 'مستوى خطر العمولة',
  }),
  entry({
    resource: 'partner.commission',
    field: 'needsPush',
    group: 'commission',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Needs push (commission action required)',
    labelAr: 'يتطلب دفع عمولة',
  }),
];

// ─── whatsapp.conversation ─────────────────────────────────────────

const WHATSAPP_CONVERSATION_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'whatsapp.conversation',
    field: 'contactPhone',
    group: 'whatsapp_basic',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Contact phone',
    labelAr: 'هاتف جهة الاتصال',
  }),
  entry({
    resource: 'whatsapp.conversation',
    field: 'lastMessagePreview',
    group: 'whatsapp_basic',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Last message preview',
    labelAr: 'معاينة آخر رسالة',
  }),
  entry({
    resource: 'whatsapp.conversation',
    field: 'conversationHistory',
    group: 'whatsapp_history',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Conversation history',
    labelAr: 'سجل المحادثة',
  }),
  entry({
    resource: 'whatsapp.conversation',
    field: 'handoverSummary',
    group: 'whatsapp_history',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Handover summary',
    labelAr: 'ملخص التسليم',
  }),
  entry({
    resource: 'whatsapp.conversation',
    field: 'handoverChain',
    group: 'whatsapp_history',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Handover chain',
    labelAr: 'سلسلة التسليم',
  }),
  entry({
    resource: 'whatsapp.conversation',
    field: 'priorAgentMessages',
    group: 'whatsapp_history',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Prior-agent messages',
    labelAr: 'رسائل الموظف السابق',
  }),
  entry({
    resource: 'whatsapp.conversation',
    field: 'reviewNotes',
    group: 'whatsapp_review',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Review notes',
    labelAr: 'ملاحظات المراجعة',
  }),
  entry({
    resource: 'whatsapp.conversation',
    field: 'internalMetadata',
    group: 'raw',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Internal metadata',
    labelAr: 'بيانات وصفية داخلية',
  }),
];

// ─── report ────────────────────────────────────────────────────────

const REPORT_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'report',
    field: 'columns',
    group: 'report_shape',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Columns',
    labelAr: 'الأعمدة',
  }),
  entry({
    resource: 'report',
    field: 'filters',
    group: 'report_shape',
    sensitive: false,
    defaultRead: true,
    defaultWrite: true,
    labelEn: 'Filters',
    labelAr: 'الفلاتر',
  }),
  entry({
    resource: 'report',
    field: 'exportRows',
    group: 'report_shape',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Export rows',
    labelAr: 'صفوف التصدير',
  }),
  entry({
    resource: 'report',
    field: 'financialMetrics',
    group: 'report_metrics',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Financial metrics',
    labelAr: 'مقاييس مالية',
  }),
  entry({
    resource: 'report',
    field: 'commissionMetrics',
    group: 'report_metrics',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Commission metrics',
    labelAr: 'مقاييس العمولات',
  }),
  entry({
    resource: 'report',
    field: 'sourceBreakdown',
    group: 'report_metrics',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Source breakdown',
    labelAr: 'تفصيل المصدر',
  }),
  entry({
    resource: 'report',
    field: 'campaignBreakdown',
    group: 'report_metrics',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Campaign breakdown',
    labelAr: 'تفصيل الحملات',
  }),
];

// ─── audit ─────────────────────────────────────────────────────────

const AUDIT_ENTRIES: readonly FieldCatalogueEntry[] = [
  entry({
    resource: 'audit',
    field: 'action',
    group: 'audit_meta',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Action',
    labelAr: 'الإجراء',
  }),
  entry({
    resource: 'audit',
    field: 'actor',
    group: 'audit_meta',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Actor',
    labelAr: 'المنفّذ',
  }),
  entry({
    resource: 'audit',
    field: 'entity',
    group: 'audit_meta',
    sensitive: false,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Entity',
    labelAr: 'الكيان',
  }),
  entry({
    resource: 'audit',
    field: 'payload',
    group: 'audit_payload',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Payload (raw)',
    labelAr: 'الحمولة (خام)',
  }),
  entry({
    resource: 'audit',
    field: 'beforeAfter',
    group: 'audit_payload',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'Before/after diff',
    labelAr: 'فرق قبل/بعد',
  }),
  entry({
    resource: 'audit',
    field: 'ipAddress',
    group: 'audit_meta',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'IP address',
    labelAr: 'عنوان IP',
  }),
  entry({
    resource: 'audit',
    field: 'userAgent',
    group: 'audit_meta',
    sensitive: true,
    defaultRead: true,
    defaultWrite: false,
    labelEn: 'User agent',
    labelAr: 'وكيل المستخدم',
  }),
];

// ─── master catalogue ──────────────────────────────────────────────

export const FIELD_CATALOGUE: readonly FieldCatalogueEntry[] = [
  ...LEAD_ENTRIES,
  ...LEAD_ACTIVITY_ENTRIES,
  ...LEAD_REVIEW_ENTRIES,
  ...ROTATION_ENTRIES,
  ...FOLLOWUP_ENTRIES,
  ...CAPTAIN_ENTRIES,
  ...CONTACT_ENTRIES,
  ...PARTNER_SOURCE_ENTRIES,
  ...PARTNER_VERIFICATION_ENTRIES,
  ...PARTNER_EVIDENCE_ENTRIES,
  ...PARTNER_RECONCILIATION_ENTRIES,
  ...PARTNER_COMMISSION_ENTRIES,
  ...WHATSAPP_CONVERSATION_ENTRIES,
  ...REPORT_ENTRIES,
  ...AUDIT_ENTRIES,
];

export const CATALOGUE_RESOURCES = [
  'lead',
  'lead.activity',
  'lead.review',
  'rotation',
  'followup',
  'captain',
  'contact',
  'partner_source',
  'partner.verification',
  'partner.evidence',
  'partner.reconciliation',
  'partner.commission',
  'whatsapp.conversation',
  'report',
  'audit',
] as const satisfies readonly CatalogueResource[];

/** O(1) lookup: tenants pass `(resource, field)` to test gateability. */
export function isCatalogued(resource: string, field: string): boolean {
  return FIELD_CATALOGUE.some((c) => c.resource === resource && c.field === field);
}

/**
 * D5.2 — Returns true when the catalogued entry forbids redaction
 * at the runtime layer (only `lead.id` and `captain.id` /
 * `contact.id` today, because the UUIDs are part of route paths).
 *
 * Fields not in the catalogue are treated as redactable (default
 * true) — the runtime is free to strip them, but no role-builder
 * UI knows about them so a deny row is never written.
 */
export function isRedactable(resource: string, field: string): boolean {
  const found = FIELD_CATALOGUE.find((c) => c.resource === resource && c.field === field);
  if (!found) return true;
  return found.redactable !== false;
}
