import { z } from 'zod';

/**
 * Reporting filters (C38 + P2-11).
 *
 * Optional company / country / team scope and a date window. The
 * service applies whichever filters are present; missing fields fall
 * through to "no filter on that axis." P2-11 made the
 * company / country branches actually compose against the
 * `Lead.assignedTo.team.country.companyId` chain.
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

export const TIMESERIES_METRICS = ['leads_created', 'activations', 'first_trips'] as const;

/**
 * P2-11 — daily-bucket time-series query. Same scope filters as the
 * summary, plus a `metric` selector. When `from` / `to` are omitted
 * we default to the trailing 30 days ending now.
 */
export const TimeseriesQuerySchema = ReportFiltersSchema.extend({
  metric: z.enum(TIMESERIES_METRICS),
}).strict();
export type TimeseriesQueryDto = z.infer<typeof TimeseriesQuerySchema>;
