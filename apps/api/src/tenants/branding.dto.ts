import { z } from 'zod';

/**
 * Sprint 15 (D15) — DTOs for the tenant-branding read/write surface.
 *
 * Storage decision: this sprint deliberately scopes to URL-based assets
 * only. No multipart upload, no S3 abstraction. Operators paste safe
 * http(s) URLs (or relative `/...` paths from the app's own /public).
 * A future sprint can add a signed-upload pipeline behind the same
 * field names without breaking the contract.
 *
 * Safety rules:
 *   • URL fields accept only `http://`, `https://`, or relative paths
 *     starting with `/`. The validator rejects `javascript:`, `data:`,
 *     and any other scheme that could exfiltrate the embedding page.
 *   • Color fields accept only 6-digit hex strings (`#rrggbb`). No CSS
 *     expressions, no `var(...)`, no `url(...)`. This keeps theme
 *     application deterministic and contrast-safe.
 *   • All fields are nullable: passing `null` clears, omitting keeps
 *     the prior value, passing a non-empty string sets it.
 */

const safeUrl = z
  .string()
  .trim()
  .min(1, 'URL is required when set')
  .max(2048, 'URL is too long')
  .refine(
    (v) => /^https?:\/\//iu.test(v) || v.startsWith('/'),
    'URL must start with http://, https://, or /',
  )
  .refine((v) => !/^javascript:/iu.test(v) && !/^data:/iu.test(v), 'URL scheme is not allowed');

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-f]{6}$/iu, 'Color must be a 6-digit hex like #1f3864');

const brandName = z.string().trim().min(1).max(120);

/**
 * PATCH /tenant/branding body. `null` clears a field, an omitted key
 * leaves it unchanged, a non-null value sets it. This three-way
 * distinction matters: the operator must be able to remove a logo
 * URL without sending the entire current settings object.
 */
export const UpdateTenantBrandingSchema = z
  .object({
    systemName: brandName.nullable().optional(),
    workspaceName: brandName.nullable().optional(),
    logoUrl: safeUrl.nullable().optional(),
    faviconUrl: safeUrl.nullable().optional(),
    loginImageUrl: safeUrl.nullable().optional(),
    primaryColor: hexColor.nullable().optional(),
    accentColor: hexColor.nullable().optional(),
    sidebarBgColor: hexColor.nullable().optional(),
    sidebarHoverColor: hexColor.nullable().optional(),
  })
  .strict();
export type UpdateTenantBrandingDto = z.infer<typeof UpdateTenantBrandingSchema>;

/** Read-side shape exposed by GET /tenant/branding. */
export interface TenantBranding {
  tenantId: string;
  systemName: string | null;
  workspaceName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  loginImageUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  sidebarBgColor: string | null;
  sidebarHoverColor: string | null;
  updatedAt: string | null;
  updatedById: string | null;
}
