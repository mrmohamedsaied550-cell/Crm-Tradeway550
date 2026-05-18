import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

import { isProduction } from '../common/env';
import { LEAD_SOURCES, type LeadSource } from '../crm/pipeline.registry';
import {
  applyMappingV2,
  normaliseFieldMapping,
  type AppliedMapping,
} from '../meta/meta-field-mapping.helper';
import type { MetaFieldMappingV2 } from '../meta/meta-field-mapping.types';
import { MetaGraphService } from '../meta/meta-graph.service';
import { getMetaConfig } from '../meta/meta.config';
import { LeadIngestionService } from './lead-ingestion.service';
import { MetaLeadSourcesService } from './meta-lead-sources.service';

/**
 * /api/v1/webhooks/meta/leadgen (P2-06 + Sprint M2) — public Meta
 * Lead Ads webhook.
 *
 * INTENTIONALLY PUBLIC: no JwtAuthGuard, no tenant header. Meta's
 * platform delivers lead-gen events here. We:
 *   1. GET handshake — match the presented verify token to a
 *      `meta_lead_sources` row and echo `hub.challenge`.
 *   2. POST inbound — match the payload's `page_id` (+ optional
 *      `form_id`) to a `meta_lead_sources` row, verify the HMAC
 *      signature against the source's `app_secret` (or, when the row
 *      has no per-source secret, the `META_APP_SECRET` env fallback),
 *      then for each lead in the payload either
 *        a) fetch the lead via Graph API when the source carries an
 *           `oauth_connection_id` (Sprint M2 path), enriching with
 *           campaign / ad-set / ad names, or
 *        b) consume the inline `field_data` from the verbose webhook
 *           payload (legacy P2-06 path),
 *      apply the V2-normalised `field_mapping`, and hand the mapped
 *      values to `LeadIngestionService.ingestMetaPayload`. Production
 *      requires every signature path to have at least one secret
 *      (per-source or env) — dev/test allow unsigned payloads.
 *
 * The V1/V2 mapping split is invisible to operators: rows still on
 * the legacy flat `{ metaKey: leadField }` shape go through
 * `normaliseFieldMapping` and behave identically to V2 rows.
 */
@ApiTags('crm')
@Controller('webhooks/meta/leadgen')
export class MetaLeadgenController {
  private readonly logger = new Logger(MetaLeadgenController.name);

  constructor(
    private readonly sources: MetaLeadSourcesService,
    private readonly ingestion: LeadIngestionService,
    private readonly graph: MetaGraphService,
  ) {}

  // ─── GET handshake ───

  @Get()
  @ApiOperation({ summary: 'Meta lead-gen webhook GET handshake' })
  async verify(@Query() query: Record<string, string | undefined>): Promise<string> {
    if (query['hub.mode'] !== 'subscribe') {
      throw new BadRequestException({
        code: 'meta.leadgen.invalid_verify',
        message: 'hub.mode must be subscribe',
      });
    }
    const presented = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (typeof presented !== 'string' || presented.length === 0) {
      throw new BadRequestException({
        code: 'meta.leadgen.invalid_verify',
        message: 'Missing hub.verify_token',
      });
    }
    if (typeof challenge !== 'string' || challenge.length === 0) {
      throw new BadRequestException({
        code: 'meta.leadgen.invalid_verify',
        message: 'Missing hub.challenge',
      });
    }

    const source = await this.sources.findRoutingByVerifyToken(presented);
    if (!source) {
      throw new BadRequestException({
        code: 'meta.leadgen.invalid_verify',
        message: 'Verify token does not match any active Meta lead source',
      });
    }
    return challenge;
  }

