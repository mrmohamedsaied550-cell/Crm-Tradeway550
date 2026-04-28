import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request tenant identity, resolved by TenantContextMiddleware before
 * any controller runs. The store is empty for "system" requests that do not
 * carry tenant scope (e.g. /health, /auth/login until C9 wires JWT).
 */
export interface TenantContext {
  tenantId: string;
  tenantCode: string;
  /** Resolution source — useful for logs and tests. */
  source: 'header' | 'jwt';
}

export const tenantContext = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext | undefined {
  return tenantContext.getStore();
}

/**
 * Returns the current tenant id or throws when no context is active.
 * Use from code that requires tenant scope (i.e. tenant-scoped queries).
 */
export function requireTenantId(): string {
  const ctx = tenantContext.getStore();
  if (!ctx) {
    throw new Error('No tenant context — request was not scoped to a tenant');
  }
  return ctx.tenantId;
}
