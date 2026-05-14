import { z } from 'zod';

/**
 * Sprint 10 (D10) — heartbeat payload. Every field is optional;
 * a bare `{}` is the common case (the client just wants to say
 * "I'm here").
 */
export const HeartbeatSchema = z
  .object({
    /**
     * Short generic context label. Free text but capped — the UI
     * renders it via i18n keys when known, falls back to "Working"
     * otherwise. NEVER includes lead identity.
     */
    context: z.string().trim().max(64).optional(),
    entityType: z.string().trim().max(64).optional(),
    entityId: z.string().uuid().optional(),
  })
  .strict();
export type HeartbeatDto = z.infer<typeof HeartbeatSchema>;

/**
 * Sprint 10 (D10) — activity payload. Same shape as heartbeat
 * plus `busy` so Add Action / Lead Detail can mark the user as
 * in-action for the busy window.
 */
export const ActivitySchema = z
  .object({
    context: z.string().trim().max(64).optional(),
    entityType: z.string().trim().max(64).optional(),
    entityId: z.string().uuid().optional(),
    busy: z.boolean().optional(),
  })
  .strict();
export type ActivityDto = z.infer<typeof ActivitySchema>;

/**
 * Bulk-by-ids query for /presence/users. The transform mirrors
 * the Sprint 8 user-scope-counts route: comma-separated UUIDs,
 * de-duplicated, capped at 200.
 */
export const ListPresenceQuerySchema = z
  .object({
    ids: z
      .string()
      .trim()
      .min(1)
      .max(200 * 38)
      .transform((s) => {
        const parts = s
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        return Array.from(new Set(parts));
      })
      .pipe(z.array(z.string().uuid()).max(200)),
  })
  .strict();
export type ListPresenceQueryDto = z.infer<typeof ListPresenceQuerySchema>;