  // ─── POST inbound ───

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Meta lead-gen webhook POST inbound' })
  async inbound(
    @Body() body: unknown,
    @Req() req: Request & { rawBody?: Buffer | undefined },
  ): Promise<{ ok: true; ingested: number; duplicates: number; errors: number }> {
    const events = parseLeadgenEvents(body);
    if (events.length === 0) {
      return { ok: true, ingested: 0, duplicates: 0, errors: 0 };
    }

    // Group events by (pageId, formId ?? null) so we do exactly one
    // routing lookup + one signature check per source.
    const groups = new Map<
      string,
      { pageId: string; formId: string | null; events: LeadgenEvent[] }
    >();
    for (const ev of events) {
      const key = `${ev.pageId}::${ev.formId ?? ''}`;
      const g = groups.get(key);
      if (g) g.events.push(ev);
      else groups.set(key, { pageId: ev.pageId, formId: ev.formId, events: [ev] });
    }

    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(body);
    const signature = req.header('x-hub-signature-256') ?? undefined;
    const requireSigned = isProduction();
    const envAppSecret = getMetaConfig().appSecret;

    let ingested = 0;
    let duplicates = 0;
    let errors = 0;

    for (const group of groups.values()) {
      const source = await this.sources.findRoutingByPageId(group.pageId, group.formId);
      if (!source) {
        // No active source registered for this page — skip with a warn.
        // We don't 4xx because Meta will retry, and a 4xx here would
        // create indefinite retries for a page we don't own.
        this.logger.warn(
          `meta leadgen for unknown page ${group.pageId} (form ${group.formId ?? '∅'})`,
        );
        errors += group.events.length;
        continue;
      }

      // Sprint M2 — signature secret resolution: per-source override
      // first (back-compat with hand-configured webhooks from P2-06),
      // env fallback otherwise (`META_APP_SECRET`).
      const effectiveSecret =
        source.appSecret !== null && source.appSecret.length > 0
          ? source.appSecret
          : envAppSecret.length > 0
            ? envAppSecret
            : null;

      if (!verifyMetaSignature(raw, signature, effectiveSecret, requireSigned)) {
        throw new BadRequestException({
          code: 'meta.leadgen.invalid_signature',
          message: 'Webhook signature does not match',
        });
      }

      const mappingV2 = normaliseFieldMapping(source.fieldMapping);
      const defaultSource = isLeadSource(source.defaultSource) ? source.defaultSource : 'meta';
      const useOAuthPath =
        typeof source.oauthConnectionId === 'string' && source.oauthConnectionId.length > 0;

      for (const ev of group.events) {
        try {
          const outcome = useOAuthPath
            ? await this.processViaGraph({
                ev,
                source,
                mappingV2,
                defaultSource,
                connectionId: source.oauthConnectionId as string,
              })
            : await this.processInline({ ev, source, mappingV2, defaultSource });

          if (outcome === 'created') ingested += 1;
          else if (outcome === 'duplicate') duplicates += 1;
          else errors += 1;
        } catch (err) {
          // Per-event Graph / ingest failures must not abort the batch
          // — Meta would retry the whole envelope and re-ingest the
          // ones that succeeded. Log and count as error so the
          // response envelope stays accurate.
          this.logger.warn(
            `meta leadgen event ${ev.leadgenId ?? '∅'} failed: ${(err as Error).message}`,
          );
          errors += 1;
        }
      }
    }

    return { ok: true, ingested, duplicates, errors };
  }

  // ─── per-event paths ────────────────────────────────────────────────

