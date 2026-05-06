/**
 * Phase D5 — D5.6C: governance wiring on the reports CSV export.
 *
 * Three layers of assertions:
 *
 *   A. Decorator wiring — @RequireCapability + @ExportGate metadata
 *      on `ReportsController.exportCsv` with the right primary
 *      resource, inherits, format, and capability code.
 *
 *   B. Catalogue extension — every report.* field added in D5.6C
 *      is registered, and the activations / conversionRate
 *      entries are flagged sensitive (commercial governance).
 *
 *   C. End-to-end via the ExportInterceptor — golden-file byte
 *      equality (flag off + flag on with no deny rules), key-level
 *      redaction (deny `summary.activations` drops the matching
 *      row + nothing else), group redaction (deny `stageBuckets`
 *      drops every `stage,*` row), super-admin bypass + audit row
 *      still fires, audit payload carries metric-key metadata not
 *      raw values, csv-keyvalue ID-style fields cannot be
 *      stripped (the section/key/value columns are
 *      `redactable: false`).
 *
 * Pure unit tests — no Postgres.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, type Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

import { ReportsController } from '../reports/reports.controller';

import { CAPABILITY_DEFINITIONS } from './capabilities.registry';
import { FIELD_CATALOGUE } from './field-catalogue.registry';
import { REDACTION_FIELD_KEY, type StructuredExport } from './export-contract';
import { ExportAuditService } from './export-audit.service';
import { ExportInterceptor } from './export.interceptor';
import { ExportRedactionService } from './export-redaction.service';
import { EXPORT_GATE_KEY } from './export-gate.decorator';
import { CAPABILITY_KEY } from './require-capability.decorator';
import { PermissionResolverService, type ResolvedPermissions } from './permission-resolver.service';

// ─── helpers ──────────────────────────────────────────────────────

function metaOn(method: unknown, key: string): unknown {
  if (typeof method !== 'function') return undefined;
  return Reflect.getMetadata(key, method);
}

function bundle(opts: {
  code?: string;
  deniedRead?: Record<string, readonly string[]>;
}): ResolvedPermissions {
  return {
    tenantId: 't1',
    userId: 'u1',
    role: {
      id: 'r1',
      code: opts.code ?? 'tl_sales',
      level: 60,
      isSystem: true,
      versionTag: 0,
    },
    capabilities: [],
    scopesByResource: {},
    deniedReadFieldsByResource: opts.deniedRead ?? {},
    deniedWriteFieldsByResource: {},
    userScopes: { companyIds: [], countryIds: [] },
    servedFromCache: false,
  };
}

function makeResolver(b: ResolvedPermissions): PermissionResolverService {
  return { resolveForUser: async () => b } as unknown as PermissionResolverService;
}

class FakeAuditService extends ExportAuditService {
  public calls: Parameters<ExportAuditService['recordExport']>[0][] = [];
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super({} as any);
  }
  override async recordExport(input: Parameters<ExportAuditService['recordExport']>[0]) {
    this.calls.push(input);
    return { entityId: 'audit-id-d5-6c' };
  }
}

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  } as unknown as { setHeader: (n: string, v: string) => void };
  return { res, headers };
}

function makeCtx(opts: {
  req: unknown;
  res?: unknown;
  metadata: { gate: unknown };
}): ExecutionContext {
  const handler = function fakeHandler() {
    /* placeholder */
  };
  Reflect.defineMetadata(EXPORT_GATE_KEY, opts.metadata.gate, handler);
  return {
    switchToHttp: () => ({
      getRequest: () => opts.req,
      getResponse: () => opts.res ?? makeRes().res,
    }),
    getHandler: () => handler,
    getClass: () =>
      class Anon {
        /* placeholder class */
      },
  } as unknown as ExecutionContext;
}

function handlerOf<T>(value: T): CallHandler<T> {
  return { handle: (): Observable<T> => of(value) };
}

const USER = { typ: 'access' as const, sub: 'u1', tid: 't1', rid: 'r1' };

