import { z } from 'zod';
import { LEAD_SOURCES } from '../crm/pipeline.registry';
import { ALL_STRATEGY_NAMES } from './distribution.types';

/**
 * Phase 1A — A7: HTTP DTOs for /distribution/* endpoints.
 *
 * Validation rules mirror the application invariants so the service
 * layer can trust its inputs:
 *   - `priority` clamped to [1, 1000] — keeps the picker's sort
 *     stable + prevents an admin typo from creating a runaway
 *     priority that's hard to undo.
 *   - `strategy` enum-narrowed to the 4 known names. The orchestrator
 *     looks them up via getStrategy(); an unknown name would throw.
 *   - `targetUserId` REQUIRED when strategy='specific_user',
 *     FORBIDDEN otherwise — enforced via .superRefine so the error
 *     surfaces with a stable code at the controller boundary.
 *   - working_hours is a permissive `Record<weekday, {start, end}>`
 *     for now; full tz-aware validation lands when the filter
 *     consumer is implemented (deferred from A4).
 */

const uuid = z.string().uuid();

// ─── Distribution rules ───

export const CreateDistributionRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    isActive: z.boolean().default(true),
    /** Lower = higher precedence; default 100. */
    priority: z.coerce.number().int().min(1).max(1000).default(100),
    source: z.enum(LEAD_SOURCES).nullable().optional(),
    companyId: uuid.nullable().optional(),
    countryId: uuid.nullable().optional(),
    targetTeamId: uuid.nullable().optional(),
    strategy: z.enum(ALL_STRATEGY_NAMES as readonly [string, ...string[]]),
    targetUserId: uuid.nullable().optional(),
  })
  .strict()
  .superRefine((dto, ctx) => {
    // specific_user MUST have a target; everything else MUST NOT.
    if (dto.strategy === 'specific_user' && !dto.targetUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'targetUserId is required when strategy is "specific_user"',
        path: ['targetUserId'],
      });
    }
    if (dto.strategy !== 'specific_user' && dto.targetUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'targetUserId is only valid when strategy is "specific_user"',
        path: ['targetUserId'],
      });
    }
  });
export type CreateDistributionRuleDto = z.infer<typeof CreateDistributionRuleSchema>;

/**
 * PATCH variant: every field optional, but the same specific_user
 * vs targetUserId invariant holds when BOTH are provided. The
 * service-level update reads the existing row and re-validates the
 * combined shape.
 */
export const UpdateDistributionRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional(),
    priority: z.coerce.number().int().min(1).max(1000).optional(),
    source: z.enum(LEAD_SOURCES).nullable().optional(),
    companyId: uuid.nullable().optional(),
    countryId: uuid.nullable().optional(),
    targetTeamId: uuid.nullable().optional(),
    strategy: z.enum(ALL_STRATEGY_NAMES as readonly [string, ...string[]]).optional(),
    targetUserId: uuid.nullable().optional(),
  })
  .strict();
export type UpdateDistributionRuleDto = z.infer<typeof UpdateDistributionRuleSchema>;

// ─── Agent capacities ───

/**
 * Working-hours JSON shape:
 *   { "mon": {"start": "09:00", "end": "18:00"}, "tue": {...}, ... }
 * Permissive validation today (key + HH:MM regex); the working-hours
 * filter implementation will tighten this when the candidate-filter
 * starts consuming it.
 */
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'must be HH:MM');
const workingHours = z.record(
  z.enum(WEEKDAYS),
  z.object({ start: timeOfDay, end: timeOfDay }).strict(),
);

export const UpsertAgentCapacitySchema = z
  .object({
    weight: z.coerce.number().int().min(0).max(100).optional(),
    isAvailable: z.boolean().optional(),
    /** ISO datetime; null clears the OOF window. */
    outOfOfficeUntil: z.string().datetime().nullable().optional(),
    /** null = no cap. */
    maxActiveLeads: z.coerce.number().int().min(0).max(10_000).nullable().optional(),
    workingHours: workingHours.nullable().optional(),
  })
  .strict();
export type UpsertAgentCapacityDto = z.infer<typeof UpsertAgentCapacitySchema>;

// ─── Routing logs query ───

export const ListRoutingLogsQuerySchema = z
  .object({
    leadId: uuid.optional(),
    from: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListRoutingLogsQueryDto = z.infer<typeof ListRoutingLogsQuerySchema>;
