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
