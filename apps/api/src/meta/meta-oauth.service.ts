/**
 * Sprint M2 — Facebook OAuth flow for the Meta Lead Ads integration.
 *
 * Surfaces:
 *   1. `buildAuthorizeUrl({ tenantId, returnTo })` — returns the
 *      Facebook OAuth dialog URL with a signed `state` carrying the
 *      tenant id (and an optional UI return URL). The controller
 *      issues a 302 to this URL.
 *
 *   2. `handleCallback({ code, state })` — verifies the state's HMAC
 *      and TTL, exchanges `code` → short-lived user token, then
 *      short-lived → long-lived (~60-day) user token, then fetches
 *      `/me` to capture the Facebook user id and display name, and
 *      upserts a `MetaOAuthConnection` row. The long-lived token is
 *      AES-256-GCM encrypted at rest via `encryptSecret`.
 *
 * Upsert semantics: a tenant may re-run the connect flow for the
 * same Facebook user (e.g. after granting an additional permission).
 * `(tenantId, facebookUserId)` is unique on the table, so the second
 * run refreshes the token in place and clears `revokedAt`.
 */

import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';

import { encryptSecret } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { FetchFn } from './meta-graph.service';
import { getMetaConfig } from './meta.config';
import { InvalidStateError, signOAuthState, verifyOAuthState } from './meta-state.helper';

const OAUTH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'leads_retrieval',
  'ads_management',
];

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface MeResponse {
  id?: string;
  name?: string;
}

export interface OAuthCallbackResult {
  connectionId: string;
  tenantId: string;
  facebookUserId: string;
  facebookName: string;
  returnTo: string | undefined;
}

@Injectable()
export class MetaOAuthService {
  private readonly logger = new Logger(MetaOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly fetchImpl: FetchFn = globalThis.fetch as unknown as FetchFn,
  ) {}

  buildAuthorizeUrl(input: { tenantId: string; returnTo?: string }): string {
    const cfg = getMetaConfig();
    if (cfg.appId.length === 0 || cfg.redirectUri.length === 0 || cfg.stateSecret.length === 0) {
      throw new BadRequestException({
        code: 'meta.oauth.not_configured',
        message:
          'Meta OAuth is not configured (META_APP_ID / META_REDIRECT_URI / META_OAUTH_STATE_SECRET missing)',
      });
    }
    const state = signOAuthState(
      {
        tenantId: input.tenantId,
        ...(input.returnTo !== undefined && { returnTo: input.returnTo }),
      },
      cfg.stateSecret,
    );
    const params = new URLSearchParams({
      client_id: cfg.appId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: OAUTH_SCOPES.join(','),
      state,
    });
    return `https://www.facebook.com/${cfg.graphApiVersion}/dialog/oauth?${params.toString()}`;
  }

  async handleCallback(input: { code: string; state: string }): Promise<OAuthCallbackResult> {
    const cfg = getMetaConfig();
    if (cfg.appId.length === 0 || cfg.appSecret.length === 0 || cfg.redirectUri.length === 0) {
      throw new BadRequestException({
        code: 'meta.oauth.not_configured',
        message: 'Meta OAuth is not configured (app id / secret / redirect uri missing)',
      });
    }

    let payload;
    try {
      payload = verifyOAuthState(input.state, cfg.stateSecret);
    } catch (err) {
      if (err instanceof InvalidStateError) {
        throw new BadRequestException({
          code: err.code,
          message: 'OAuth state is invalid or expired',
        });
      }
      throw err;
    }

    // 1. code → short-lived user access token
    const shortLivedUrl =
      `https://graph.facebook.com/${cfg.graphApiVersion}/oauth/access_token?` +
      new URLSearchParams({
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        redirect_uri: cfg.redirectUri,
        code: input.code,
      }).toString();
    const shortLived = await this.fetchJson<TokenResponse>(shortLivedUrl);
    if (typeof shortLived.access_token !== 'string' || shortLived.access_token.length === 0) {
      throw new BadGatewayException({
        code: 'meta.oauth.code_exchange_failed',
        message: 'Meta did not return an access token for the authorization code',
      });
    }

    // 2. short-lived → long-lived (~60-day) user access token
    const longLivedUrl =
      `https://graph.facebook.com/${cfg.graphApiVersion}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        fb_exchange_token: shortLived.access_token,
      }).toString();
    const longLived = await this.fetchJson<TokenResponse>(longLivedUrl);
    if (typeof longLived.access_token !== 'string' || longLived.access_token.length === 0) {
      throw new BadGatewayException({
        code: 'meta.oauth.long_lived_exchange_failed',
        message: 'Meta did not return a long-lived access token',
      });
    }
    const expiresAt =
      typeof longLived.expires_in === 'number' && longLived.expires_in > 0
        ? new Date(Date.now() + longLived.expires_in * 1000)
        : null;

    // 3. /me — identifies the Facebook account behind the token
    const meUrl = `https://graph.facebook.com/${cfg.graphApiVersion}/me?fields=id,name`;
    const me = await this.fetchJson<MeResponse>(meUrl, longLived.access_token);
    if (typeof me.id !== 'string' || me.id.length === 0 || typeof me.name !== 'string') {
      throw new BadGatewayException({
        code: 'meta.oauth.me_failed',
        message: 'Meta did not return a recognised /me payload',
      });
    }

    // 4. encrypt + upsert
    const encrypted = encryptSecret(longLived.access_token);
    const row = await this.prisma.metaOAuthConnection.upsert({
      where: {
        tenantId_facebookUserId: { tenantId: payload.tenantId, facebookUserId: me.id },
      },
      update: {
        facebookName: me.name,
        accessToken: encrypted,
        expiresAt,
        revokedAt: null,
      },
      create: {
        tenantId: payload.tenantId,
        facebookUserId: me.id,
        facebookName: me.name,
        accessToken: encrypted,
        expiresAt,
      },
      select: { id: true, tenantId: true, facebookUserId: true, facebookName: true },
    });

    return {
      connectionId: row.id,
      tenantId: row.tenantId,
      facebookUserId: row.facebookUserId,
      facebookName: row.facebookName,
      returnTo: payload.returnTo,
    };
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async fetchJson<T>(url: string, bearer?: string): Promise<T> {
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers:
          typeof bearer === 'string' && bearer.length > 0
            ? { Authorization: `Bearer ${bearer}` }
            : {},
      });
    } catch (err) {
      this.logger.warn(`OAuth fetch network error: ${(err as Error).name}`);
      throw new BadGatewayException({
        code: 'meta.oauth.network',
        message: 'Network error contacting Meta',
      });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(`OAuth fetch ${res.status}: ${detail.slice(0, 200)}`);
      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedException({
          code: 'meta.oauth.rejected',
          message: `Meta rejected the request (HTTP ${res.status})`,
        });
      }
      throw new BadGatewayException({
        code: 'meta.oauth.http_error',
        message: `Meta returned HTTP ${res.status}`,
      });
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      this.logger.warn(`OAuth fetch JSON parse error: ${(err as Error).message}`);
      throw new BadGatewayException({
        code: 'meta.oauth.parse',
        message: 'Meta returned an unparseable response',
      });
    }
  }
}
