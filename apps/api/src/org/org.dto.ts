import { z } from 'zod';

/**
 * C12 — Organization-structure DTOs (zod via nestjs-zod).
 *
 * Mirrors the leads.dto convention: `.strict()` everywhere on update so
 * unknown fields are rejected loudly, slug-style codes lower-cased and
 * trimmed at the schema boundary, and string lengths capped to keep
 * future indexes / log lines bounded.
 */

const slugCode = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9_-]+$/u, 'must be lowercase letters, digits, "_" or "-"');

const isoCountryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/u, 'must be a 2-letter ISO country code');

// ───────── Companies ─────────

export const CreateCompanySchema = z
  .object({
    code: slugCode,
    name: z.string().trim().min(1).max(120),
    isActive: z.boolean().optional(),
  })
  .strict();
export type CreateCompanyDto = z.infer<typeof CreateCompanySchema>;

export const UpdateCompanySchema = z
  .object({
    code: slugCode.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateCompanyDto = z.infer<typeof UpdateCompanySchema>;

// ───────── Countries ─────────

export const CreateCountrySchema = z
  .object({
    companyId: z.string().uuid(),
    code: isoCountryCode,
    name: z.string().trim().min(1).max(120),
    isActive: z.boolean().optional(),
  })
  .strict();
export type CreateCountryDto = z.infer<typeof CreateCountrySchema>;

export const UpdateCountrySchema = z
  .object({
    code: isoCountryCode.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateCountryDto = z.infer<typeof UpdateCountrySchema>;

export const ListCountriesQuerySchema = z
  .object({
    companyId: z.string().uuid().optional(),
  })
  .strict();
export type ListCountriesQueryDto = z.infer<typeof ListCountriesQuerySchema>;

// ───────── Teams ─────────

export const CreateTeamSchema = z
  .object({
    countryId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    isActive: z.boolean().optional(),
  })
  .strict();
export type CreateTeamDto = z.infer<typeof CreateTeamSchema>;

export const UpdateTeamSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateTeamDto = z.infer<typeof UpdateTeamSchema>;

export const ListTeamsQuerySchema = z
  .object({
    countryId: z.string().uuid().optional(),
  })
  .strict();
export type ListTeamsQueryDto = z.infer<typeof ListTeamsQuerySchema>;

// ───────── Users (admin CRUD) ─────────

const emailField = z.string().trim().toLowerCase().email().max(254);

const userStatus = z.enum(['active', 'invited', 'disabled']);
export type UserStatus = z.infer<typeof userStatus>;

export const CreateUserSchema = z
  .object({
    email: emailField,
    name: z.string().trim().min(1).max(120),
    password: z.string().min(8).max(128),
    roleId: z.string().uuid(),
    teamId: z.string().uuid().nullable().optional(),
    phone: z.string().trim().min(4).max(32).optional(),
    language: z.enum(['ar', 'en']).optional(),
    status: userStatus.optional(),
  })
  .strict();
export type CreateUserDto = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    roleId: z.string().uuid().optional(),
    /** Pass `null` to remove team membership; omit to leave unchanged. */
    teamId: z.string().uuid().nullable().optional(),
    phone: z.string().trim().min(4).max(32).nullable().optional(),
    language: z.enum(['ar', 'en']).optional(),
    status: userStatus.optional(),
  })
  .strict();
export type UpdateUserDto = z.infer<typeof UpdateUserSchema>;

export const ListUsersQuerySchema = z
  .object({
    teamId: z.string().uuid().optional(),
    roleId: z.string().uuid().optional(),
    status: userStatus.optional(),
    /** Free-text search across email + name. */
    q: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListUsersQueryDto = z.infer<typeof ListUsersQuerySchema>;

// Focused single-field mutation DTOs used by the per-row admin actions.
// Strict so any extra field (e.g. accidentally posting the whole user
// payload) is rejected — keeps the surface area auditable.

export const SetUserRoleSchema = z.object({ roleId: z.string().uuid() }).strict();
export type SetUserRoleDto = z.infer<typeof SetUserRoleSchema>;

export const SetUserTeamSchema = z
  .object({
    /** Pass `null` to detach the user from any team. */
    teamId: z.string().uuid().nullable(),
  })
  .strict();
export type SetUserTeamDto = z.infer<typeof SetUserTeamSchema>;

export const SetUserStatusSchema = z.object({ status: userStatus }).strict();
export type SetUserStatusDto = z.infer<typeof SetUserStatusSchema>;
