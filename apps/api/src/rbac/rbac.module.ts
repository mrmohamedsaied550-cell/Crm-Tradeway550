import { Global, Module } from '@nestjs/common';
import { RbacService } from './rbac.service';

/**
 * Global RBAC module. Exposes RbacService for any future module that needs
 * to introspect roles + capabilities. The decorators / guards that actually
 * enforce capabilities on endpoints land in C9 once auth is wired.
 */
@Global()
@Module({
  providers: [RbacService],
  exports: [RbacService],
})
export class RbacModule {}
