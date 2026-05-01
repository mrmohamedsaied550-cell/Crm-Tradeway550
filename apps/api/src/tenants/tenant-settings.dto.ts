import { z } from 'zod';

/**
 * P2-08 — DTOs for the tenant-level settings row.
 *
 * Validation rules:
 *
 *   - `timezone` must be a valid IANA zone string. We rely on the
 *     runtime's Intl support to reject typos: `Intl.DateTimeFormat`
 *     throws RangeError on bogus zones, and the schema catches it.
 *
 *   - `slaMinutes` is the response-SLA window. Clamped to 1..1440
 *     so a typo can't produce a degenerate "0 minutes" SLA or a
 *     month-long window.
 *
 *   - `defaultDialCode` is an E.164 country prefix (`+` then 1..4
 *     digits). Service code prepends it to bare local-format phone
 *     numbers; the strict `normalizeE164` helper still rejects
 *     malformed input either way.
 */

const ianaTimezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (v) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid IANA timezone (e.g. "Africa/Cairo")' },
  );

const dialCode = z
  .string()
  .trim()
  .regex(/^\+\d{1,4}$/u, 'must be E.164 country prefix (e.g. "+20")');

const slaMinutes = z.coerce
  .number()
  .int()
  .min(1)
  .max(24 * 60);

export const UpdateTenantSettingsSchema = z
  .object({
    timezone: ianaTimezone.optional(),
    slaMinutes: slaMinutes.optional(),
    defaultDialCode: dialCode.optional(),
  })
  .strict();
export type UpdateTenantSettingsDto = z.infer<typeof UpdateTenantSettingsSchema>;
