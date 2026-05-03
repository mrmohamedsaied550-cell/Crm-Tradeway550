import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { buildAttribution, type AttributionInput } from '../crm/attribution.util';
import { LeadsService } from '../crm/leads.service';
import { normalizeE164WithDefault } from '../crm/phone.util';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { DEFAULT_STAGE_CODE, type LeadSource } from '../crm/pipeline.registry';
import { PipelineService } from '../crm/pipeline.service';
import { SlaService } from '../crm/sla.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId, tenantContext } from '../tenants/tenant-context';
import { CsvParseError, parseCsv } from './csv.util';
import type { CsvImportDto } from './ingestion.dto';

/**
 * P2-06 — bulk + single lead ingestion.
 *
 * Two callers:
 *   1. `POST /leads/import` (admin, JSON CSV body): `importCsv()` runs
 *      every row through the same service-level pipeline as the
 *      manual /leads endpoint — phone normalisation, duplicate check,
 *      SLA initialisation, activity write, optional round-robin
 *      auto-assign. The whole import runs inside one
 *      `withTenant` transaction so a partial failure rolls everything
 *      back; per-row errors are collected into the response envelope.
 *
 *   2. `POST /webhooks/meta/leadgen` (public): `ingestMetaPayload()`
 *      is invoked per parsed lead by the webhook controller. Each
 *      call opens its own tenant transaction (the route arrives
 *      tenant-less and the source row tells us which tenant to use).
 *      Auto-assign is always on for webhook leads.
 *
 * Per-row outcomes:
 *   - `created`:   freshly-inserted lead row.
 *   - `duplicate`: phone already exists in the tenant — counted and
 *                  skipped. Idempotent re-imports are by design.
 *   - `error`:     row was rejected (missing required fields,
 *                  malformed phone, etc.). The error message is
 *                  surfaced to the caller; the tx continues.
 */
