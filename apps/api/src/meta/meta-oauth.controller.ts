/**
 * Sprint M2 — Meta OAuth controller.
 *
 *   GET /api/v1/meta/auth/initiate
 *     Admin-only. Builds the Facebook OAuth dialog URL for the
 *     active tenant and 302-redirects the operator. `returnTo` is a
 *     post-callback redirect target (typically the admin
 *     "connections" page).
 *
 *   GET /api/v1/meta/auth/callback
 *     Public. Receives Meta's `code` + `state`, runs the full token
 *     exchange, encrypts and persists the long-lived token, then
 *     either 302-redirects to the signed `returnTo` (with
 *     `?connectionId=…`) or returns a JSON envelope when no
 *     `returnTo` was provided.
 *
 * The callback route is intentionally unauthenticated — the operator
 * has bounced through Meta's domain and any JWT cookie/header is out
 * of scope by the time we get the redirect. Tenant identity is
 * carried in the HMAC-signed `state` parameter.
 */

import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import { requireTenantId } from '../tenants/tenant-context';
import { MetaOAuthService } from './meta-oauth.service';

@ApiTags('crm')
@Controller('meta/auth')
export class MetaOAuthController {
  private readonly logger = new Logger(MetaOAuthController.name);

  constructor(private readonly oauth: MetaOAuthService) {}

  @Get('initiate')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability('meta.leadsource.write')
  @ApiOperation({ summary: 'Begin Meta OAuth — redirects the operator to Facebook' })
  initiate(@Res() res: Response, @Query('returnTo') returnTo?: string): void {
    const tenantId = requireTenantId();
    const url = this.oauth.buildAuthorizeUrl({
      tenantId,
      ...(typeof returnTo === 'string' && returnTo.length > 0 && { returnTo }),
    });
    res.redirect(302, url);
  }

  /**
   * Sprint M2 / Phase 3 — same URL builder as /initiate, but returns
   * JSON so the admin SPA can fetch it with a Bearer token and then
   * `window.open` the result in a popup. A top-level navigation to
   * /initiate would work too, but the Bearer token can't ride along
   * on a `window.open` navigation (cookies aren't used by this CRM),
   * so the popup flow needs this JSON variant.
   */
  @Get('authorize-url')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability('meta.leadsource.write')
  @ApiOperation({ summary: 'Return the Meta OAuth dialog URL as JSON' })
  getAuthorizeUrl(@Query('returnTo') returnTo?: string): { authorizeUrl: string } {
    const tenantId = requireTenantId();
    const authorizeUrl = this.oauth.buildAuthorizeUrl({
      tenantId,
      ...(typeof returnTo === 'string' && returnTo.length > 0 && { returnTo }),
    });
    return { authorizeUrl };
  }

  @Get('callback')
  @ApiOperation({ summary: 'Meta OAuth callback — exchanges the code for a long-lived token' })
  async callback(
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('error_description') errorDescription?: string,
  ): Promise<void> {
    if (typeof error === 'string' && error.length > 0) {
      this.logger.warn(
        `OAuth callback returned error: ${error}${errorDescription ? ` — ${errorDescription}` : ''}`,
      );
      throw new BadRequestException({
        code: 'meta.oauth.user_cancelled',
        message: `Meta declined the request: ${error}`,
      });
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new BadRequestException({
        code: 'meta.oauth.missing_code',
        message: 'Missing `code` query parameter',
      });
    }
    if (typeof state !== 'string' || state.length === 0) {
      throw new BadRequestException({
        code: 'meta.oauth.missing_state',
        message: 'Missing `state` query parameter',
      });
    }

    const result = await this.oauth.handleCallback({ code, state });

    if (typeof result.returnTo === 'string' && /^https?:\/\//u.test(result.returnTo)) {
      const sep = result.returnTo.includes('?') ? '&' : '?';
      res.redirect(
        302,
        `${result.returnTo}${sep}connectionId=${encodeURIComponent(result.connectionId)}`,
      );
      return;
    }

    res.status(200).json({
      ok: true,
      connectionId: result.connectionId,
      facebookName: result.facebookName,
    });
  }
}
