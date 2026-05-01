import { z } from 'zod';

/**
 * C22 — DTOs for the read-only conversations admin surface.
 *
 * Strict zod schemas mirror the convention used in the org module: any
 * unknown fields are rejected, pagination defaults match the rest of the
 * admin API.
 */

const conversationStatus = z.enum(['open', 'closed']);
export type ConversationStatus = z.infer<typeof conversationStatus>;

export const ListConversationsQuerySchema = z
  .object({
    accountId: z.string().uuid().optional(),
    status: conversationStatus.optional(),
    /** Free-text match against the other party's phone number. */
    phone: z.string().trim().min(1).max(32).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListConversationsQueryDto = z.infer<typeof ListConversationsQuerySchema>;

export const ListConversationMessagesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
export type ListConversationMessagesQueryDto = z.infer<typeof ListConversationMessagesQuerySchema>;

export const SendConversationMessageSchema = z
  .object({
    /** Plain text body. Media + templates land in a later chunk. */
    text: z.string().trim().min(1).max(4096),
  })
  .strict();
export type SendConversationMessageDto = z.infer<typeof SendConversationMessageSchema>;

/**
 * C25 — body for POST /conversations/:id/link-lead.
 * The service validates same-tenant + lead-exists itself; this schema
 * just guards the input shape.
 */
export const LinkConversationLeadSchema = z
  .object({
    leadId: z.string().uuid(),
  })
  .strict();
export type LinkConversationLeadDto = z.infer<typeof LinkConversationLeadSchema>;

/**
 * C35 — body for POST /conversations/:id/handover.
 *
 * Three transfer modes:
 *   - `full`    — keep history; just reassign the linked lead.
 *   - `clean`   — close the current conversation so the new agent
 *                 sees a clean inbox; future inbound from the same
 *                 phone opens a fresh thread.
 *   - `summary` — additionally write a `note` activity carrying the
 *                 outgoing agent's handover summary onto the lead.
 *
 * `notify` is a flag on the audit payload only — wiring a real
 * notification channel is out of scope for the MVP.
 */
export const HandoverConversationSchema = z
  .object({
    newAssigneeId: z.string().uuid(),
    mode: z.enum(['full', 'clean', 'summary']),
    summary: z.string().trim().max(2000).optional(),
    notify: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.mode !== 'summary' || (v.summary && v.summary.length > 0), {
    message: 'summary is required when mode = summary',
    path: ['summary'],
  });
export type HandoverConversationDto = z.infer<typeof HandoverConversationSchema>;

// ───── WhatsApp accounts admin (C24A) ─────

const provider = z.enum(['meta_cloud']);
export type WhatsAppProviderCode = z.infer<typeof provider>;

const phoneE164 = z
  .string()
  .trim()
  .min(6)
  .max(32)
  .regex(/^\+?[0-9]+$/u, 'must be digits with optional leading +');

const accessToken = z.string().trim().min(8).max(2048);
const appSecret = z.string().trim().min(4).max(512);
const verifyTokenField = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u, 'use letters / digits / `_` / `-`');

export const CreateWhatsAppAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    phoneNumber: phoneE164,
    phoneNumberId: z.string().trim().min(1).max(64),
    provider: provider.default('meta_cloud'),
    accessToken,
    /** Optional in dev; required for production signature verification. */
    appSecret: appSecret.optional(),
    verifyToken: verifyTokenField,
    isActive: z.boolean().optional(),
  })
  .strict();
export type CreateWhatsAppAccountDto = z.infer<typeof CreateWhatsAppAccountSchema>;

export const UpdateWhatsAppAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    phoneNumber: phoneE164.optional(),
    phoneNumberId: z.string().trim().min(1).max(64).optional(),
    /** Pass a new value to rotate the token; omit to leave unchanged. */
    accessToken: accessToken.optional(),
    /** Pass `null` to clear, a string to rotate, or omit to leave unchanged. */
    appSecret: appSecret.nullable().optional(),
    verifyToken: verifyTokenField.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateWhatsAppAccountDto = z.infer<typeof UpdateWhatsAppAccountSchema>;