  /**
   * Sprint M2 OAuth path — fetches the lead via Graph (authoritative
   * `field_data`) and the ad → ad-set → campaign names so the lead
   * row can persist the six flat attribution columns alongside the
   * existing `attribution` JSON.
   */
  private async processViaGraph(input: {
    ev: LeadgenEvent;
    source: SourceRow;
    mappingV2: MetaFieldMappingV2;
    defaultSource: LeadSource;
    connectionId: string;
  }): Promise<'created' | 'duplicate' | 'error'> {
    const { ev, source, mappingV2, defaultSource, connectionId } = input;

    if (!ev.leadgenId) {
      this.logger.warn(`meta leadgen OAuth-path event dropped: no leadgen_id (page ${ev.pageId})`);
      return 'error';
    }

    const leadData = await this.graph.getLeadData(connectionId, ev.leadgenId, ev.pageId);
    const adId = leadData.adId ?? ev.adId ?? null;
    const attribution =
      adId !== null ? await this.graph.getAttributionNames(connectionId, adId) : null;

    const applied = applyMappingV2(leadData.fieldData, mappingV2);
    return this.dispatch({
      ev,
      source,
      defaultSource,
      applied,
      attributionPayload: {
        subSource: 'meta_lead_form',
        ...(attribution
          ? {
              campaign: { id: attribution.campaignId, name: attribution.campaignName },
              adSet: { id: attribution.adsetId, name: attribution.adsetName },
              ad: { id: attribution.adId, name: attribution.adName },
            }
          : {
              ...(ev.campaignId && { campaign: { id: ev.campaignId } }),
              ...(ev.adgroupId && { adSet: { id: ev.adgroupId } }),
              ...(adId && { ad: { id: adId } }),
            }),
        ...((ev.pageId || ev.formId || ev.leadgenId) && {
          custom: {
            ...(ev.pageId && { pageId: ev.pageId }),
            ...(ev.formId && { formId: ev.formId }),
            ...(ev.leadgenId && { leadgenId: ev.leadgenId }),
          },
        }),
      },
      metaAttribution: attribution
        ? {
            campaignId: attribution.campaignId,
            campaignName: attribution.campaignName,
            adsetId: attribution.adsetId,
            adsetName: attribution.adsetName,
            adId: attribution.adId,
            adName: attribution.adName,
          }
        : null,
    });
  }

  /**
   * Legacy P2-06 inline path — the webhook delivers `field_data`
   * when Lead Notification's "include_form_data" is on. Used when
   * the source has no OAuth connection. No Graph calls; attribution
   * stays at id-only inside the JSON column (no flat-column names).
   */
  private async processInline(input: {
    ev: LeadgenEvent;
    source: SourceRow;
    mappingV2: MetaFieldMappingV2;
    defaultSource: LeadSource;
  }): Promise<'created' | 'duplicate' | 'error'> {
    const { ev, source, mappingV2, defaultSource } = input;
    if (!ev.fieldData) {
      this.logger.warn(
        `meta leadgen inline-path event ${ev.leadgenId ?? '∅'} dropped: no field_data (verbose mode disabled?)`,
      );
      return 'error';
    }
    const applied = applyMappingV2(ev.fieldData, mappingV2);
    return this.dispatch({
      ev,
      source,
      defaultSource,
      applied,
      attributionPayload: {
        subSource: 'meta_lead_form',
        ...(ev.campaignId && { campaign: { id: ev.campaignId } }),
        ...(ev.adgroupId && { adSet: { id: ev.adgroupId } }),
        ...(ev.adId && { ad: { id: ev.adId } }),
        ...((ev.pageId || ev.formId || ev.leadgenId) && {
          custom: {
            ...(ev.pageId && { pageId: ev.pageId }),
            ...(ev.formId && { formId: ev.formId }),
            ...(ev.leadgenId && { leadgenId: ev.leadgenId }),
          },
        }),
      },
      metaAttribution: null,
    });
  }

  private async dispatch(input: {
    ev: LeadgenEvent;
    source: SourceRow;
    defaultSource: LeadSource;
    applied: AppliedMapping;
    attributionPayload: Record<string, unknown>;
    metaAttribution: {
      campaignId: string;
      campaignName: string;
      adsetId: string;
      adsetName: string;
      adId: string;
      adName: string;
    } | null;
  }): Promise<'created' | 'duplicate' | 'error'> {
    const { ev, source, defaultSource, applied, attributionPayload, metaAttribution } = input;
    const result = await this.ingestion.ingestMetaPayload({
      tenantId: source.tenantId,
      name: applied.leadFields.name ?? '',
      phoneRaw: applied.leadFields.phone ?? '',
      email: applied.leadFields.email ?? null,
      source: defaultSource,
      actorUserId: null,
      metadata: {
        leadgenId: ev.leadgenId,
        pageId: ev.pageId,
        formId: ev.formId,
        sourceId: source.id,
        ...(source.oauthConnectionId && { oauthConnectionId: source.oauthConnectionId }),
      },
      attribution: attributionPayload as AttributionForwardingShape,
      metaAttribution,
    });
    if (result.kind === 'created' || result.kind === 'reactivated') return 'created';
    if (result.kind === 'duplicate') return 'duplicate';
    return 'error';
  }
}

