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
import { LeadIngestionService } from './lead-ingestion.service';
import { MetaLeadSourcesService } from './meta-lead-sources.service';

/**
 * /api/v1/webhooks/meta/leadgen (P2-06) — public Meta Lead Ads webhook.
 *
 * INTENTIONALLY PUBLIC: no JwtAuthGuard, no tenant header. Meta's
 * platform delivers lead-gen events here. We:
 *   1. GET handshake — match the presented verify token to a
 *      `meta_lead_sources` row and echo `hub.challenge`.
 *   2. POST inbound — match the payload's `page_id` (+ optional
 *      `form_id`) to a `meta_lead_sources` row, verify the HMAC
 *      signature against the source's `app_secret`, then for each
 *      lead in the payload run the `field_mapping` against the
 *      delivered `field_data`, hand the mapped values to
 *      `LeadIngestionService.ingestMetaPayload`, and tally the
 *      result. Production requires every source row to have an
 *      `app_secret` set; dev / test allow unsigned payloads.
 *
 * Per Meta's docs the verbose webhook delivers `field_data` inline
 * (when Lead Notification's "include_form_data" is enabled). In the
 * absence of that flag the webhook only carries `leadgen_id` and
 * we'd need a Page access token to fetch the form from the Graph
 * API — that fetcher is out of scope for P2-06; rows without
 * `field_data` are reported as `errors` in the response envelope so
 * operators can spot the misconfiguration.
 */
@ApiTags('crm')
@Controller('webhooks/meta/leadgen')
export class MetaLeadgenController {
  private readonly logger = new Logger(MetaLeadgenController.name);

  constructor(
    private readonly sources: MetaLeadSourcesService,
    private readonly ingestion: LeadIngestionService,
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

      if (!verifyMetaSignature(raw, signature, source.appSecret, requireSigned)) {
        throw new BadRequestException({
          code: 'meta.leadgen.invalid_signature',
          message: 'Webhook signature does not match',
        });
      }

      const mapping = source.fieldMapping as Record<string, string>;
      const defaultSource = isLeadSource(source.defaultSource) ? source.defaultSource : 'meta';

      for (const ev of group.events) {
        if (!ev.fieldData) {
          // Ingest endpoint requires field_data inline (verbose mode).
          // Without it we'd have to fetch from Graph API — out of scope.
          this.logger.warn(
            `meta leadgen event ${ev.leadgenId ?? '∅'} dropped: no field_data (verbose mode disabled?)`,
          );
          errors += 1;
          continue;
        }

        const mapped = applyMapping(ev.fieldData, mapping);
        const result = await this.ingestion.ingestMetaPayload({
          tenantId: source.tenantId,
          name: mapped.name ?? '',
          phoneRaw: mapped.phone ?? '',
          email: mapped.email ?? null,
          source: defaultSource,
          actorUserId: null,
          metadata: {
            leadgenId: ev.leadgenId,
            pageId: ev.pageId,
            formId: ev.formId,
            sourceId: source.id,
          },
          // Phase A — A4: structured attribution. `pageId` lands on
          // `subSource` so distribution rules can later filter by
          // page (e.g. "leads from this page → that team"). The
          // ad_id and adgroup_id from Meta map to attribution.ad
          // and attribution.adSet respectively.
          attribution: {
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
        });
        if (result.kind === 'created') ingested += 1;
        else if (result.kind === 'duplicate') duplicates += 1;
        else errors += 1;
      }
    }

    return { ok: true, ingested, duplicates, errors };
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
   * the standard webhook envelope — it must be looked up via Graph
   * API later if needed; null today.
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
      // Phase A — A4: campaign-level ids. Meta sends `ad_id` and
      // `adgroup_id` (= ad set) on the leadgen value object. Both
      // optional; missing on organic / non-ads forms. `campaign_id`
      // is NOT in the webhook envelope — null until a Graph API
      // lookup ships in a follow-up.
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

/**
 * Apply a `field_mapping` JSON object against the parsed `field_data`.
 * Returns an object keyed by the CRM field names (`name`, `phone`,
 * `email`, ...). Missing source fields → undefined; multi-value fields
 * (Meta returns `values: [...]`) take the first value.
 */
function applyMapping(
  fieldData: { name: string; values: string[] }[],
  mapping: Record<string, string>,
): Record<string, string | undefined> {
  const incoming: Record<string, string> = {};
  for (const f of fieldData) {
    if (f.values.length > 0 && typeof f.values[0] === 'string') {
      incoming[f.name] = f.values[0] ?? '';
    }
  }
  const out: Record<string, string | undefined> = {};
  for (const [src, dst] of Object.entries(mapping)) {
    const v = incoming[src];
    if (typeof v === 'string' && v.length > 0) {
      out[dst] = v;
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
