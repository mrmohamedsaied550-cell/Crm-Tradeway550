import { Global, Module } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { RbacController } from './rbac.controller';
import { CapabilityGuard } from './capability.guard';
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
 */
@Global()
@Module({
  controllers: [RbacController],
  providers: [RbacService, CapabilityGuard, ScopeContextService],
  exports: [RbacService, CapabilityGuard, ScopeContextService],
})
export class RbacModule {}
