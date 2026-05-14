import { z } from 'zod';

/**
 * Sprint 12 (D12) — Lead Documents DTOs.
 *
 * Metadata-only on Sprint 12. A future sprint adds the binary
 * storage backend (S3 / local bucket) + the upload signed-URL
 * dance; until then the operator can record a file name +
 * mime/size to log "we have the document via WhatsApp / email"
 * without faking a real file.
 *
 * Status allow-list mirrors the DB CHECK in
 * `0049_d12_lead_documents`.
 */

export const LEAD_DOCUMENT_STATUSES = [
  'missing',
  'uploaded',
  'accepted',
  'rejected',
  'needs_resubmission',
] as const;
export type LeadDocumentStatus = (typeof LEAD_DOCUMENT_STATUSES)[number];

/** Reviewer statuses — flipping to one of these requires a reason + reviewer. */
export const LEAD_DOCUMENT_NEGATIVE_STATUSES = ['rejected', 'needs_resubmission'] as const;
export type LeadDocumentNegativeStatus = (typeof LEAD_DOCUMENT_NEGATIVE_STATUSES)[number];

/** Default registry — the UI uses this when no row exists yet. */
export const LEAD_DOCUMENT_DEFAULT_TYPES = [
  'national_id',
  'driving_license',
  'vehicle_license',
  'profile_photo',
] as const;
export type LeadDocumentType = (typeof LEAD_DOCUMENT_DEFAULT_TYPES)[number] | string;

const documentTypeSchema = z.string().trim().min(1).max(64);
const documentStatusSchema = z.enum(LEAD_DOCUMENT_STATUSES);

/**
 * Create a new lead document metadata row. `status` is optional;
 * defaults to `uploaded` so the most common "operator received
 * the doc" path is one POST. To track a known-missing requirement
 * the caller passes `status: 'missing'` explicitly.
 */
export const CreateLeadDocumentSchema = z
  .object({
    type: documentTypeSchema,
    label: z.string().trim().max(120).optional(),
    status: documentStatusSchema.optional(),
    fileName: z.string().trim().max(255).optional(),
    fileUrl: z.string().trim().max(1024).optional(),
    mimeType: z.string().trim().max(120).optional(),
    sizeBytes: z.number().int().min(0).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type CreateLeadDocumentDto = z.infer<typeof CreateLeadDocumentSchema>;

/**
 * Patch an existing row. Every field is optional. Status transitions
 * to `rejected` / `needs_resubmission` MUST carry a non-empty
 * `rejectionReason` — the service enforces this above the DB CHECK
 * so the error returns a clean code instead of a Postgres detail.
 */
export const UpdateLeadDocumentSchema = z
  .object({
    label: z.string().trim().max(120).optional(),
    status: documentStatusSchema.optional(),
    fileName: z.string().trim().max(255).optional(),
    fileUrl: z.string().trim().max(1024).optional(),
    mimeType: z.string().trim().max(120).optional(),
    sizeBytes: z.number().int().min(0).optional(),
    rejectionReason: z.string().trim().max(2000).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type UpdateLeadDocumentDto = z.infer<typeof UpdateLeadDocumentSchema>;

/**
 * Optional list filter.
 */
export const ListLeadDocumentsQuerySchema = z
  .object({
    status: documentStatusSchema.optional(),
    type: documentTypeSchema.optional(),
  })
  .strict();
export type ListLeadDocumentsQueryDto = z.infer<typeof ListLeadDocumentsQuerySchema>;
