import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RbacService } from './rbac.service';
import { RbacController } from './rbac.controller';
import { CapabilityGuard } from './capability.guard';
import { ExportAuditService } from './export-audit.service';
import { ExportInterceptor } from './export.interceptor';
import { ExportRedactionService } from './export-redaction.service';
import { FieldFilterService } from './field-filter.service';
import { FieldRedactionInterceptor } from './field-redaction.interceptor';
import { LeadReviewVisibilityService } from './lead-review-visibility.service';
import { OwnershipVisibilityService } from './ownership-visibility.service';
import { PermissionCacheService } from './permission-cache.service';
import { PermissionResolverService } from './permission-resolver.service';
import { RolePreviewService } from './role-preview.service';
import { ScopeContextService } from './scope-context.service';
import { WhatsAppVisibilityService } from './whatsapp-visibility.service';

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
 *
 * Phase D5 — D5.3: registers `FieldRedactionInterceptor` as a
 * global APP_INTERCEPTOR. The interceptor is a no-op for every
 * route that lacks `@ResourceFieldGate(resource)` metadata AND a
 * no-op when `D5_DYNAMIC_PERMISSIONS_V1=false`. D5.3 only attaches
 * the decorator to LeadsController.list / findOne; later chunks
 * extend it.
 *
 * Phase D5 — D5.6A: registers the export-governance foundation —
 * `ExportRedactionService`, `ExportAuditService`, and a separate
 * global `ExportInterceptor` keyed by `@ExportGate(...)`. The
 * export interceptor is a no-op for every route that lacks the
 * metadata (every route in this commit) and a no-op when the D5
 * flag is off. No controller wires `@ExportGate` in D5.6A; D5.6B
 * is the first chunk to consume it (partner reconciliation +
 * commission CSVs).
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
    FieldRedactionInterceptor,
    ExportRedactionService,
    ExportAuditService,
    ExportInterceptor,
    OwnershipVisibilityService,
    LeadReviewVisibilityService,
    RolePreviewService,
    WhatsAppVisibilityService,
    {
      provide: APP_INTERCEPTOR,
      useExisting: FieldRedactionInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useExisting: ExportInterceptor,
    },
  ],
  exports: [
    RbacService,
    CapabilityGuard,
    ScopeContextService,
    FieldFilterService,
    PermissionCacheService,
    PermissionResolverService,
    FieldRedactionInterceptor,
    ExportRedactionService,
    ExportAuditService,
    ExportInterceptor,
    OwnershipVisibilityService,
    LeadReviewVisibilityService,
    RolePreviewService,
    WhatsAppVisibilityService,
  ],
})
export class RbacModule {}
