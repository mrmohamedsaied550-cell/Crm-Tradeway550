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

const FieldMappingSchema = z.record(z.string().min(1)).superRefine((map, ctx) => {
  // Required: the mapping must produce a "name" and a "phone" field.
  // We enforce it on the source row, not the incoming Meta payload, so
  // the admin can configure the mapping ahead of time without knowing
  // the runtime payload shape.
  const targets = new Set(Object.values(map));
  if (!targets.has('name')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mapping must define a target "name"' });
  }
  if (!targets.has('phone')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mapping must define a target "phone"' });
  }
});

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
  })
  .strict();
export type CreateMetaLeadSourceDto = z.infer<typeof CreateMetaLeadSourceSchema>;

export const UpdateMetaLeadSourceSchema = CreateMetaLeadSourceSchema.partial().strict();
export type UpdateMetaLeadSourceDto = z.infer<typeof UpdateMetaLeadSourceSchema>;
