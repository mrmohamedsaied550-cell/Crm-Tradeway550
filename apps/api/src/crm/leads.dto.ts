import { z } from 'zod';
import { LEAD_SOURCES, ACTIVITY_TYPES } from './pipeline.registry';

/**
 * CRM DTOs.
 *
 * Note on validation: the C10 spec called for class-validator, but the
 * existing convention from C6–C9 is zod via `nestjs-zod`. To keep the
 * codebase consistent we stay on zod here.
 *
 * P2-08 — phone normalisation moved from a strict zod `transform`
 * to the service layer so `LeadsService.create` can apply the
 * tenant's `defaultDialCode` to local-format input (e.g.
 * "01001234567" → "+201001234567"). The DTO only sanity-checks the
 * shape (length + permitted characters); rejection for malformed
 * phones surfaces from the service as a 400 with a `lead.invalid_phone`
 * code.
 */

const phoneInput = z
  .string()
  .trim()
  .min(6)
  .max(32)
  .regex(/^[\d+\s\-()]+$/u, 'phone may only contain digits, spaces, dashes, parens, or +');

/**
 * Phase A — A4: rich attribution payload stored on `Lead.attribution`
 * (JSONB).
 *
 *   • `source` — top-level channel; mirrors `Lead.source` for backward
 *     compat. Service layer guarantees both are written together.
 *   • `subSource` — finer-grained origin (e.g. 'meta_lead_form',
 *     'whatsapp_account_xyz', 'csv_import').
 *   • `campaign / adSet / ad` — id + optional name. Meta webhook
 *     populates these from the leadgen payload; CSV import via
 *     mapped columns.
 *   • `utm.*` — standard UTM fields, when the source provides them.
 *   • `referrer` — public referrer URL when known.
 *   • `custom` — escape hatch for tenant-specific extras (rare).
 *
 * `.strict()` is intentional at the top level so unknown keys fail
 * loudly; the nested objects are also strict for the same reason.
 * `custom` is the documented escape hatch.
 */
const AttributionRefSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

