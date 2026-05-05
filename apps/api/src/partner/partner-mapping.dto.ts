import { z } from 'zod';

/**
 * Phase D4 — D4.2: PartnerFieldMapping DTOs.
 *
 * `targetField` is a closed set at the validation layer. The DB
 * column is TEXT so a future addition (e.g. `last_active_seen_at`)
 * is a code-only change. Service layer validates that `phone` is
 * always mapped before a source is considered ready for sync —
 * draft mappings without `phone` are accepted (operators can
 * configure incrementally) but the service surfaces a `mapping.
 * phone_required` readiness flag.
 *
 * `transformKind` is the optional row-level transform applied at
 * snapshot-write time in D4.3. v1 supports four kinds:
 *   • passthrough — no change (default; equivalent to NULL).
 *   • parse_date — best-effort ISO / locale parse to TIMESTAMPTZ.
 *   • to_e164 — phone normalisation using the source's tenant
 *     defaultDialCode (already in use across the CRM).
 *   • lowercase — string lowercase (for partner_status comparisons).
 */

export const PARTNER_TARGET_FIELDS = [
  'phone',
  'name',
  'partner_status',
  'partner_active_date',
  'partner_dft_date',
  'trip_count',
  'last_trip_at',
] as const;
export const PartnerTargetFieldSchema = z.enum(PARTNER_TARGET_FIELDS);
export type PartnerTargetField = z.infer<typeof PartnerTargetFieldSchema>;

export const PARTNER_TRANSFORM_KINDS = [
  'passthrough',
  'parse_date',
  'to_e164',
  'lowercase',
] as const;
export const PartnerTransformKindSchema = z.enum(PARTNER_TRANSFORM_KINDS);
export type PartnerTransformKind = z.infer<typeof PartnerTransformKindSchema>;

/** Body for `POST /partner-sources/:id/mappings`. */
export const CreatePartnerMappingSchema = z
  .object({
    sourceColumn: z.string().trim().min(1).max(200),
    targetField: PartnerTargetFieldSchema,
    transformKind: PartnerTransformKindSchema.optional(),
    transformArgs: z.record(z.unknown()).optional(),
    isRequired: z.boolean().default(false),
    displayOrder: z.number().int().min(0).max(1000).default(0),
  })
  .strict();
export type CreatePartnerMappingDto = z.infer<typeof CreatePartnerMappingSchema>;

/** Body for `PATCH /partner-sources/:id/mappings/:mappingId`. */
export const UpdatePartnerMappingSchema = z
  .object({
    sourceColumn: z.string().trim().min(1).max(200).optional(),
    targetField: PartnerTargetFieldSchema.optional(),
    transformKind: PartnerTransformKindSchema.nullable().optional(),
    transformArgs: z.record(z.unknown()).nullable().optional(),
    isRequired: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type UpdatePartnerMappingDto = z.infer<typeof UpdatePartnerMappingSchema>;
