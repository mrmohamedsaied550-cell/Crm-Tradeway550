import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LockoutService } from './lockout.service';
import { SessionsService } from './sessions.service';
import { TokensService } from './tokens.service';

/**
 * Identity (auth) module.
 *
 * Exports JwtAuthGuard + TokensService so the tenant-context middleware
 * (which lives outside this module) and future business modules (C12+)
 * can reuse them without re-declaring the JWT plumbing.
 */
@Global()
@Module({
  imports: [
    // JwtService used by TokensService. Secrets/expiry are read per-call via
    // jwt.config.ts so we can have different secrets per token type.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokensService, SessionsService, LockoutService, JwtAuthGuard],
  exports: [JwtAuthGuard, TokensService],
})
export class IdentityModule {}
