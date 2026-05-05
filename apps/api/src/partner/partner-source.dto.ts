import { z } from 'zod';

/**
 * Phase D4 — D4.2: PartnerSource DTOs.
 *
 * Closed enums at the validation layer for the small fixed sets
 * (`adapter`, `scheduleKind`, `tabMode`); open strings at the DB
 * layer (TEXT) so a future partner / adapter / schedule can be
 * added without a migration. The Zod schemas below enforce the
 * v1 contract at the controller boundary.
 *
 * Credentials clarification: the `credentials` field on Create /
 * Update is the PLAINTEXT payload from the form (e.g. for Google
 * Sheets: `{ serviceAccountEmail, privateKey, sheetId }`). The
 * service encrypts before persisting and the response DTO never
 * carries it back. API responses surface only safe metadata.
 */

export const PARTNER_ADAPTERS = ['google_sheets', 'manual_upload'] as const;
export const PartnerAdapterSchema = z.enum(PARTNER_ADAPTERS);
export type PartnerAdapter = z.infer<typeof PartnerAdapterSchema>;

export const PARTNER_SCHEDULE_KINDS = ['manual', 'cron'] as const;
export const PartnerScheduleKindSchema = z.enum(PARTNER_SCHEDULE_KINDS);
export type PartnerScheduleKind = z.infer<typeof PartnerScheduleKindSchema>;

export const PARTNER_TAB_MODES = ['fixed', 'new_per_period'] as const;
export const PartnerTabModeSchema = z.enum(PARTNER_TAB_MODES);
export type PartnerTabMode = z.infer<typeof PartnerTabModeSchema>;

/**
 * Tab discovery rule for `tabMode = 'new_per_period'`. v1 supports
 * two kinds:
 *   • name_pattern: an `'YYYY-MM-DD'`-style placeholder pattern.
 *     The adapter (D4.3) substitutes the latest date that yields a
 *     present tab.
 *   • most_recently_modified: pick whichever tab has the most
 *     recent modification time per the Sheets API metadata.
 */
export const TabDiscoveryRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('name_pattern'), pattern: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('most_recently_modified') }).strict(),
]);
export type TabDiscoveryRule = z.infer<typeof TabDiscoveryRuleSchema>;

/**
 * Partner-specific credentials shape. v1 supports Google Sheets
 * (service-account creds) and manual upload (no creds — the
 * operator uploads a CSV via the manual flow). Both end up in the
 * same encrypted envelope so the schema can grow without affecting
 * existing rows.
 */
export const GoogleSheetsCredentialsSchema = z
  .object({
    serviceAccountEmail: z.string().email().max(320),
    /** PEM private key — ignored at the DTO layer (any non-empty
     *  string is accepted; PEM validity is the adapter's concern). */
    privateKey: z.string().min(1),
    sheetId: z.string().min(1).max(200),
  })
  .strict();
export type GoogleSheetsCredentials = z.infer<typeof GoogleSheetsCredentialsSchema>;

/** Open-string envelope for non-Google-Sheets future adapters. */
export const PartnerCredentialsSchema = z.union([
  GoogleSheetsCredentialsSchema,
  z.record(z.unknown()),
]);
export type PartnerCredentials = z.infer<typeof PartnerCredentialsSchema>;

/**
 * Common refinement: a fixed-tab source must carry `fixedTabName`;
 * a new-per-period source must carry `tabDiscoveryRule`. Cron
 * scheduled sources must carry `cronSpec`. We enforce this at the
 * Zod boundary so the persistence layer never sees an
 * inconsistent row.
 */
export const PartnerSourceCorePayloadSchema = z
  .object({
    partnerCode: z.string().trim().min(1).max(64),
    displayName: z.string().trim().min(1).max(200),
    adapter: PartnerAdapterSchema,
    companyId: z.string().uuid().nullable().optional(),
    countryId: z.string().uuid().nullable().optional(),
    scheduleKind: PartnerScheduleKindSchema.default('manual'),
    cronSpec: z.string().trim().min(1).max(120).nullable().optional(),
    tabMode: PartnerTabModeSchema.default('fixed'),
    fixedTabName: z.string().trim().min(1).max(200).nullable().optional(),
    tabDiscoveryRule: TabDiscoveryRuleSchema.nullable().optional(),
    isActive: z.boolean().default(true),
    /** Optional credentials payload. When provided, the service
     *  encrypts before persisting. Omitting on Update keeps the
     *  existing envelope unchanged. Setting to `null` clears the
     *  envelope (admin "Forget credentials" flow). */
    credentials: PartnerCredentialsSchema.nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scheduleKind === 'cron' && !v.cronSpec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cronSpec'],
        message: 'cronSpec is required when scheduleKind is "cron".',
      });
    }
    if (v.tabMode === 'fixed' && !v.fixedTabName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fixedTabName'],
        message: 'fixedTabName is required when tabMode is "fixed".',
      });
    }
    if (v.tabMode === 'new_per_period' && !v.tabDiscoveryRule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tabDiscoveryRule'],
        message: 'tabDiscoveryRule is required when tabMode is "new_per_period".',
      });
    }
  });

/** Body for `POST /partner-sources`. */
export const CreatePartnerSourceSchema = PartnerSourceCorePayloadSchema;
export type CreatePartnerSourceDto = z.infer<typeof CreatePartnerSourceSchema>;

/**
 * Body for `PATCH /partner-sources/:id`. Every field optional —
 * caller sends only what changed. Cross-field invariants are
 * re-checked in the service after merging with the existing row
 * (Zod can't see the persisted row at parse time).
 */
export const UpdatePartnerSourceSchema = z
  .object({
    partnerCode: z.string().trim().min(1).max(64).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    adapter: PartnerAdapterSchema.optional(),
    companyId: z.string().uuid().nullable().optional(),
    countryId: z.string().uuid().nullable().optional(),
    scheduleKind: PartnerScheduleKindSchema.optional(),
    cronSpec: z.string().trim().min(1).max(120).nullable().optional(),
    tabMode: PartnerTabModeSchema.optional(),
    fixedTabName: z.string().trim().min(1).max(200).nullable().optional(),
    tabDiscoveryRule: TabDiscoveryRuleSchema.nullable().optional(),
    isActive: z.boolean().optional(),
    credentials: PartnerCredentialsSchema.nullable().optional(),
  })
  .strict();
export type UpdatePartnerSourceDto = z.infer<typeof UpdatePartnerSourceSchema>;

/** Query schema for `GET /partner-sources`. */
export const ListPartnerSourcesSchema = z
  .object({
    companyId: z.string().uuid().optional(),
    countryId: z.string().uuid().optional(),
    partnerCode: z.string().trim().min(1).max(64).optional(),
    isActive: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListPartnerSourcesDto = z.infer<typeof ListPartnerSourcesSchema>;
