import { z } from 'zod';

/**
 * P2-09 — captain document DTOs.
 *
 * The actual file upload is the operator's responsibility — the
 * CRM stores `storageRef` (e.g. an S3 URL or a path under the
 * deployment's static-asset bucket). MVP keeps the kind list open
 * so a tenant in a market with extra paperwork can use a custom
 * value (e.g. "iqama" for KSA); a soft-validate regex enforces a
 * sane shape.
 */

export const DOCUMENT_KINDS_CANONICAL = [
  'id_card',
  'license',
  'vehicle_registration',
  'other',
] as const;

const documentKind = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/u, 'kind must be snake_case ASCII');

const reviewNotes = z.string().trim().max(2000).optional();

const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: 'must be an ISO 8601 datetime',
});

export const CreateCaptainDocumentSchema = z
  .object({
    kind: documentKind,
    storageRef: z.string().trim().min(1).max(2048),
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(120),
    sizeBytes: z
      .number()
      .int()
      .min(0)
      .max(50 * 1024 * 1024),
    /** Optional ISO datetime — flips status to "expired" past this time. */
    expiresAt: isoDateTime.nullable().optional(),
  })
  .strict();
export type CreateCaptainDocumentDto = z.infer<typeof CreateCaptainDocumentSchema>;

export const REVIEW_DECISIONS = ['approve', 'reject'] as const;

export const ReviewCaptainDocumentSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    notes: reviewNotes,
  })
  .strict();
export type ReviewCaptainDocumentDto = z.infer<typeof ReviewCaptainDocumentSchema>;

export const ListCaptainDocumentsQuerySchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
  })
  .strict();
export type ListCaptainDocumentsQueryDto = z.infer<typeof ListCaptainDocumentsQuerySchema>;
