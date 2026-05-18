/**
 * Sprint M2 — Meta Graph API client for the Lead Ads integration.
 *
 * Loads the encrypted long-lived User Access Token from
 * `MetaOAuthConnection`, decrypts via `decryptSecret`, and calls Graph
 * over native `fetch`. Mirrors the WhatsApp `MetaCloudProvider`
 * pattern: optional `FetchFn` injection so tests can stub HTTP
 * without depending on `@nestjs/axios` or undici.
 *
 * Endpoints implemented (Phase 2 surface only):
 *   - `getPages(connectionId)`               → /me/accounts
 *   - `getLeadForms(connectionId, pageId)`   → /{page}/leadgen_forms
 *   - `getFormQuestions(connectionId, fid)`  → /{form}?fields=questions
 *   - `getLeadData(connectionId, leadId, pageId?)` → /{leadgen-id}
 *   - `getAttributionNames(connectionId, adId)`    → /{ad-id}
 *
 * Errors:
 *   - Token revoked / expired / missing      → `UnauthorizedException`
 *   - Page not in the user's /me/accounts    → `UnauthorizedException`
 *   - 401/403 from Graph                     → `UnauthorizedException`
 *   - Network failure / 5xx / parse error    → `BadGatewayException`
 *
 * `getAttributionNames` is treated as best-effort: a Graph failure
 * that isn't an auth problem returns `null`, since "no campaign
 * names" should not block lead ingestion.
 */