const AttributionUtmSchema = z
  .object({
    source: z.string().trim().min(1).max(120).optional(),
    medium: z.string().trim().min(1).max(120).optional(),
    campaign: z.string().trim().min(1).max(255).optional(),
    term: z.string().trim().min(1).max(120).optional(),
    content: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

export const AttributionInputSchema = z
  .object({
    /**
     * The `source` field is intentionally derived from `dto.source` at
     * the service layer rather than accepted here, so the two stay in
     * sync. Callers who hand-build attribution use the service helper.
     */
    subSource: z.string().trim().min(1).max(120).optional(),
    campaign: AttributionRefSchema.optional(),
    adSet: AttributionRefSchema.optional(),
    ad: AttributionRefSchema.optional(),
    utm: AttributionUtmSchema.optional(),
    referrer: z.string().trim().min(1).max(2048).optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type AttributionInputDto = z.infer<typeof AttributionInputSchema>;

export const CreateLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: phoneInput,
    email: z.string().trim().email().max(254).optional(),
    source: z.enum(LEAD_SOURCES).default('manual'),
    /**
     * Phase 1B — initial stage. Two ways to set it (mutually exclusive):
     *   • `pipelineStageId` — preferred; an explicit stage UUID. Must
     *     belong to the pipeline that gets resolved for this lead.
     *   • `stageCode` — legacy; resolved against the lead's pipeline
     *     (or the tenant default when no pipeline scope is set).
     * Omitting both defaults to the pipeline's first non-terminal stage
     * (the resolver picks the canonical "new" entry-point).
     */
    stageCode: z.string().trim().min(1).max(64).optional(),
    pipelineStageId: z.string().uuid().optional(),
    /**
     * Phase 1B — explicit (company × country) scope on the lead. Both
     * optional; the pipeline resolver falls back to the tenant default
     * when either is missing. Cross-tenant ids are rejected at the
     * service layer (RLS returns null on the lookup).
     */
    companyId: z.string().uuid().optional(),
    countryId: z.string().uuid().optional(),
    /**
     * Phase A — optional rich attribution payload. The service merges
     * `{ source: dto.source }` with this payload so `attribution.source`
     * always exists and matches the flat `source` field.
     */
    attribution: AttributionInputSchema.optional(),
    /** Optional initial assignment (must be a user id in the same tenant). */
    assignedToId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => !(v.stageCode && v.pipelineStageId), {
    message: 'pass either stageCode or pipelineStageId, not both',
    path: ['pipelineStageId'],
  });
export type CreateLeadDto = z.infer<typeof CreateLeadSchema>;

export const UpdateLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: phoneInput.optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    source: z.enum(LEAD_SOURCES).optional(),
  })
  .strict();
export type UpdateLeadDto = z.infer<typeof UpdateLeadSchema>;

export const AssignLeadSchema = z.object({
  /** Pass `null` to unassign. */
  assignedToId: z.string().uuid().nullable(),
});
export type AssignLeadDto = z.infer<typeof AssignLeadSchema>;

/**
 * Phase 1B — move stage accepts either:
 *   • `pipelineStageId` (preferred) — explicit stage UUID; rejected
 *     if it doesn't belong to the lead's pipeline.
 *   • `stageCode` (legacy) — resolved against the lead's pipeline.
 * Exactly one must be provided.
 */
export const MoveStageSchema = z
  .object({
    stageCode: z.string().trim().min(1).max(64).optional(),
    pipelineStageId: z.string().uuid().optional(),
    /**
     * Phase A — required when the target stage has
     * `terminalKind = 'lost'`. Forbidden otherwise (server clears any
     * existing reason when the lead leaves a 'lost' stage). Service
     * layer enforces both directions; the DTO can't because the
     * target's terminal kind is only known after pipeline lookup.
     */
    lostReasonId: z.string().uuid().optional(),
    /** Optional free-text elaboration; ignored if not moving to lost. */
    lostNote: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.stageCode) !== Boolean(v.pipelineStageId), {
    message: 'pass either stageCode or pipelineStageId (exactly one)',
    path: ['pipelineStageId'],
  });
export type MoveStageDto = z.infer<typeof MoveStageSchema>;

export const AddActivitySchema = z
  .object({
    /** Only agent-authored types are accepted from the controller. */
    type: z.enum(['note', 'call'] as const satisfies readonly (typeof ACTIVITY_TYPES)[number][]),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
export type AddActivityDto = z.infer<typeof AddActivitySchema>;

export const ConvertLeadSchema = z
  .object({
    /** Optional document flags at conversion time. */
    hasIdCard: z.boolean().optional(),
    hasLicense: z.boolean().optional(),
    hasVehicleRegistration: z.boolean().optional(),
    /** Optional team to own the captain post-handover. Validated cross-tenant. */
    teamId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type ConvertLeadDto = z.infer<typeof ConvertLeadSchema>;

// ───── Captains (C18) ─────

const captainStatus = z.enum(['active', 'inactive', 'archived']);
export type CaptainStatus = z.infer<typeof captainStatus>;

export const ListCaptainsQuerySchema = z
  .object({
    teamId: z.string().uuid().optional(),
    status: captainStatus.optional(),
    /** Free-text match across name + phone. */
    q: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListCaptainsQueryDto = z.infer<typeof ListCaptainsQuerySchema>;

export const ListLeadsQuerySchema = z
  .object({
    /**
     * Phase 1B — filter by stage. Three flavours; pass at most one:
     *   • `pipelineStageId` — exact stage row (preferred for Kanban).
     *   • `pipelineId`      — every lead currently in this pipeline
     *                         (Kanban "all columns" view).
     *   • `stageCode`       — legacy code-based filter; resolved
     *                         against the tenant default pipeline for
     *                         backward compatibility with old clients.
     */
    pipelineStageId: z.string().uuid().optional(),
    pipelineId: z.string().uuid().optional(),
    stageCode: z.string().trim().min(1).max(64).optional(),
    /** Phase 1B — narrow by (company, country). */
    companyId: z.string().uuid().optional(),
    countryId: z.string().uuid().optional(),
    assignedToId: z.string().uuid().optional(),
    /** Free-text match across name + phone + email. */
    q: z.string().trim().min(1).max(120).optional(),
    /** P3-03 — narrow to a single source (manual / import / meta_lead / whatsapp / other). */
    source: z.enum(LEAD_SOURCES).optional(),
    /** P3-03 — narrow by SLA state (active / breached / paused). */
    slaStatus: z.enum(['active', 'breached', 'paused'] as const).optional(),
    /**
     * P3-03 — created-at window. Both bounds are inclusive ISO-8601
     * timestamps; either can be omitted. The web filter sends
     * day-precision values (`yyyy-mm-ddT00:00:00Z`) so the boundary
     * semantics match the picker the user sees.
     */
    createdFrom: z.string().datetime().optional(),
    createdTo: z.string().datetime().optional(),
    /** P3-03 — only leads with no current assignee. */
    unassigned: z.coerce.boolean().optional(),
    /**
     * P3-03 — leads whose `nextActionDueAt` is in the past (i.e. a
     * pending follow-up has slipped). Checked against the request's
     * server time; tenant-timezone bounds aren't required because
     * "in the past" is a single moment.
     */
    hasOverdueFollowup: z.coerce.boolean().optional(),
    /** Pagination — basic offset/limit; cursor pagination arrives later. */
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict()
  .refine((v) => !v.createdFrom || !v.createdTo || v.createdFrom <= v.createdTo, {
    message: 'createdFrom must be earlier than or equal to createdTo',
    path: ['createdFrom'],
  });
export type ListLeadsQueryDto = z.infer<typeof ListLeadsQuerySchema>;

/**
 * Phase 1B — Kanban grouped query. Returns one bucket per stage of
 * the requested pipeline, each bucket carrying its `totalCount` and
 * the first `perStage` cards. Same filter shape as ListLeadsQuery
 * minus the stage / pipeline-stage selectors (the response groups
 * by stage by definition) and minus `offset`/`limit` (they are
 * replaced by `perStage`).
 *
 * `pipelineId` is REQUIRED — the Kanban view is always scoped to one
 * pipeline. Cross-pipeline boards are explicitly out of scope.
 */
export const ListLeadsByStageQuerySchema = z
  .object({
    pipelineId: z.string().uuid(),
    companyId: z.string().uuid().optional(),
    countryId: z.string().uuid().optional(),
    assignedToId: z.string().uuid().optional(),
    q: z.string().trim().min(1).max(120).optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    slaStatus: z.enum(['active', 'breached', 'paused'] as const).optional(),
    createdFrom: z.string().datetime().optional(),
    createdTo: z.string().datetime().optional(),
    unassigned: z.coerce.boolean().optional(),
    hasOverdueFollowup: z.coerce.boolean().optional(),
    /**
     * Cards per stage bucket. 50 is the default; large pipelines that
     * need more either filter further or "load more" via the legacy
     * paginated `GET /leads?pipelineStageId=...` endpoint.
     */
    perStage: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()
  .refine((v) => !v.createdFrom || !v.createdTo || v.createdFrom <= v.createdTo, {
    message: 'createdFrom must be earlier than or equal to createdTo',
    path: ['createdFrom'],
  });
export type ListLeadsByStageQueryDto = z.infer<typeof ListLeadsByStageQuerySchema>;

// ───── P3-05 — Bulk actions ─────

/**
 * P3-05 — every bulk endpoint takes an array of lead ids capped at
 * 100 per call. The cap keeps the inevitable "select all 1000 leads
 * and click" workflow from melting the API: the UI paginates the
 * call client-side and reports per-batch progress.
 */
const bulkLeadIds = z.array(z.string().uuid()).min(1).max(100);

export const BulkAssignSchema = z
  .object({
    leadIds: bulkLeadIds,
    /** Pass `null` to unassign the whole batch. */
    assignedToId: z.string().uuid().nullable(),
  })
  .strict();
export type BulkAssignDto = z.infer<typeof BulkAssignSchema>;

/**
 * Phase 1B — bulk stage moves accept either a stage code OR an
 * explicit pipeline stage id. Code-based bulk moves are kept for
 * the existing UI's bulk action and resolve per-lead against the
 * lead's own pipeline (so the same code in different pipelines
 * lands in the right place).
 */
export const BulkMoveStageSchema = z
  .object({
    leadIds: bulkLeadIds,
    stageCode: z.string().trim().min(1).max(64).optional(),
    pipelineStageId: z.string().uuid().optional(),
    /**
     * Phase A — single reason applied to the whole batch when the
     * target stage is 'lost'. Required for terminalKind=lost moves;
     * forbidden otherwise. Same per-lead validation as the singular
     * moveStage runs inside the per-id loop.
     */
    lostReasonId: z.string().uuid().optional(),
    lostNote: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.stageCode) !== Boolean(v.pipelineStageId), {
    message: 'pass either stageCode or pipelineStageId (exactly one)',
    path: ['pipelineStageId'],
  });
export type BulkMoveStageDto = z.infer<typeof BulkMoveStageSchema>;

export const BulkDeleteSchema = z
  .object({
    leadIds: bulkLeadIds,
  })
  .strict();
export type BulkDeleteDto = z.infer<typeof BulkDeleteSchema>;
