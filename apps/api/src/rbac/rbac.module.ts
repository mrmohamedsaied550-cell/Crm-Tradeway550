import { Global, Module } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { RbacController } from './rbac.controller';
import { CapabilityGuard } from './capability.guard';
import { FieldFilterService } from './field-filter.service';
import { PermissionCacheService } from './permission-cache.service';
import { PermissionResolverService } from './permission-resolver.service';
import { ScopeContextService } from './scope-context.service';

/**
 * Global RBAC module. Exposes RbacService for any future module that needs
 * to introspect roles + capabilities. C14 added the read-only
 * `GET /rbac/roles` controller used by the admin UI's role picker.
 *
 * P2-01 also exports the CapabilityGuard so any controller can apply
 * `@UseGuards(JwtAuthGuard, CapabilityGuard)` together with one or
 * more `@RequireCapability(...)` decorators.
 *
 * Phase C — C3: also exports ScopeContextService so feature modules
 * (CrmModule first; others in C10) can AND a scope `where` clause
 * into their read paths.
 *
 * Phase C — C4: also exports FieldFilterService so feature modules
 * can strip denied fields from their read responses.
 *
 * Phase D5 — D5.1: registers `PermissionCacheService` and
 * `PermissionResolverService`. Both are foundation only — no
 * existing service consults the resolver yet, so runtime behaviour
 * is unchanged from D4. Later D5.x chunks (D5.3 redaction
 * interceptor, D5.7 previous-owner field permissions, …) consume
 * the resolver to drive dynamic permissions without rewriting the
 * existing per-request lookups.
 */
@Global()
@Module({
  controllers: [RbacController],
  providers: [
    RbacService,
    CapabilityGuard,
    ScopeContextService,
    FieldFilterService,
    PermissionCacheService,
    PermissionResolverService,
  ],
  exports: [
    RbacService,
    CapabilityGuard,
    ScopeContextService,
    FieldFilterService,
    PermissionCacheService,
    PermissionResolverService,
  ],
})
export class RbacModule {}
