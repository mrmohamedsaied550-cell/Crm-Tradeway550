import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
  /**
   * Tenant code is required while we resolve tenants outside the JWT
   * (login is the operation that *creates* the tenant-bound JWT). Once
   * the platform supports email-derived tenant routing, this becomes
   * optional.
   */
  tenantCode: z.string().trim().min(1).max(64),
});
export type LoginDto = z.infer<typeof LoginSchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshDto = z.infer<typeof RefreshSchema>;

export const LogoutSchema = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutDto = z.infer<typeof LogoutSchema>;