@Injectable()
export class LeadIngestionService {
  private readonly logger = new Logger(LeadIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: PipelineService,
    /**
     * A5.5 — routing for ingested leads now goes through
     * LeadsService.autoAssign which delegates to DistributionService.
     * Source-based + company/country/team rules now apply to Meta
     * webhook + CSV-imported leads identically to manual creation.
     */
    private readonly leads: LeadsService,
    private readonly sla: SlaService,
    private readonly audit: AuditService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  // ───────────────────────────────────────────────────────────────────
  // CSV import (admin)
  // ───────────────────────────────────────────────────────────────────

  async importCsv(
    dto: CsvImportDto,
    actorUserId: string,
  ): Promise<{
    total: number;
    created: number;
    duplicates: number;
    errors: { row: number; reason: string }[];
  }> {
    const tenantId = requireTenantId();

    let parsed: ReturnType<typeof parseCsv>;
    try {
      parsed = parseCsv(dto.csv);
    } catch (err) {
      if (err instanceof CsvParseError) {
        throw new BadRequestException({
          code: 'lead.import.csv_invalid',
          message: err.message,
        });
      }
      throw err;
    }

    const { headers, rows } = parsed;
    const mapping = dto.mapping;

    // Validate every mapped header exists in the file (fail fast).
    const missing = (
      [
        ['name', mapping.name],
        ['phone', mapping.phone],
        ...(mapping.email ? ([['email', mapping.email]] as const) : []),
      ] as const
    ).filter(([, header]) => !headers.includes(header));
    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'lead.import.mapping_invalid',
        message: `CSV is missing column(s): ${missing.map(([, h]) => h).join(', ')}`,
      });
    }

    if (rows.length === 0) {
      return { total: 0, created: 0, duplicates: 0, errors: [] };
    }
    if (rows.length > 10_000) {
      throw new BadRequestException({
        code: 'lead.import.too_large',
        message: `CSV has ${rows.length} data rows; maximum is 10000`,
      });
    }

    const stage = await this.pipeline.findByCodeOrThrow(DEFAULT_STAGE_CODE);
    // Phase 1B — CSV import currently always lands on the tenant
    // default pipeline (no company/country mapping yet). Per-import
    // pipeline selection ships in a follow-up.
    const defaultPipelineId = await this.prisma.withTenant(tenantId, (tx) =>
      this.pipeline.findDefaultPipelineIdInTx(tx),
    );
    const settings = await this.tenantSettings.getCurrent();
    const errors: { row: number; reason: string }[] = [];
    let created = 0;
    let duplicates = 0;
    const createdLeadIds: string[] = [];

    await this.prisma.withTenant(tenantId, async (tx) => {
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i] as Record<string, string>;
        const lineNumber = i + 2; // header is line 1
        // Phase A — A4: build per-row attribution from the optional
        // mapping columns. Helper: look up `row[csvHeader]` and trim
        // — empty / missing values become undefined and are
        // dropped by buildAttribution.
        const cell = (header: string | undefined): string | undefined => {
          if (!header) return undefined;
          const v = (row[header] ?? '').trim();
          return v.length > 0 ? v : undefined;
        };
        const rowAttribution: AttributionInput = {
          subSource: 'csv_import',
          campaign:
            cell(mapping.campaignId) || cell(mapping.campaignName)
              ? { id: cell(mapping.campaignId), name: cell(mapping.campaignName) }
              : undefined,
          adSet:
            cell(mapping.adSetId) || cell(mapping.adSetName)
              ? { id: cell(mapping.adSetId), name: cell(mapping.adSetName) }
              : undefined,
          ad:
            cell(mapping.adId) || cell(mapping.adName)
              ? { id: cell(mapping.adId), name: cell(mapping.adName) }
              : undefined,
          utm: {
            source: cell(mapping.utmSource),
            medium: cell(mapping.utmMedium),
            campaign: cell(mapping.utmCampaign),
            term: cell(mapping.utmTerm),
            content: cell(mapping.utmContent),
          },
        };

        const result = await this.tryCreateLead(tx, {
          tenantId,
          pipelineId: defaultPipelineId,
          stageId: stage.id,
          stageIsTerminal: stage.isTerminal,
          name: (row[mapping.name] ?? '').trim(),
          phoneRaw: (row[mapping.phone] ?? '').trim(),
          email: mapping.email ? (row[mapping.email] ?? '').trim() || null : null,
          source: dto.defaultSource,
          actorUserId,
          defaultDialCode: settings.defaultDialCode,
          slaMinutes: settings.slaMinutes,
          attribution: rowAttribution,
        });
        if (result.kind === 'created') {
          created += 1;
          createdLeadIds.push(result.id);
        } else if (result.kind === 'duplicate') {
          duplicates += 1;
        } else {
          errors.push({ row: lineNumber, reason: result.reason });
        }
      }

      await this.audit.writeInTx(tx, tenantId, {
        action: 'lead.import.csv',
        entityType: 'lead_import',
        entityId: null,
        actorUserId,
        payload: {
          total: rows.length,
          created,
          duplicates,
          errors: errors.length,
          source: dto.defaultSource,
        } as Prisma.InputJsonValue,
      });
    });

    // Auto-assign happens AFTER the import tx commits so an SLA
    // breach scan that fires mid-import doesn't see half-baked rows.
    if (dto.autoAssign && createdLeadIds.length > 0) {
      for (const leadId of createdLeadIds) {
        await this.tryAutoAssign(tenantId, leadId, actorUserId);
      }
    }

    return { total: rows.length, created, duplicates, errors };
  }

  // ───────────────────────────────────────────────────────────────────
  // Meta webhook ingestion (per-lead)
  // ───────────────────────────────────────────────────────────────────

  /**
   * Ingest one lead arriving via the Meta lead-gen webhook. `tenantId`
   * is supplied by the caller after they routed the payload to a
   * `meta_lead_sources` row. Invariant: `defaultSource` is the
   * source-row's configured `defaultSource`, and field values have
   * already been mapped to `name` / `phone` / optional `email`.
   *
   * Returns one of `{ kind: 'created' | 'duplicate' | 'error', ... }`.
   */
  async ingestMetaPayload(input: {
    tenantId: string;
    name: string;
    phoneRaw: string;
    email?: string | null;
    source: LeadSource;
    actorUserId?: string | null;
    /**
     * Audit-log payload (leadgenId, pageId, formId, sourceId). Free-
     * form; written to `audit_events.payload`. Distinct from
     * `attribution` below — that one is structured + lands on the
     * lead row for distribution rules + reporting.
     */
    metadata?: Record<string, unknown>;
    /**
     * Phase A — A4: structured attribution forwarded to
     * `Lead.attribution`. The webhook controller assembles this
     * from the parsed Meta event (page_id, form_id, ad_id,
     * adgroup_id, leadgen_id) so distribution rules can reach
     * `attribution.campaign.id` etc. without parsing the raw
     * audit payload.
     */
    attribution?: AttributionInput | null;
  }): Promise<
    { kind: 'created'; id: string } | { kind: 'duplicate' } | { kind: 'error'; reason: string }
  > {
    const result = await this.prisma.withTenant(input.tenantId, async (tx) => {
      // Read the default stage inside this transaction — the webhook
      // path arrives WITHOUT tenant context, so the standard
      // `pipeline.findByCodeOrThrow` (which calls `requireTenantId`)
      // would throw. The withTenant helper has already set the GUC,
      // so an unscoped Prisma read is RLS-safe here.
      //
      // P2-07 — stages live under a Pipeline now. Walk: tenant →
      // default pipeline → stage by code.
      const defaultPipeline = await tx.pipeline.findFirst({
        where: { tenantId: input.tenantId, isDefault: true },
        select: { id: true },
      });
      if (!defaultPipeline) {
        return {
          kind: 'error' as const,
          reason: `tenant has no default pipeline`,
        };
      }
      const stage = await tx.pipelineStage.findUnique({
        where: {
          pipelineId_code: { pipelineId: defaultPipeline.id, code: DEFAULT_STAGE_CODE },
        },
        select: { id: true, isTerminal: true },
      });
      if (!stage) {
        return {
          kind: 'error' as const,
          reason: `default pipeline stage "${DEFAULT_STAGE_CODE}" missing`,
        };
      }
      // P2-08 — read tenant settings inside this same tx (the
      // webhook path has no upstream tenant context).
      const settings = await this.tenantSettings.getInTx(tx, input.tenantId);

      const r = await this.tryCreateLead(tx, {
        tenantId: input.tenantId,
        // Phase 1B — webhook ingest also lands on the tenant default
        // until per-source mapping (Track B) lets a Meta source bind
        // to a specific (company, country) → pipeline tuple.
        pipelineId: defaultPipeline.id,
        stageId: stage.id,
        stageIsTerminal: stage.isTerminal,
        defaultDialCode: settings.defaultDialCode,
        slaMinutes: settings.slaMinutes,
        name: input.name.trim(),
        phoneRaw: input.phoneRaw.trim(),
        email: input.email ? input.email.trim() || null : null,
        source: input.source,
        actorUserId: input.actorUserId ?? null,
        // Phase A — A4: structured attribution from the Meta event.
        attribution: input.attribution ?? null,
      });
      await this.audit.writeInTx(tx, input.tenantId, {
        action: r.kind === 'created' ? 'lead.ingest.meta' : `lead.ingest.meta.${r.kind}`,
        entityType: 'lead',
        entityId: r.kind === 'created' ? r.id : null,
        actorUserId: input.actorUserId ?? null,
        payload: {
          source: input.source,
          ...(r.kind === 'error' && { reason: r.reason }),
          ...(input.metadata && { metadata: input.metadata }),
        } as Prisma.InputJsonValue,
      });
      return r;
    });

    // Auto-assign outside the ingest tx so the round-robin counter
    // commit doesn't lock the lead create row.
    if (result.kind === 'created') {
      await this.tryAutoAssign(input.tenantId, result.id, input.actorUserId ?? null);
    }

    return result;
  }

  // ───────────────────────────────────────────────────────────────────
  // shared per-row create
  // ───────────────────────────────────────────────────────────────────

  private async tryCreateLead(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      /**
       * Phase 1B — denormalised pipeline id; persisted on the lead so
       * Kanban + reporting can filter without joining stages. Always
       * equals the parent of `stageId`.
       */
      pipelineId: string;
      stageId: string;
      stageIsTerminal: boolean;
      name: string;
      phoneRaw: string;
      email: string | null;
      source: LeadSource;
      actorUserId: string | null;
      defaultDialCode: string;
      slaMinutes: number;
      /**
       * Phase A — A4: optional rich attribution payload. The helper
       * `buildAttribution` is invoked here so callers can pass a
       * partial input (sub-source, campaign, ad, utm) without
       * repeating the source-mirroring logic.
       */
      attribution?: AttributionInput | null;
    },
  ): Promise<
    { kind: 'created'; id: string } | { kind: 'duplicate' } | { kind: 'error'; reason: string }
  > {
    if (input.name.length === 0) {
      return { kind: 'error', reason: 'missing name' };
    }
    if (input.phoneRaw.length === 0) {
      return { kind: 'error', reason: 'missing phone' };
    }

    let phone: string;
    try {
      // P2-08 — bare local-format phones get the tenant's default
      // dial code prepended. CSV uploads from Egyptian operators
      // routinely paste numbers as "01001234567"; we don't want to
      // reject those.
      phone = normalizeE164WithDefault(input.phoneRaw, input.defaultDialCode);
    } catch (err) {
      return { kind: 'error', reason: `invalid phone: ${(err as Error).message}` };
    }

    if (input.email !== null && input.email.length > 0) {
      const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email);
      if (!looksLikeEmail) {
        return { kind: 'error', reason: `invalid email: ${input.email}` };
      }
    }

    // Pre-check by (tenant, phone) — same idempotency strategy as the
    // bonus engine. We avoid try/catch on P2002 because a unique
    // violation aborts the surrounding transaction (Postgres state
    // 25P02), which would block every subsequent row in a CSV import.
    const existing = await tx.lead.findFirst({
      where: { tenantId: input.tenantId, phone },
      select: { id: true },
    });
    if (existing) {
      return { kind: 'duplicate' };
    }

    const now = new Date();
    const slaDueAt = input.stageIsTerminal ? null : this.sla.computeDueAt(now, input.slaMinutes);
    const slaStatus = input.stageIsTerminal ? 'paused' : 'active';

    // Phase A — A4: build the JSONB attribution payload from the
    // ingest-side flat source + the optional rich payload (Meta
    // campaign/ad ids, CSV-mapped UTM fields). Always non-null
    // post-A4 so reports can rely on it.
    const attribution = buildAttribution(input.source, input.attribution ?? null);

    const lead = await tx.lead.create({
      data: {
        tenantId: input.tenantId,
        name: input.name,
        phone,
        email: input.email,
        source: input.source,
        attribution: attribution as unknown as Prisma.InputJsonValue,
        // Phase 1B — populate the denormalised pipeline pointer so
        // ingested leads participate in Kanban + reporting from day
        // one. company/country stay NULL until per-source mapping
        // ships in a follow-up (Track B).
        pipelineId: input.pipelineId,
        stageId: input.stageId,
        assignedToId: null,
        createdById: input.actorUserId,
        slaDueAt,
        slaStatus,
      },
      select: { id: true },
    });
    await tx.leadActivity.create({
      data: {
        tenantId: input.tenantId,
        leadId: lead.id,
        type: 'system',
        body: `Lead ingested via ${input.source}`,
        payload: { event: 'created', stageCode: DEFAULT_STAGE_CODE, source: input.source },
        createdById: input.actorUserId,
      },
    });
    return { kind: 'created', id: lead.id };
  }

  /**
   * Best-effort auto-assign — failures are logged and swallowed.
   *
   * A5.5 cutover: routing for ingested leads (CSV import + Meta
   * webhook) now goes through LeadsService.autoAssign which
   * delegates to DistributionService.route(). That means:
   *
   *   - Source / company / country / team rules apply to ingested
   *     leads identically to manual /auto-assign — closing the
   *     PL-3-era gap where ingestion bypassed the rule lookup.
   *   - A `lead_routing_logs` row is written for every ingest
   *     auto-assign attempt (including no-eligible cases).
   *   - The activity payload carries the strategy that fired
   *     (specific_user / round_robin / weighted / capacity) plus
   *     the matched ruleId.
   *
   * The Meta webhook is unauthenticated and runs without an
   * AsyncLocalStorage tenant context (the routing row lookup is the
   * only "tenant resolution" the request gets). LeadsService.autoAssign
   * uses requireTenantId() internally, so we wrap the call in
   * tenantContext.run to set the scope synthetically. This is the
   * same pattern lead.test.ts uses; it's safe to nest if the
   * caller already has context (the inner scope wins).
   */
  private async tryAutoAssign(
    tenantId: string,
    leadId: string,
    actorUserId: string | null,
  ): Promise<void> {
    try {
      await tenantContext.run(
        // tenantCode is synthetic — autoAssign + DistributionService
        // only consume tenantId from the context; tenantCode is here
        // to satisfy the type contract.
        { tenantId, tenantCode: '__ingest__', source: 'header' },
        async () => {
          await this.leads.autoAssign(leadId, actorUserId);
        },
      );
    } catch (err) {
      // Not fatal — the lead exists, an admin can assign manually.
      this.logger.warn(
        `auto-assign on ingest failed for lead ${leadId}: ${(err as Error).message}`,
      );
    }
  }
}
