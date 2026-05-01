import { z } from 'zod';

/**
 * C38 — reporting filters.
 *
 * Optional company / country / team scope and a date window. The
 * service applies whichever filters are present; missing fields fall
 * through to "no filter on that axis."
 */
export const ReportFiltersSchema = z
  .object({
    companyId: z.string().uuid().optional(),
    countryId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    /** Inclusive ISO date or datetime; defaults to "no lower bound." */
    from: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), 'invalid from date')
      .optional(),
    /** Inclusive ISO date or datetime; defaults to now. */
    to: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), 'invalid to date')
      .optional(),
  })
  .strict();
export type ReportFiltersDto = z.infer<typeof ReportFiltersSchema>;