// ───────────────────────────────────────────────────────────────────
// Payload parsing helpers
// ───────────────────────────────────────────────────────────────────

interface LeadgenEvent {
  pageId: string;
  formId: string | null;
  leadgenId: string | null;
  /**
   * Phase A — A4: campaign-level identifiers from the Meta payload.
   * `ad_id` and `adgroup_id` (Meta's term for ad-set) are populated
   * by Meta on every lead-gen event. `campaign_id` is not part of
   * the standard webhook envelope — when the source has an OAuth
   * connection we call Graph to resolve it (Sprint M2); without a
   * connection it stays null.
   */
  adId: string | null;
  adgroupId: string | null;
  campaignId: string | null;
  fieldData: { name: string; values: string[] }[] | null;
}

/**
 * Walk a Meta webhook payload and emit one LeadgenEvent per
 * `entry[].changes[]` whose `field === 'leadgen'`. Tolerates
 * malformed inputs by silently skipping unrecognised shapes.
 */
function parseLeadgenEvents(body: unknown): LeadgenEvent[] {
  if (!isRecord(body)) return [];
  if (body['object'] !== 'page') {
    // Lead-gen webhooks always carry object="page"; anything else is
    // a different subscription that should not have hit this URL.
    return [];
  }
  const entries = body['entry'];
  if (!Array.isArray(entries)) return [];

  const out: LeadgenEvent[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const changes = entry['changes'];
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      if (!isRecord(change)) continue;
      if (change['field'] !== 'leadgen') continue;
      const value = change['value'];
      if (!isRecord(value)) continue;

      const pageId = stringOrNull(value['page_id']);
      const formId = stringOrNull(value['form_id']);
      const leadgenId = stringOrNull(value['leadgen_id']);
      const adId = stringOrNull(value['ad_id']);
      const adgroupId = stringOrNull(value['adgroup_id']);
      const campaignId = stringOrNull(value['campaign_id']);
      if (!pageId) continue;

      let fieldData: { name: string; values: string[] }[] | null = null;
      const fdRaw = value['field_data'];
      if (Array.isArray(fdRaw)) {
        fieldData = [];
        for (const f of fdRaw) {
          if (!isRecord(f)) continue;
          const name = stringOrNull(f['name']);
          if (!name) continue;
          const valuesRaw = f['values'];
          const values: string[] = Array.isArray(valuesRaw)
            ? valuesRaw.filter((v): v is string => typeof v === 'string')
            : [];
          fieldData.push({ name, values });
        }
      }

      out.push({ pageId, formId, leadgenId, adId, adgroupId, campaignId, fieldData });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────
// HMAC signature verification (mirrors MetaCloudProvider.verifySignature)
// ───────────────────────────────────────────────────────────────────

function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string | null,
  requireSigned: boolean,
): boolean {
  if (appSecret === null || appSecret.length === 0) return !requireSigned;
  if (!signatureHeader) return false;

  const presented = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  if (!/^[0-9a-f]+$/iu.test(presented)) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (presented.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────
// tiny helpers
// ───────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function isLeadSource(v: unknown): v is LeadSource {
  return typeof v === 'string' && (LEAD_SOURCES as readonly string[]).includes(v);
}

// ───────────────────────────────────────────────────────────────────
// Local types
// ───────────────────────────────────────────────────────────────────

/** Shape returned by `MetaLeadSourcesService.findRoutingByPageId`. */
type SourceRow = {
  id: string;
  tenantId: string;
  appSecret: string | null;
  defaultSource: string;
  fieldMapping: unknown;
  oauthConnectionId: string | null;
};

/**
 * Loose forwarding shape for `LeadIngestionService.ingestMetaPayload`'s
 * `attribution` parameter — it accepts a structured `AttributionInput`
 * but the controller's payload is assembled dynamically from optional
 * keys, so this widens the type without re-exporting it.
 */
type AttributionForwardingShape = Parameters<
  LeadIngestionService['ingestMetaPayload']
>[0]['attribution'];