import {
  BadGatewayException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';

import { decryptSecret } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { getMetaConfig } from './meta.config';

/** Minimal `fetch`-compatible function so tests can swap a stub. */
export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

export interface GraphPage {
  id: string;
  name: string;
  /** Page-level access token, scoped to this page only. */
  accessToken: string;
}

export interface GraphLeadForm {
  id: string;
  name: string;
  status: string;
}

export interface GraphFormQuestion {
  /** Stable key Meta uses on lead payloads (`full_name`, `phone_number`, …). */
  key: string;
  /** Display label as written in the form (locale-dependent). */
  label: string;
  /** Question type — `FULL_NAME` / `PHONE` / `EMAIL` / `CUSTOM` / … */
  type: string;
}

export interface GraphLeadData {
  leadgenId: string;
  createdTime: Date;
  fieldData: { name: string; values: string[] }[];
  /** Populated when the lead came from an ad (vs an organic post). */
  adId: string | null;
}

export interface GraphAttributionNames {
  campaignId: string;
  campaignName: string;
  adsetId: string;
  adsetName: string;
  adId: string;
  adName: string;
}

@Injectable()
export class MetaGraphService {
  private readonly logger = new Logger(MetaGraphService.name);

  constructor(
    private readonly prisma: PrismaService,
    /**
     * Tests inject a `fetch` stub. Production wiring uses the global
     * `fetch` (Node 20+). `@Optional()` is required for the same
     * reason MetaCloudProvider needs it — function-type aliases are
     * erased at runtime, so without `@Optional()` Nest tries to
     * resolve a `Function` provider and crashes on boot.
     */
    @Optional() private readonly fetchImpl: FetchFn = globalThis.fetch as unknown as FetchFn,
  ) {}

  // ─── public API ────────────────────────────────────────────────────

  async getPages(connectionId: string): Promise<GraphPage[]> {
    const { token } = await this.loadUserToken(connectionId);
    const url = `${this.graphBase()}/me/accounts?fields=id,name,access_token&limit=200`;
    type Resp = {
      data?: Array<{ id?: string; name?: string; access_token?: string }>;
    };
    const data = await this.getJson<Resp>(url, token);
    if (!Array.isArray(data.data)) return [];
    return data.data
      .filter(
        (p): p is { id: string; name: string; access_token: string } =>
          typeof p?.id === 'string' &&
          typeof p?.name === 'string' &&
          typeof p?.access_token === 'string',
      )
      .map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token }));
  }

  async getLeadForms(connectionId: string, pageId: string): Promise<GraphLeadForm[]> {
    const pageToken = await this.loadPageToken(connectionId, pageId);
    const url = `${this.graphBase()}/${encodeURIComponent(pageId)}/leadgen_forms?fields=id,name,status&limit=200`;
    type Resp = { data?: Array<{ id?: string; name?: string; status?: string }> };
    const data = await this.getJson<Resp>(url, pageToken);
    if (!Array.isArray(data.data)) return [];
    return data.data
      .filter(
        (f): f is { id: string; name: string; status?: string } =>
          typeof f?.id === 'string' && typeof f?.name === 'string',
      )
      .map((f) => ({
        id: f.id,
        name: f.name,
        status: typeof f.status === 'string' ? f.status : 'UNKNOWN',
      }));
  }

  async getFormQuestions(connectionId: string, formId: string): Promise<GraphFormQuestion[]> {
    // The form's `questions` field is reachable with the user token
    // when the user has access to the parent page. Falling back to a
    // page-level token would require knowing the page id, which the
    // caller doesn't always have at this point (the admin UI may
    // pick a form id without a parent page lookup first).
    const { token } = await this.loadUserToken(connectionId);
    const url = `${this.graphBase()}/${encodeURIComponent(formId)}?fields=questions`;
    type Resp = {
      questions?: Array<{ key?: string; label?: string; type?: string }>;
    };
    const data = await this.getJson<Resp>(url, token);
    if (!Array.isArray(data.questions)) return [];
    return data.questions
      .filter(
        (q): q is { key: string; label?: string; type?: string } => typeof q?.key === 'string',
      )
      .map((q) => ({
        key: q.key,
        label: typeof q.label === 'string' ? q.label : '',
        type: typeof q.type === 'string' ? q.type : 'CUSTOM',
      }));
  }

  /**
   * Fetch a single lead's data by leadgen id. A page-level token is
   * preferred (Meta's docs recommend it for leadgen retrieval); the
   * user token is used as a fallback when the caller doesn't have
   * the parent page id handy.
   */
  async getLeadData(
    connectionId: string,
    leadgenId: string,
    pageId?: string,
  ): Promise<GraphLeadData> {
    const token =
      typeof pageId === 'string' && pageId.length > 0
        ? await this.loadPageToken(connectionId, pageId)
        : (await this.loadUserToken(connectionId)).token;
    const url = `${this.graphBase()}/${encodeURIComponent(leadgenId)}?fields=id,created_time,field_data,ad_id`;
    type Resp = {
      id?: string;
      created_time?: string;
      field_data?: Array<{ name?: string; values?: unknown }>;
      ad_id?: string;
    };
    const data = await this.getJson<Resp>(url, token);
    const fieldData: { name: string; values: string[] }[] = [];
    if (Array.isArray(data.field_data)) {
      for (const f of data.field_data) {
        if (typeof f?.name !== 'string' || f.name.length === 0) continue;
        const values = Array.isArray(f.values)
          ? f.values.filter((v): v is string => typeof v === 'string')
          : [];
        fieldData.push({ name: f.name, values });
      }
    }
    return {
      leadgenId: typeof data.id === 'string' ? data.id : leadgenId,
      createdTime: typeof data.created_time === 'string' ? new Date(data.created_time) : new Date(),
      fieldData,
      adId: typeof data.ad_id === 'string' && data.ad_id.length > 0 ? data.ad_id : null,
    };
  }

  /**
   * Fetch ad → ad-set → campaign names in a single Graph call.
   * Returns `null` on any non-auth failure (network, 5xx, missing
   * fields) so the caller can still create a Lead without
   * attribution names. Auth failures still throw — the connection is
   * broken and the caller should surface that, not silently dump
   * future leads with empty attribution.
   */
  async getAttributionNames(
    connectionId: string,
    adId: string,
  ): Promise<GraphAttributionNames | null> {
    if (typeof adId !== 'string' || adId.length === 0) return null;
    const { token } = await this.loadUserToken(connectionId);
    const url = `${this.graphBase()}/${encodeURIComponent(adId)}?fields=id,name,adset{id,name},campaign{id,name}`;
    type Resp = {
      id?: string;
      name?: string;
      adset?: { id?: string; name?: string };
      campaign?: { id?: string; name?: string };
    };
    let data: Resp;
    try {
      data = await this.getJson<Resp>(url, token);
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.warn(`getAttributionNames failed for ad ${adId}: ${(err as Error).message}`);
      return null;
    }
    if (
      typeof data.id !== 'string' ||
      typeof data.name !== 'string' ||
      typeof data.adset?.id !== 'string' ||
      typeof data.adset?.name !== 'string' ||
      typeof data.campaign?.id !== 'string' ||
      typeof data.campaign?.name !== 'string'
    ) {
      return null;
    }
    return {
      adId: data.id,
      adName: data.name,
      adsetId: data.adset.id,
      adsetName: data.adset.name,
      campaignId: data.campaign.id,
      campaignName: data.campaign.name,
    };
  }

  // ─── internals ─────────────────────────────────────────────────────

  private graphBase(): string {
    return `https://graph.facebook.com/${getMetaConfig().graphApiVersion}`;
  }

  private async loadUserToken(connectionId: string): Promise<{ token: string; tenantId: string }> {
    const row = await this.prisma.metaOAuthConnection.findUnique({
      where: { id: connectionId },
      select: { tenantId: true, accessToken: true, revokedAt: true, expiresAt: true },
    });
    if (!row) {
      throw new UnauthorizedException({
        code: 'meta.connection.not_found',
        message: `MetaOAuthConnection ${connectionId} not found`,
      });
    }
    if (row.revokedAt !== null) {
      throw new UnauthorizedException({
        code: 'meta.connection.revoked',
        message: 'Connection has been revoked',
      });
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException({
        code: 'meta.connection.expired',
        message: 'Long-lived token expired; the operator must re-authenticate',
      });
    }
    return { token: decryptSecret(row.accessToken), tenantId: row.tenantId };
  }

  private async loadPageToken(connectionId: string, pageId: string): Promise<string> {
    const pages = await this.getPages(connectionId);
    const match = pages.find((p) => p.id === pageId);
    if (!match) {
      throw new UnauthorizedException({
        code: 'meta.graph.page_access_denied',
        message: `Page ${pageId} is not accessible to this connection`,
      });
    }
    return match.accessToken;
  }

  private async getJson<T>(url: string, bearer: string): Promise<T> {
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bearer}` },
      });
    } catch (err) {
      this.logger.warn(`Graph GET network error: ${(err as Error).name}`);
      throw new BadGatewayException({
        code: 'meta.graph.network',
        message: 'Network error reaching Meta Graph API',
      });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(`Graph GET ${res.status}: ${detail.slice(0, 200)}`);
      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedException({
          code: 'meta.graph.unauthorized',
          message: 'Meta rejected the token (revoked or missing scope)',
        });
      }
      throw new BadGatewayException({
        code: 'meta.graph.http_error',
        message: `Meta Graph API returned HTTP ${res.status}`,
      });
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      this.logger.warn(`Graph GET JSON parse error: ${(err as Error).message}`);
      throw new BadGatewayException({
        code: 'meta.graph.parse',
        message: 'Meta Graph API returned an unparseable response',
      });
    }
  }
}