const ORIGINAL_FLAG = process.env['D5_DYNAMIC_PERMISSIONS_V1'];
function setFlag(value: 'true' | 'false' | undefined): void {
  if (value === undefined) delete process.env['D5_DYNAMIC_PERMISSIONS_V1'];
  else process.env['D5_DYNAMIC_PERMISSIONS_V1'] = value;
}

/**
 * Build a deterministic reports csv-keyvalue StructuredExport for
 * tests — mirrors the shape `ReportsService.buildStructuredExport`
 * produces, but with stable comments + values so byte-equality
 * tests have a fixed target.
 */
function reportsStructured(): StructuredExport {
  return {
    format: 'csv-keyvalue',
    filename: 'crm-report-2026-05-06.csv',
    comments: [
      '# Trade Way / Captain Masr CRM — report export',
      '# generated_at,2026-05-06T00:00:00.000Z',
      '# from,2026-04-01',
      '# to,2026-04-30',
      '# companyId,',
      '# countryId,',
      '# teamId,',
      '',
    ],
    columns: [
      { key: 'section', label: 'section', resource: 'report', field: '_meta', redactable: false },
      { key: 'key', label: 'key', resource: 'report', field: '_meta', redactable: false },
      { key: 'value', label: 'value', resource: 'report', field: '_meta', redactable: false },
    ],
    rows: [
      {
        section: 'summary',
        key: 'total_leads',
        value: 142,
        [REDACTION_FIELD_KEY]: 'summary.totalLeads',
      },
      { section: 'summary', key: 'overdue', value: 5, [REDACTION_FIELD_KEY]: 'summary.overdue' },
      {
        section: 'summary',
        key: 'due_today',
        value: 12,
        [REDACTION_FIELD_KEY]: 'summary.dueToday',
      },
      {
        section: 'summary',
        key: 'followups_pending',
        value: 8,
        [REDACTION_FIELD_KEY]: 'summary.followupsPending',
      },
      {
        section: 'summary',
        key: 'followups_done',
        value: 19,
        [REDACTION_FIELD_KEY]: 'summary.followupsDone',
      },
      {
        section: 'summary',
        key: 'activations',
        value: 7,
        [REDACTION_FIELD_KEY]: 'summary.activations',
      },
      {
        section: 'summary',
        key: 'conversion_rate',
        value: '0.45',
        [REDACTION_FIELD_KEY]: 'summary.conversionRate',
      },
      { section: 'stage', key: 'new', value: 42, [REDACTION_FIELD_KEY]: 'stageBuckets' },
      { section: 'stage', key: 'contacted', value: 28, [REDACTION_FIELD_KEY]: 'stageBuckets' },
      {
        section: 'leads_created',
        key: '2026-04-01',
        value: 5,
        [REDACTION_FIELD_KEY]: 'leadsCreatedTimeseries',
      },
      {
        section: 'leads_created',
        key: '2026-04-02',
        value: 8,
        [REDACTION_FIELD_KEY]: 'leadsCreatedTimeseries',
      },
    ],
    trailingNewline: true,
  };
}

// ════════════════════════════════════════════════════════════════
// A. Decorator wiring + capability registration
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6C — decorator wiring on /reports/export.csv', () => {
  it('ReportsController.exportCsv carries report.export cap + @ExportGate(report)', () => {
    const proto = ReportsController.prototype as unknown as Record<string, unknown>;
    const m = proto['exportCsv'];

    const requiredCaps = metaOn(m, CAPABILITY_KEY) as readonly string[] | undefined;
    assert.deepEqual(requiredCaps, ['report.export']);

    const gate = metaOn(m, EXPORT_GATE_KEY) as
      | { primary: string; inherits: readonly string[]; format: string; filename: unknown }
      | undefined;
    assert.ok(gate);
    assert.equal(gate!.primary, 'report');
    assert.deepEqual([...gate!.inherits].sort(), ['captain', 'followup', 'lead']);
    assert.equal(gate!.format, 'csv-keyvalue');
    assert.equal(typeof gate!.filename, 'function');
  });

  it('JSON read endpoints (summary, timeseries) keep report.read cap (no separation regression)', () => {
    const proto = ReportsController.prototype as unknown as Record<string, unknown>;
    const summaryCaps = metaOn(proto['summary'], CAPABILITY_KEY) as readonly string[] | undefined;
    assert.deepEqual(summaryCaps, ['report.read']);
    const seriesCaps = metaOn(proto['timeseries'], CAPABILITY_KEY) as readonly string[] | undefined;
    assert.deepEqual(seriesCaps, ['report.read']);
  });

  it('report.export capability is registered (D5.6A) and present in the public catalogue', () => {
    const codes = new Set(CAPABILITY_DEFINITIONS.map((c) => c.code as string));
    assert.equal(codes.has('report.export'), true);
  });
});

