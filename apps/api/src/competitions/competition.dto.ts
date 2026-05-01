import { z } from 'zod';

/**
 * C33 — Competition DTOs.
 *
 * MVP fields: name, optional Company / Country / Team scope, date
 * window, leaderboard `metric`, free-text `reward`, status.
 */

export const COMPETITION_METRICS = [
  'leads_created',
  'activations',
  'first_trips',
  'conversion_rate',
] as const;
export type CompetitionMetric = (typeof COMPETITION_METRICS)[number];

export const COMPETITION_STATUSES = ['draft', 'active', 'closed'] as const;
export type CompetitionStatus = (typeof COMPETITION_STATUSES)[number];

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'invalid date');

export const CreateCompetitionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    companyId: z.string().uuid().nullable().optional(),
    countryId: z.string().uuid().nullable().optional(),
    teamId: z.string().uuid().nullable().optional(),
    startDate: isoDate,
    endDate: isoDate,
    metric: z.enum(COMPETITION_METRICS),
    reward: z.string().trim().min(1).max(280),
    status: z.enum(COMPETITION_STATUSES).optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.endDate) >= Date.parse(v.startDate), {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  });
export type CreateCompetitionDto = z.infer<typeof CreateCompetitionSchema>;

export const UpdateCompetitionSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    companyId: z.string().uuid().nullable().optional(),
    countryId: z.string().uuid().nullable().optional(),
    teamId: z.string().uuid().nullable().optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    metric: z.enum(COMPETITION_METRICS).optional(),
    reward: z.string().trim().min(1).max(280).optional(),
    status: z.enum(COMPETITION_STATUSES).optional(),
  })
  .strict();
export type UpdateCompetitionDto = z.infer<typeof UpdateCompetitionSchema>;

export const SetCompetitionStatusSchema = z
  .object({ status: z.enum(COMPETITION_STATUSES) })
  .strict();
export type SetCompetitionStatusDto = z.infer<typeof SetCompetitionStatusSchema>;
