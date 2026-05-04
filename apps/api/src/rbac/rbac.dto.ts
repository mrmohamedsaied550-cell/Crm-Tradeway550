import { z } from 'zod';

import { ALL_CAPABILITY_CODES } from './capabilities.registry';

/**
 * Phase C — C2: DTOs for the role builder + scope/field-permission
 * write surface. Strict at every level — additional keys are
 * rejected so a stale UI build can't silently send fields the
 * service ignores.
 *
 * `code` is the stable machine identifier (snake_case, ≥ 2 chars).
 * The 11 system codes are reserved — the service rejects any
 * collision (POST + duplicate) with `role.code_reserved`. Once
 * written, code is immutable.
 *
 * Capabilities are referenced by their global code; the service
 * validates each against the global capabilities table inside the
 * write tx so a typo gives a clear error rather than silently
 * dropping the row.
 *
 * Scopes are validated by the (resource × scope) tuple set the
 * migration's CHECK constraint already enforces; the DTO mirrors
 * the constraint for fast UI feedback.
 */

const codeShape = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'code must be snake_case (lowercase letters, digits, underscores)');

const nameShape = z.string().trim().min(1).max(120);
const descriptionShape = z.string().trim().min(0).max(500).nullable().optional();

/** Mirrors the migration 0030 CHECK on role_scopes.scope. */
export const ROLE_SCOPE_VALUES = ['own', 'team', 'company', 'country', 'global'] as const;
export const ROLE_SCOPE_RESOURCES = [
  'lead',
  'captain',
  'followup',
  'whatsapp.conversation',
] as const;

export type RoleScopeValue = (typeof ROLE_SCOPE_VALUES)[number];
export type RoleScopeResource = (typeof ROLE_SCOPE_RESOURCES)[number];

/** capability code: validated against the global registry. */
const capabilityCodeShape = z.enum(ALL_CAPABILITY_CODES as readonly [string, ...string[]]);

const scopeRowShape = z
  .object({
    resource: z.enum(ROLE_SCOPE_RESOURCES),
    scope: z.enum(ROLE_SCOPE_VALUES),
  })
  .strict();

const fieldPermissionRowShape = z
  .object({
    resource: z.string().trim().min(1).max(64),
    field: z.string().trim().min(1).max(128),
    canRead: z.boolean(),
    canWrite: z.boolean(),
  })
  .strict();

/** POST /rbac/roles — body. */
export const CreateRoleSchema = z
  .object({
    code: codeShape,
    nameEn: nameShape,
    nameAr: nameShape,
    level: z.number().int().min(0).max(100),
    description: descriptionShape,
    /** Initial capability codes; default empty (a role with no caps). */
    capabilities: z.array(capabilityCodeShape).optional().default([]),
    /**
     * Optional initial scopes per resource. Resources omitted from
     * the array default to 'global'. Duplicate resources are
     * rejected at the service layer.
     */
    scopes: z.array(scopeRowShape).optional().default([]),
    /**
     * Optional initial field permissions. Absence of a row means
     * canRead=true / canWrite=true (the system default).
     */
    fieldPermissions: z.array(fieldPermissionRowShape).optional().default([]),
  })
  .strict();
/**
 * Caller-side type uses `z.input` so optional-with-default fields
 * stay optional (defaults are applied by Zod at parse time). The
 * service consumes the parsed value via `z.output<typeof …>`
 * implicitly through the controller's `createZodDto`.
 */
export type CreateRoleDto = z.input<typeof CreateRoleSchema>;

/**
 * PATCH /rbac/roles/:id — body. All fields optional. `code` is
 * intentionally NOT here: codes are immutable after create.
 *
 * Capabilities, when present, REPLACE the role's capability set
 * entirely (the service does the diff + emits one audit row).
 *
 * System roles (`isSystem = true`) reject every key here at the
 * service layer with `role.system_immutable`.
 */
export const UpdateRoleSchema = z
  .object({
    nameEn: nameShape.optional(),
    nameAr: nameShape.optional(),
    level: z.number().int().min(0).max(100).optional(),
    description: descriptionShape,
    capabilities: z.array(capabilityCodeShape).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'PATCH body must include at least one field to update');
export type UpdateRoleDto = z.infer<typeof UpdateRoleSchema>;

/** POST /rbac/roles/:id/duplicate — body. New code + names required. */
export const DuplicateRoleSchema = z
  .object({
    code: codeShape,
    nameEn: nameShape,
    nameAr: nameShape,
    description: descriptionShape,
  })
  .strict();
export type DuplicateRoleDto = z.infer<typeof DuplicateRoleSchema>;

/** PUT /rbac/roles/:id/scopes — body. Atomic upsert of all scopes. */
export const PutRoleScopesSchema = z
  .object({
    scopes: z.array(scopeRowShape).min(1),
  })
  .strict()
  .refine((v) => {
    const seen = new Set<string>();
    for (const s of v.scopes) {
      if (seen.has(s.resource)) return false;
      seen.add(s.resource);
    }
    return true;
  }, 'each resource must appear at most once in scopes');
export type PutRoleScopesDto = z.infer<typeof PutRoleScopesSchema>;

/** PUT /rbac/roles/:id/field-permissions — body. */
export const PutRoleFieldPermissionsSchema = z
  .object({
    permissions: z.array(fieldPermissionRowShape),
  })
  .strict()
  .refine((v) => {
    const seen = new Set<string>();
    for (const p of v.permissions) {
      const k = `${p.resource}::${p.field}`;
      if (seen.has(k)) return false;
      seen.add(k);
    }
    return true;
  }, 'each (resource, field) pair must appear at most once');
export type PutRoleFieldPermissionsDto = z.infer<typeof PutRoleFieldPermissionsSchema>;