// ════════════════════════════════════════════════════════════════
// B. Catalogue extension — D5.6C report.* fields registered
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6C — report catalogue entries', () => {
  const required = [
    'summary.totalLeads',
    'summary.overdue',
    'summary.dueToday',
    'summary.followupsPending',
    'summary.followupsDone',
    'summary.activations',
    'summary.conversionRate',
    'stageBuckets',
    'leadsCreatedTimeseries',
  ];

  it('every report metric field is present', () => {
    const present = new Set(
      FIELD_CATALOGUE.filter((e) => e.resource === 'report').map((e) => e.field),
    );
    for (const f of required) {
      assert.equal(present.has(f), true, `missing report catalogue entry: report.${f}`);
    }
  });

  it('summary.activations and summary.conversionRate are flagged sensitive (commercial)', () => {
    const find = (field: string) =>
      FIELD_CATALOGUE.find((e) => e.resource === 'report' && e.field === field);
    assert.equal(find('summary.activations')?.sensitive, true);
    assert.equal(find('summary.conversionRate')?.sensitive, true);
  });
});

// ════════════════════════════════════════════════════════════════
// C. End-to-end via the ExportInterceptor
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6C — ExportInterceptor on csv-keyvalue reports', () => {
  let redactor: ExportRedactionService;
  let audit: FakeAuditService;
  let interceptor: ExportInterceptor;

  beforeEach(() => {
    setFlag('true');
    redactor = new ExportRedactionService();
    audit = new FakeAuditService();
  });

  afterEach(() => {
    setFlag(ORIGINAL_FLAG === undefined ? undefined : (ORIGINAL_FLAG as 'true' | 'false'));
  });

  // ── flag off — bytes match the legacy buildCsv reports CSV format ──
  it('flag off — output ends with trailing newline + section,key,value triples (legacy format)', async () => {
    setFlag('false');
    const { res, headers } = makeRes();
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { report: ['summary.activations'] } })),
      redactor,
      audit,
    );
    const ctx = makeCtx({
      req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
      res,
      metadata: {
        gate: {
          primary: 'report',
          format: 'csv-keyvalue',
          filename: 'crm-report.csv',
        },
      },
    });
    const out = (await firstValueFrom(
      interceptor.intercept(ctx, handlerOf(reportsStructured())),
    )) as string;

    // Ends with newline (legacy convention).
    assert.equal(out.endsWith('\n'), true, 'reports CSV must end with newline');
    // Comments preamble preserved.
    assert.match(out, /^# Trade Way \/ Captain Masr CRM — report export\n/);
    // Section/key/value header.
    assert.match(out, /\nsection,key,value\n/);
    // Activations row STILL present (flag off — no redaction).
    assert.match(out, /\nsummary,activations,7\n/);
    // No audit row when flag off.
    assert.equal(audit.calls.length, 0);
    assert.equal(headers['X-Export-Audit-Id'], undefined);
  });

  // ── flag on + no deny rules — bytes match flag-off output ────
  it('flag on + no deny rules — bytes identical to flag-off output (golden-file)', async () => {
    setFlag('false');
    let interceptorOff = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({})),
      redactor,
      new FakeAuditService(),
    );
    const off = (await firstValueFrom(
      interceptorOff.intercept(
        makeCtx({
          req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
          res: makeRes().res,
          metadata: {
            gate: { primary: 'report', format: 'csv-keyvalue', filename: 'a.csv' },
          },
        }),
        handlerOf(reportsStructured()),
      ),
    )) as string;

    setFlag('true');
    interceptorOff = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({})),
      redactor,
      audit,
    );
    const on = (await firstValueFrom(
      interceptorOff.intercept(
        makeCtx({
          req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
          res: makeRes().res,
          metadata: {
            gate: { primary: 'report', format: 'csv-keyvalue', filename: 'a.csv' },
          },
        }),
        handlerOf(reportsStructured()),
      ),
    )) as string;

    assert.equal(on, off, 'bytes match when no deny rules apply');
    // Audit fires under flag-on even without redactions.
    assert.equal(audit.calls.length, 1);
    assert.deepEqual(audit.calls[0]!.columnsRedacted, []);
  });

  // ── deny one summary metric ──────────────────────────────────
  it('deny report.summary.activations — that single row is removed; conversion_rate stays', async () => {
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { report: ['summary.activations'] } })),
      redactor,
      audit,
    );
    const { res, headers } = makeRes();
    const out = (await firstValueFrom(
      interceptor.intercept(
        makeCtx({
          req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
          res,
          metadata: {
            gate: { primary: 'report', format: 'csv-keyvalue', filename: 'a.csv' },
          },
        }),
        handlerOf(reportsStructured()),
      ),
    )) as string;

    // Activations row stripped.
    assert.equal(out.includes('summary,activations,7'), false);
    // Conversion rate row preserved.
    assert.match(out, /\nsummary,conversion_rate,0\.45/);
    // Other rows untouched.
    assert.match(out, /\nsummary,total_leads,142/);
    assert.match(out, /\nsummary,overdue,5/);
    // Stage rows untouched.
    assert.match(out, /\nstage,new,42/);
    // Header still present.
    assert.match(out, /\nsection,key,value\n/);
    // Headers + audit.
    assert.equal(headers['X-Export-Redacted-Columns'], 'summary.activations');
    assert.equal(audit.calls.length, 1);
    assert.deepEqual(audit.calls[0]!.columnsRedacted, ['summary.activations']);
  });

  // ── deny both commercial metrics ─────────────────────────────
  it('deny activations + conversionRate — both removed', async () => {
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(
        bundle({
          deniedRead: { report: ['summary.activations', 'summary.conversionRate'] },
        }),
      ),
      redactor,
      audit,
    );
    const { res, headers } = makeRes();
    const out = (await firstValueFrom(
      interceptor.intercept(
        makeCtx({
          req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
          res,
          metadata: {
            gate: { primary: 'report', format: 'csv-keyvalue', filename: 'a.csv' },
          },
        }),
        handlerOf(reportsStructured()),
      ),
    )) as string;

    assert.equal(out.includes('summary,activations,'), false);
    assert.equal(out.includes('summary,conversion_rate,'), false);
    assert.equal(
      headers['X-Export-Redacted-Columns']!.split(',').sort().join(','),
      'summary.activations,summary.conversionRate',
    );
  });

  // ── group denial: stageBuckets ───────────────────────────────
  it('deny report.stageBuckets — every stage,* row removed but summary/timeseries survive', async () => {
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { report: ['stageBuckets'] } })),
      redactor,
      audit,
    );
    const { res } = makeRes();
    const out = (await firstValueFrom(
      interceptor.intercept(
        makeCtx({
          req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
          res,
          metadata: {
            gate: { primary: 'report', format: 'csv-keyvalue', filename: 'a.csv' },
          },
        }),
        handlerOf(reportsStructured()),
      ),
    )) as string;

    assert.equal(out.includes('stage,'), false, 'every stage,* row dropped');
    // Summary + timeseries survive.
    assert.match(out, /\nsummary,total_leads,142/);
    assert.match(out, /\nleads_created,2026-04-01,5/);
    // Audit reports the catalogue field (single identifier),
    // even though two stage rows were dropped — the catalogue
    // field is the canonical deny-rule handle (group identifier).
    assert.deepEqual(audit.calls[0]!.columnsRedacted, ['stageBuckets']);
  });

  // ── group denial: leadsCreatedTimeseries ──────────────────────
  it('deny report.leadsCreatedTimeseries — every leads_created,* row removed', async () => {
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { report: ['leadsCreatedTimeseries'] } })),
      redactor,
      audit,
    );
    const { res } = makeRes();
    const out = (await firstValueFrom(
      interceptor.intercept(
        makeCtx({
          req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
          res,
          metadata: {
            gate: { primary: 'report', format: 'csv-keyvalue', filename: 'a.csv' },
          },
        }),
        handlerOf(reportsStructured()),
      ),
    )) as string;

    assert.equal(out.includes('leads_created,'), false);
    assert.match(out, /\nstage,new,42/);
    assert.match(out, /\nsummary,total_leads,142/);
  });

  // ── super-admin: full export, audit fires ────────────────────
  it('super_admin: every metric ships; audit row still recorded', async () => {
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(
        bundle({
          code: 'super_admin',
          deniedRead: { report: ['summary.activations', 'stageBuckets'] },
        }),
      ),
      redactor,
      audit,
    );
    const { res } = makeRes();
    const out = (await firstValueFrom(
      interceptor.intercept(
        makeCtx({
          req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
          res,
          metadata: {
            gate: { primary: 'report', format: 'csv-keyvalue', filename: 'a.csv' },
          },
        }),
        handlerOf(reportsStructured()),
      ),
    )) as string;

    assert.match(out, /\nsummary,activations,7/);
    assert.match(out, /\nstage,new,42/);
    assert.equal(audit.calls.length, 1);
    assert.deepEqual(audit.calls[0]!.columnsRedacted, []);
  });

  // ── audit payload — no metric values ─────────────────────────
  it('audit payload carries metric-key metadata only (no exported values)', async () => {
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { report: ['summary.activations'] } })),
      redactor,
      audit,
    );
    const { res } = makeRes();
    await firstValueFrom(
      interceptor.intercept(
        makeCtx({
          req: {
            user: USER,
            query: { from: '2026-04-01', to: '2026-04-30' },
            originalUrl: '/reports/export.csv?from=2026-04-01&to=2026-04-30',
            method: 'GET',
          },
          res,
          metadata: {
            gate: { primary: 'report', format: 'csv-keyvalue', filename: 'a.csv' },
          },
        }),
        handlerOf(reportsStructured()),
      ),
    );
    assert.equal(audit.calls.length, 1);
    const row = audit.calls[0]!;
    assert.equal(row.resource, 'report');
    assert.equal(row.endpoint, 'GET /reports/export.csv');
    assert.deepEqual(row.filters, { from: '2026-04-01', to: '2026-04-30' });
    // The audit row records metric KEYS in columnsExported /
    // columnsRedacted — never the raw integer values.
    const rendered = JSON.stringify(row);
    assert.equal(rendered.includes('142'), false, 'total_leads value 142 not in audit payload');
    assert.equal(rendered.includes('"7"'), false, 'activations value 7 not in audit payload');
    assert.equal(rendered.includes('0.45'), false, 'conversion rate not in audit payload');
    // But the metric keys ARE present (for forensic completeness).
    assert.ok(row.columnsRedacted.includes('summary.activations'));
    assert.ok(
      row.columnsExported.some((k) => k.includes('summary.total_leads')) ||
        row.columnsExported.some((k) => k === 'summary.total_leads'),
    );
  });

  // ── csv-keyvalue id-style structural columns survive ─────────
  it('section / key / value columns are redactable=false — admin cannot strip them', async () => {
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(
        bundle({
          // Deny all three structural column names — the redactor
          // doesn't drop columns in csv-keyvalue mode anyway, but
          // the columns also declare redactable: false so even
          // a future column-mode confusion can't strip them.
          deniedRead: { report: ['_meta'] },
        }),
      ),
      redactor,
      audit,
    );
    const { res } = makeRes();
    const out = (await firstValueFrom(
      interceptor.intercept(
        makeCtx({
          req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
          res,
          metadata: {
            gate: { primary: 'report', format: 'csv-keyvalue', filename: 'a.csv' },
          },
        }),
        handlerOf(reportsStructured()),
      ),
    )) as string;
    assert.match(out, /\nsection,key,value\n/);
  });
});
