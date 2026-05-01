import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createZodDto } from 'nestjs-zod';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { LoginSchema, RefreshSchema, LogoutSchema } from './auth.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import type { AccessTokenClaims } from './jwt.types';

class LoginRequestDto extends createZodDto(LoginSchema) {}
class RefreshRequestDto extends createZodDto(RefreshSchema) {}
class LogoutRequestDto extends createZodDto(LogoutSchema) {}

/**
 * /api/v1/auth/* — five endpoints exactly per the C9 spec.
 *
 * Throttling: a tighter limit (10 / minute / IP) on auth endpoints than
 * the global throttler default. Wired via `@Throttle` so the same Express
 * request lifecycle runs (no separate middleware to maintain).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Login with email + password under a tenant',
    description:
      'Returns access + refresh tokens. Lockout after 5 failed attempts within ' +
      '10 minutes; lock duration 15 minutes. Disabled accounts are rejected.',
  })
  async login(@Body() body: LoginRequestDto, @Req() req: Request) {
    return this.auth.login({
      email: body.email,
      password: body.password,
      tenantCode: body.tenantCode,
      userAgent: req.header('user-agent'),
      ip: req.ip,
    });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Rotate an active refresh token to a new access + refresh pair',
    description:
      'Reuse-detection: presenting a refresh token whose row is already revoked ' +
      'revokes the entire descendant chain.',
  })
  async refresh(@Body() body: RefreshRequestDto, @Req() req: Request) {
    return this.auth.refresh(body.refreshToken, {
      userAgent: req.header('user-agent'),
      ip: req.ip,
    });
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Revoke the presented refresh-token session' })
  async logout(@Body() body: LogoutRequestDto, @Req() req: Request): Promise<void> {
    await this.auth.logout(body.refreshToken, {
      userAgent: req.header('user-agent'),
      ip: req.ip,
    });
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Revoke every active session for the calling user' })
  async logoutAll(@CurrentUser() user: AccessTokenClaims, @Req() req: Request): Promise<void> {
    await this.auth.logoutAll(user.tid, user.sub, {
      userAgent: req.header('user-agent'),
      ip: req.ip,
    });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Return the calling user with role + capabilities' })
  async me(@CurrentUser() user: AccessTokenClaims) {
    return this.auth.me(user.tid, user.sub);
  }
}
