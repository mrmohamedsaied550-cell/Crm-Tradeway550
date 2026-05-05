import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';

import type { AccessTokenClaims } from '../identity/jwt.types';

import { isD5DynamicPermissionsV1Enabled } from './d5-feature-flag';
import { type CatalogueResource, isRedactable } from './field-catalogue.registry';
import { FieldFilterService } from './field-filter.service';
import { PermissionResolverService } from './permission-resolver.service';
import { RESOURCE_FIELD_GATE_KEY } from './resource-field-gate.decorator';

/**
 * Phase D5 — D5.3: HTTP-layer field redaction interceptor.
 *
 * Reads the `@ResourceFieldGate(resource)` metadata, asks
 * `PermissionResolverService` (cached via the D5.1 LRU) for the
 * caller's denied-read fields for that resource, then strips
 * them from the response with `FieldFilterService.filterRead` /
 * `filterReadMany` before the body leaves the API.
 *
 * Why a second chokepoint over the existing service-layer redaction
 * (`LeadsService.applyLeadFieldFilter`):
 *   • The service-layer hook lives in `LeadsService` only — every
 *     other resource (captain, contact, partner.*, whatsapp.*,
 *     audit, …) currently has no redaction at all. D5.4-D5.5 will
 *     plug those in via this same interceptor instead of repeating
 *     the per-service wiring.
 *   • The interceptor reads via the cached resolver, so future
 *     resources don't pay an extra DB roundtrip.
 *   • Filtering twice is idempotent — `filterRead` deletes paths
 *     that may already be absent.
 *
 * Safety contract:
 *   1. When `D5_DYNAMIC_PERMISSIONS_V1=false`, the interceptor is a
 *      no-op. Every existing test + production response shape is
 *      byte-identical to D4.
 *   2. When the route has no `@ResourceFieldGate` decoration, the
 *      interceptor is a no-op (every legacy route is unchanged).
 *   3. Super-admin bypass is preserved — `PermissionResolverService`
 *      returns empty deny lists for `super_admin`, so the strip
 *      walks zero paths.
 *   4. Non-redactable fields (catalogue entries with
 *      `redactable: false` — `lead.id` / `captain.id` / `contact.id`)
 *      are filtered OUT of the deny list before stripping. Even if
 *      a tenant persists a deny row for `lead.id`, the UUID
 *      survives because the URL contract depends on it.
 *   5. Pagination envelopes `{ items: [...], total, ... }` are
 *      detected and only `items` is stripped through `filterReadMany`;
 *      the envelope keys (`total`, `limit`, `offset`) are preserved.
 *   6. Plain arrays are stripped through `filterReadMany`.
 *   7. Plain objects are stripped through `filterRead`.
 *   8. Primitives / null are returned untouched.
 *   9. The original response is mutated by `filterRead` (deep-clone
 *      via JSON round-trip in FieldFilterService keeps Prisma row
 *      objects safe). The handler's `data` is replaced with the
 *      stripped clone, so callers downstream of the interceptor
 *      receive only redacted data.
 *
 * Observability:
 *   The interceptor logs a single debug line when it actually
 *   strips paths (count + resource), so a tenant flipping the flag
 *   gets a quick "redaction is active for X" signal in the
 *   application log.
 */
@Injectable()
export class FieldRedactionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(FieldRedactionInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolverService,
    private readonly fieldFilter: FieldFilterService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Resolve `@ResourceFieldGate` metadata — handler first, then
    // class — so a future class-level annotation works without
    // every method repeating it.
    const resource = this.reflector.getAllAndOverride<CatalogueResource | undefined>(
      RESOURCE_FIELD_GATE_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!resource) {
      return next.handle();
    }

    if (!isD5DynamicPermissionsV1Enabled()) {
      return next.handle();
    }

    const req = ctx.switchToHttp().getRequest<Request & { user?: AccessTokenClaims }>();
    const user = req.user;
    if (!user) {
      // No authenticated user — JwtAuthGuard would normally have
      // rejected the request before reaching here. Defensive
      // fall-through: skip redaction; the response shape is
      // whatever the handler returned.
      return next.handle();
    }

    return next.handle().pipe(switchMap((data) => from(this.applyRedaction(resource, user, data))));
  }

  private async applyRedaction(
    resource: CatalogueResource,
    user: AccessTokenClaims,
    data: unknown,
  ): Promise<unknown> {
    if (data === null || data === undefined) return data;
    if (typeof data !== 'object') return data;

    const resolved = await this.resolver.resolveForUser({
      tenantId: user.tid,
      userId: user.sub,
      roleId: user.rid,
    });

    const denied = (resolved.deniedReadFieldsByResource[resource] ?? []).filter((field) =>
      isRedactable(resource, field),
    );
    if (denied.length === 0) return data;

    this.logger.debug(
      `redacting ${denied.length} field(s) on ${resource} for role ${resolved.role.code}`,
    );

    // Pagination-envelope detection: { items: [...], ...rest }.
    if (Array.isArray((data as { items?: unknown }).items) && typeof data === 'object') {
      const envelope = data as { items: unknown[] } & Record<string, unknown>;
      const filteredItems = this.fieldFilter.filterReadMany(envelope.items, denied);
      return { ...envelope, items: filteredItems };
    }

    if (Array.isArray(data)) {
      return this.fieldFilter.filterReadMany(data, denied);
    }

    return this.fieldFilter.filterRead(data, denied);
  }
}
