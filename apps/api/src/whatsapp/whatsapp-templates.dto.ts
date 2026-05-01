import { z } from 'zod';

/**
 * P2-12 — WhatsApp template DTOs.
 *
 * Templates are recorded after Meta has approved them in the WABA
 * console — the CRM doesn't submit templates for approval; it
 * records the metadata so agents can pick the template by name from
 * a dropdown when starting / re-opening a conversation.
 */

export const TEMPLATE_CATEGORIES = ['marketing', 'utility', 'authentication'] as const;
export const TEMPLATE_STATUSES = ['approved', 'paused', 'rejected'] as const;

const language = z
  .string()
  .trim()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/u, 'must be a BCP-47 code (e.g. "en", "ar", "en_US")');

const templateName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_]*$/u, 'must be lowercase snake_case');

const bodyText = z.string().trim().min(1).max(2048);

export const CreateWhatsAppTemplateSchema = z
  .object({
    accountId: z.string().uuid(),
    name: templateName,
    language,
    category: z.enum(TEMPLATE_CATEGORIES),
    bodyText,
    status: z.enum(TEMPLATE_STATUSES).default('approved'),
  })
  .strict();
export type CreateWhatsAppTemplateDto = z.infer<typeof CreateWhatsAppTemplateSchema>;

export const UpdateWhatsAppTemplateSchema = z
  .object({
    bodyText: bodyText.optional(),
    category: z.enum(TEMPLATE_CATEGORIES).optional(),
    status: z.enum(TEMPLATE_STATUSES).optional(),
  })
  .strict();
export type UpdateWhatsAppTemplateDto = z.infer<typeof UpdateWhatsAppTemplateSchema>;

export const ListWhatsAppTemplatesQuerySchema = z
  .object({
    accountId: z.string().uuid().optional(),
    status: z.enum(TEMPLATE_STATUSES).optional(),
  })
  .strict();
export type ListWhatsAppTemplatesQueryDto = z.infer<typeof ListWhatsAppTemplatesQuerySchema>;

// ─── send DTOs (used by the conversation controller) ──────────────

export const SendTemplateMessageSchema = z
  .object({
    templateName,
    language,
    /** Positional values for `{{1}}`, `{{2}}`, ... — order matters. */
    variables: z.array(z.string().min(1).max(2048)).max(20).default([]),
  })
  .strict();
export type SendTemplateMessageDto = z.infer<typeof SendTemplateMessageSchema>;

export const SendMediaMessageSchema = z
  .object({
    kind: z.enum(['image', 'document']),
    /** URL the operator hosts the file at. Must be reachable by Meta. */
    mediaUrl: z.string().url().max(2048),
    mediaMimeType: z.string().trim().max(120).optional(),
    caption: z.string().max(1024).optional(),
  })
  .strict();
export type SendMediaMessageDto = z.infer<typeof SendMediaMessageSchema>;
