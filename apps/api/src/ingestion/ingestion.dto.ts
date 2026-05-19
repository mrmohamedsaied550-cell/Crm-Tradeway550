import { z } from 'zod';
import { LEAD_SOURCES } from '../crm/pipeline.registry';

/**
 * P2-06 — DTOs for lead ingestion (CSV import + Meta lead-source admin).
 *
 * The CSV import endpoint takes the file as a JSON-encoded string in
 * the request body so the upload path stays multipart-free. The shape:
 *
 *   {
 *     csv:         "<full csv text>",
 *     mapping: {
 *       name:    "Full Name",
 *       phone:   "Phone",
 *       email:   "Email"     // optional
 *     },
 *     defaultSource: "import",
 *     autoAssign:    true       // round-robin each created lead
 *   }
 *
 * The mapping keys are CRM lead fields; the values are the matching
 * CSV header names. Unknown CRM fields are rejected by the schema.
 */

export const CsvImportMappingSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(1).max(120),
    email: z.string().trim().min(1).max(120).optional(),
    /**
     * Phase A — A4: optional CSV columns whose values land in
     * `Lead.attribution`. Each maps a CSV header to the
     * corresponding attribution field; missing entries (or
     * missing values per row) are silently skipped.
     */
    campaignId: z.string().trim().min(1).max(120).optional(),
    campaignName: z.string().trim().min(1).max(120).optional(),
    adSetId: z.string().trim().min(1).max(120).optional(),
    adSetName: z.string().trim().min(1).max(120).optional(),
    adId: z.string().trim().min(1).max(120).optional(),
    adName: z.string().trim().min(1).max(120).optional(),
    utmSource: z.string().trim().min(1).max(120).optional(),
    utmMedium: z.string().trim().min(1).max(120).optional(),
    utmCampaign: z.string().trim().min(1).max(120).optional(),
    utmTerm: z.string().trim().min(1).max(120).optional(),
    utmContent: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type CsvImportMapping = z.infer<typeof CsvImportMappingSchema>;

export const CsvImportSchema = z
  .object({
    /** Full CSV text. Capped at ~5 MB to bound memory + DB write time. */
    csv: z.string().min(1).max(5_000_000),
    mapping: CsvImportMappingSchema,
    defaultSource: z.enum(LEAD_SOURCES).default('import'),
    autoAssign: z.boolean().default(true),
  })
  .strict();
export type CsvImportDto = z.infer<typeof CsvImportSchema>;

// ─── Meta lead-source admin DTOs ───

/**
 * V1 — the legacy flat `{ metaKey: leadField }` shape persisted by the
 * pre-Sprint-M2 admin UI. Kept as an accepted input so old admin
 * scripts and the legacy editor still POST cleanly; the ingest path
 * normalises V1 to V2 at read time (see meta-field-mapping.helper).
 */
const FieldMappingV1Schema = z.record(z.string().min(1)).superRefine((map, ctx) => {
  const targets = new Set(Object.values(map));
  if (!targets.has('name')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mapping must define a target "name"' });
  }
  if (!targets.has('phone')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mapping must define a target "phone"' });
  }
});

const META_LEAD_FIELD_KEYS = [
  'name',
  'phone',
  'email',
  'source',
  'companyId',
  'countryId',
] as const;
const META_CONTACT_FIELD_KEYS = ['displayName', 'language'] as const;

const MetaMappingTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lead_field'), field: z.enum(META_LEAD_FIELD_KEYS) }),
  z.object({ kind: z.literal('contact_field'), field: z.enum(META_CONTACT_FIELD_KEYS) }),
  z.object({ kind: z.literal('custom_field'), customFieldId: z.string().uuid() }),
  z.object({ kind: z.literal('ignore'), reason: z.string().max(255).optional() }),
]);

const MetaMappingEntrySchema = z.object({
  metaKey: z.string().min(1).max(255),
  metaLabel: z.string().max(255).optional(),
  target: MetaMappingTargetSchema,
  transform: z
    .object({
      trim: z.boolean().optional(),
      lowercase: z.boolean().optional(),
      normaliseE164: z.boolean().optional(),
    })
    .optional(),
});

/**
 * Sprint M2 — versioned mapping shape. Save path for the new
 * admin UI; carries discriminated targets so the operator can pick
 * `lead_field`, `contact_field`, `custom_field`, or `ignore` without
 * the JSON-textarea quirks of V1.
 *
 * Same required-target rule as V1: at least one entry must land on
 * `lead_field.name` and one on `lead_field.phone`. The ingest path
 * drops events that produce neither, so accepting a mapping that
 * can't possibly succeed would just shift the failure to runtime.
 */
const FieldMappingV2Schema = z
  .object({
    version: z.literal(2),
    entries: z.array(MetaMappingEntrySchema).max(200),
    strict: z.boolean().optional(),
  })
  .superRefine((map, ctx) => {
    const leadTargets = map.entries
      .filter((e) => e.target.kind === 'lead_field')
      .map((e) => (e.target as { kind: 'lead_field'; field: string }).field);
    if (!leadTargets.includes('name')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mapping must define a lead_field target "name"',
        path: ['entries'],
      });
    }
    if (!leadTargets.includes('phone')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mapping must define a lead_field target "phone"',
        path: ['entries'],
      });
    }
  });

const FieldMappingSchema = z.union([FieldMappingV2Schema, FieldMappingV1Schema]);

export const CreateMetaLeadSourceSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    pageId: z.string().trim().min(1).max(64),
    formId: z.string().trim().min(1).max(64).nullable().optional(),
    verifyToken: z.string().trim().min(8).max(255),
    appSecret: z.string().trim().min(8).max(255).nullable().optional(),
    defaultSource: z.enum(LEAD_SOURCES).default('meta'),
    fieldMapping: FieldMappingSchema,
    isActive: z.boolean().default(true),
    // Sprint M2 — optional OAuth wiring + Graph-snapshotted metadata.
    oauthConnectionId: z.string().uuid().nullable().optional(),
    pageName: z.string().trim().min(1).max(255).nullable().optional(),
    formName: z.string().trim().min(1).max(255).nullable().optional(),
    // Sprint M2 — operator-facing taxonomy (dropdowns in the new UI).
    project: z.string().trim().min(1).max(120).nullable().optional(),
    channel: z.string().trim().min(1).max(60).nullable().optional(),
    campaign: z.string().trim().min(1).max(255).nullable().optional(),
  })
  .strict();
export type CreateMetaLeadSourceDto = z.infer<typeof CreateMetaLeadSourceSchema>;

export const UpdateMetaLeadSourceSchema = CreateMetaLeadSourceSchema.partial().strict();
export type UpdateMetaLeadSourceDto = z.infer<typeof UpdateMetaLeadSourceSchema>;
