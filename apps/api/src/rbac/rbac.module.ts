import { Global, Module } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { RbacController } from './rbac.controller';
import { CapabilityGuard } from './capability.guard';

/**
 * Global RBAC module. Exposes RbacService for any future module that needs
 * to introspect roles + capabilities. C14 added the read-only
 * `GET /rbac/roles` controller used by the admin UI's role picker.
 *
 * P2-01 also exports the CapabilityGuard so any controller can apply
 * `@UseGuards(JwtAuthGuard, CapabilityGuard)` together with one or
 * more `@RequireCapability(...)` decorators.
 */
@Global()
@Module({
  controllers: [RbacController],
  providers: [RbacService, CapabilityGuard],
  exports: [RbacService, CapabilityGuard],
})
export class RbacModule {}
