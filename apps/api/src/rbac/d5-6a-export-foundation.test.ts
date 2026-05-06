/**
 * Phase D5 — D5.6A: Export Governance Foundation.
 *
 * Pure unit tests for the new export-governance plumbing:
 *
 *   • capabilities.registry — 5 new export caps registered.
 *   • roles.registry — backfilled onto every role with
 *     `tenant.export`; idempotent in shape (no role lists the
 *     same cap twice).
 *   • @ExportGate decorator — metadata round-trips.
 *   • csv-serializer — comments, header, rows, special chars
 *     (commas, quotes, newlines, RTL Arabic), determinism, row-
 *     count preservation, empty-rows path.
 *   • ExportRedactionService — super-admin bypass, no-deny fast
 *     path, mixed-resource columns, non-redactable columns
 *     survive, row-count preserved, structural cloning leaves
 *     the input untouched.
 *   • ExportInterceptor — passthrough on no metadata, on flag
 *     off, on non-structured payloads, on missing user; active
 *     path serialises CSV, sets headers, writes audit row, and
 *     persists the redacted-columns header.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, type Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

import { CAPABILITY_DEFINITIONS } from './capabilities.registry';
import { ROLE_DEFINITIONS } from './roles.registry';

import { csvEscape, formatCell, serializeCsv } from './csv-serializer';
import type { ExportColumn, StructuredExport } from './export-contract';
import { ExportAuditService } from './export-audit.service';
import { ExportInterceptor } from './export.interceptor';
import { ExportRedactionService } from './export-redaction.service';
import { ExportGate, EXPORT_GATE_KEY } from './export-gate.decorator';
import { PermissionResolverService, type ResolvedPermissions } from './permission-resolver.service';

// ─── helpers ──────────────────────────────────────────────────────

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

function col(
  key: string,
  resource: ExportColumn['resource'],
  field: string,
  extra?: Partial<ExportColumn>,
): ExportColumn {
  return { key, label: key, resource, field, ...extra };
}

function structured(opts: {
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
  comments?: string[];
}): StructuredExport {
  return {
    format: 'csv',
    filename: 'test.csv',
    ...(opts.comments !== undefined && { comments: opts.comments }),
    columns: opts.columns,
    rows: opts.rows,
  };
}

const ORIGINAL_FLAG = process.env['D5_DYNAMIC_PERMISSIONS_V1'];
function setFlag(value: 'true' | 'false' | undefined): void {
  if (value === undefined) delete process.env['D5_DYNAMIC_PERMISSIONS_V1'];
  else process.env['D5_DYNAMIC_PERMISSIONS_V1'] = value;
}

// ════════════════════════════════════════════════════════════════
// Capabilities
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6A — export capabilities registered', () => {
  const required = [
    'lead.export',
    'report.export',
    'partner.reconciliation.export',
    'partner.commission.export',
    'audit.export',
  ];

  it('every new cap is in CAPABILITY_DEFINITIONS', () => {
    const codes: Set<string> = new Set(CAPABILITY_DEFINITIONS.map((c) => c.code as string));
    for (const code of required) {
      assert.ok(codes.has(code), `missing capability: ${code}`);
    }
  });

  it('every cap appears exactly once in CAPABILITY_DEFINITIONS (no duplicates)', () => {
    const seen = new Set<string>();
    for (const c of CAPABILITY_DEFINITIONS) {
      assert.equal(seen.has(c.code), false, `duplicate cap: ${c.code}`);
      seen.add(c.code);
    }
  });

  it('every role with tenant.export also lists the 5 new export caps (idempotent backfill)', () => {
    for (const role of ROLE_DEFINITIONS) {
      const caps: Set<string> = new Set(role.capabilities as ReadonlyArray<string>);
      if (!caps.has('tenant.export')) continue;
      for (const code of required) {
        assert.ok(caps.has(code), `role ${role.code} has tenant.export but is missing ${code}`);
      }
    }
  });

  it('no role lists the same cap twice (each capabilities[] entry is unique)', () => {
    for (const role of ROLE_DEFINITIONS) {
      const seen = new Set<string>();
      for (const c of role.capabilities as readonly string[]) {
        assert.equal(seen.has(c), false, `role ${role.code} lists capability '${c}' twice`);
        seen.add(c);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════
// @ExportGate decorator
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6A — @ExportGate decorator', () => {
  it('attaches metadata under EXPORT_GATE_KEY', () => {
    class Probe {
      handler() {
        /* noop */
      }
    }
    ExportGate({
      primary: 'partner.reconciliation',
      inherits: ['lead', 'captain'],
      format: 'csv',
      filename: 'fixed.csv',
    })(Probe.prototype, 'handler', Object.getOwnPropertyDescriptor(Probe.prototype, 'handler')!);

    const meta = Reflect.getMetadata(EXPORT_GATE_KEY, Probe.prototype.handler);
    assert.ok(meta);
    assert.equal(meta.primary, 'partner.reconciliation');
    assert.deepEqual(meta.inherits, ['lead', 'captain']);
    assert.equal(meta.format, 'csv');
    assert.equal(meta.filename, 'fixed.csv');
  });

  it('accepts a filename callback', () => {
    class Probe {
      handler() {
        /* noop */
      }
    }
    ExportGate({
      primary: 'report',
      format: 'csv',
      filename: ({ format }) => `report.${format}`,
    })(Probe.prototype, 'handler', Object.getOwnPropertyDescriptor(Probe.prototype, 'handler')!);

    const meta = Reflect.getMetadata(EXPORT_GATE_KEY, Probe.prototype.handler);
    assert.equal(typeof meta.filename, 'function');
    assert.equal(meta.filename({ format: 'csv' }), 'report.csv');
  });
});

// ════════════════════════════════════════════════════════════════
// CSV serializer
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6A — csv-serializer', () => {
  it('emits header + rows for a tabular export', () => {
    const out = serializeCsv(
      structured({
        columns: [col('a', 'lead', 'name'), col('b', 'lead', 'phone')],
        rows: [
          { a: 'Alice', b: '+201' },
          { a: 'Bob', b: '+202' },
        ],
      }),
    );
    assert.equal(out, 'a,b\nAlice,+201\nBob,+202\n');
  });

  it('emits comments preamble before the header', () => {
    const out = serializeCsv(
      structured({
        columns: [col('a', 'lead', 'name')],
        rows: [{ a: 'X' }],
        comments: ['# generated_at: 2026-05-01', '# filter: none'],
      }),
    );
    assert.equal(out, '# generated_at: 2026-05-01\n# filter: none\na\nX\n');
  });

  it('escapes commas, quotes, newlines per RFC 4180 and preserves UTF-8/Arabic', () => {
    const out = serializeCsv(
      structured({
        columns: [col('a', 'lead', 'name')],
        rows: [
          { a: 'Hello, "world"' },
          { a: 'multi\nline' },
          { a: 'مرحبا بالعالم' }, // Arabic — no quoting needed.
          { a: '' },
        ],
      }),
    );
    assert.equal(
      out,
      'a\n' + '"Hello, ""world"""\n' + '"multi\nline"\n' + 'مرحبا بالعالم\n' + '\n',
    );
  });

  it('preserves row count even when rows are empty objects (cells become blank)', () => {
    const out = serializeCsv(
      structured({
        columns: [col('a', 'lead', 'name'), col('b', 'lead', 'phone')],
        rows: [{}, { a: 'X' }, {}],
      }),
    );
    const lines = out.split('\n').filter((l) => l !== '');
    // header + 3 rows.
    assert.equal(lines.length, 4);
    assert.equal(lines[0], 'a,b');
    assert.equal(lines[1], ',');
    assert.equal(lines[2], 'X,');
    assert.equal(lines[3], ',');
  });

  it('formatCell coerces primitives correctly', () => {
    assert.equal(formatCell(null), '');
    assert.equal(formatCell(undefined), '');
    assert.equal(formatCell(0), '0');
    assert.equal(formatCell(42), '42');
    assert.equal(formatCell(Number.NaN), '');
    assert.equal(formatCell(Number.POSITIVE_INFINITY), '');
    assert.equal(formatCell(true), 'true');
    assert.equal(formatCell(false), 'false');
    assert.equal(formatCell(BigInt('9007199254740993')), '9007199254740993');
    assert.equal(formatCell(new Date('2026-05-01T00:00:00Z')), '2026-05-01T00:00:00.000Z');
    assert.equal(formatCell('hello'), 'hello');
  });

  it('formatCell rejects nested objects (must be flattened by the controller)', () => {
    assert.throws(() => formatCell({ nested: 1 }));
  });

  it('csvEscape: empty string passes through', () => {
    assert.equal(csvEscape(''), '');
  });

  it('serializeCsv is deterministic — same input twice yields same bytes', () => {
    const input = structured({
      columns: [col('a', 'lead', 'name'), col('b', 'lead', 'phone')],
      rows: [
        { a: 'X', b: '+1' },
        { a: 'Y', b: '+2' },
      ],
      comments: ['# one'],
    });
    const a = serializeCsv(input);
    const b = serializeCsv(input);
    assert.equal(a, b);
  });

  it('serializeCsv rejects an unsupported format', () => {
    assert.throws(() =>
      serializeCsv({
        format: 'json',
        filename: 'x.csv',
        columns: [],
        rows: [],
      } as StructuredExport),
    );
  });
});

// ════════════════════════════════════════════════════════════════
// ExportRedactionService
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6A — ExportRedactionService', () => {
  const redactor = new ExportRedactionService();

  it('super_admin bypass — input returned with bypassed=true', () => {
    const input = structured({
      columns: [col('a', 'lead', 'phone'), col('b', 'lead', 'name')],
      rows: [{ a: '+1', b: 'X' }],
    });
    const out = redactor.redactColumns(
      input,
      bundle({ code: 'super_admin', deniedRead: { lead: ['phone'] } }),
    );
    assert.equal(out.bypassed, true);
    assert.deepEqual(out.columnsRedacted, []);
    assert.equal(out.redacted.columns.length, 2);
    assert.deepEqual(out.redacted.rows, [{ a: '+1', b: 'X' }]);
  });

  it('no deny rules fast path — input returned unchanged', () => {
    const input = structured({
      columns: [col('a', 'lead', 'phone')],
      rows: [{ a: '+1' }],
    });
    const out = redactor.redactColumns(input, bundle({ deniedRead: {} }));
    assert.equal(out.bypassed, false);
    assert.equal(out.redacted, input, 'reference equality: no clone needed');
  });

  it('drops columns whose (resource, field) pair is in the deny list', () => {
    const input = structured({
      columns: [
        col('phone', 'lead', 'phone'),
        col('name', 'lead', 'name'),
        col('campaign', 'lead', 'attribution.campaign'),
      ],
      rows: [
        { phone: '+1', name: 'X', campaign: 'eg_q2' },
        { phone: '+2', name: 'Y', campaign: 'eg_q3' },
      ],
    });
    const out = redactor.redactColumns(
      input,
      bundle({ deniedRead: { lead: ['phone', 'attribution.campaign'] } }),
    );
    assert.deepEqual(out.columnsExported, ['name']);
    assert.deepEqual(out.columnsRedacted.slice().sort(), ['campaign', 'phone']);
    assert.equal(out.redacted.columns.length, 1);
    assert.equal(out.redacted.columns[0]!.key, 'name');
    assert.equal(out.redacted.rows.length, 2, 'row count preserved');
    for (const r of out.redacted.rows) {
      assert.equal('phone' in r, false);
      assert.equal('campaign' in r, false);
      assert.ok(r['name']);
    }
  });

  it('mixed-resource columns: a lead.phone deny strips the phone column from a partner.reconciliation export', () => {
    const input: StructuredExport = {
      format: 'csv',
      filename: 'partner-reconciliation.csv',
      columns: [
        col('phone', 'lead', 'phone'),
        col('partner_status', 'partner.verification', 'partnerStatus'),
        col('crm_active_date', 'captain', 'activatedAt'),
      ],
      rows: [{ phone: '+1', partner_status: 'active', crm_active_date: '2026-04-01' }],
    };
    const out = redactor.redactColumns(input, bundle({ deniedRead: { lead: ['phone'] } }));
    assert.deepEqual(out.columnsRedacted, ['phone']);
    assert.deepEqual(out.columnsExported, ['partner_status', 'crm_active_date']);
    assert.equal('phone' in out.redacted.rows[0]!, false);
  });

  it('non-redactable columns survive even with a deny row', () => {
    // lead.id is `redactable: false` in the catalogue. A deny row
    // for it MUST be ignored.
    const input = structured({
      columns: [col('id', 'lead', 'id'), col('phone', 'lead', 'phone')],
      rows: [{ id: 'lead-1', phone: '+1' }],
    });
    const out = redactor.redactColumns(input, bundle({ deniedRead: { lead: ['id', 'phone'] } }));
    assert.deepEqual(out.columnsRedacted, ['phone']);
    assert.deepEqual(out.columnsExported, ['id']);
    assert.equal(out.redacted.rows[0]!['id'], 'lead-1');
  });

  it('column-level redactable=false short-circuits even when catalogue says redactable', () => {
    // lead.name is redactable in the catalogue; the column declares
    // `redactable: false` so it must survive.
    const input = structured({
      columns: [col('name', 'lead', 'name', { redactable: false })],
      rows: [{ name: 'X' }],
    });
    const out = redactor.redactColumns(input, bundle({ deniedRead: { lead: ['name'] } }));
    assert.equal(out.columnsRedacted.length, 0);
    assert.equal(out.redacted.columns[0]!.key, 'name');
  });

  it('row count is preserved even when every column is dropped', () => {
    const input = structured({
      columns: [col('a', 'lead', 'phone'), col('b', 'lead', 'name')],
      rows: [
        { a: '+1', b: 'X' },
        { a: '+2', b: 'Y' },
        { a: '+3', b: 'Z' },
      ],
    });
    const out = redactor.redactColumns(input, bundle({ deniedRead: { lead: ['phone', 'name'] } }));
    assert.equal(out.redacted.columns.length, 0);
    assert.equal(out.redacted.rows.length, 3);
    for (const r of out.redacted.rows) {
      assert.deepEqual(Object.keys(r), []);
    }
  });

  it('does not mutate the input', () => {
    const input = structured({
      columns: [col('a', 'lead', 'phone'), col('b', 'lead', 'name')],
      rows: [{ a: '+1', b: 'X' }],
    });
    const before = JSON.stringify(input);
    redactor.redactColumns(input, bundle({ deniedRead: { lead: ['phone'] } }));
    assert.equal(JSON.stringify(input), before, 'input mutated');
  });
});

// ════════════════════════════════════════════════════════════════
// ExportInterceptor
// ════════════════════════════════════════════════════════════════

const USER = { typ: 'access' as const, sub: 'u1', tid: 't1', rid: 'r1' };

function makeCtx(opts: { req: unknown; res?: unknown; metadata?: unknown }): ExecutionContext {
  const handler = function fakeHandler() {
    /* placeholder */
  };
  if (opts.metadata) {
    Reflect.defineMetadata(EXPORT_GATE_KEY, opts.metadata, handler);
  }
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

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  } as unknown as { setHeader: (n: string, v: string) => void };
  return { res, headers };
}

function makeResolver(b: ResolvedPermissions): PermissionResolverService {
  return { resolveForUser: async () => b } as unknown as PermissionResolverService;
}

class FakeAuditService extends ExportAuditService {
  public calls: unknown[] = [];
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super({} as any);
  }
  override async recordExport(input: Parameters<ExportAuditService['recordExport']>[0]) {
    this.calls.push(input);
    return { entityId: 'audit-fixed-id' };
  }
}

describe('rbac/D5.6A — ExportInterceptor', () => {
  let redactor: ExportRedactionService;
  let audit: FakeAuditService;

  beforeEach(() => {
    setFlag('true');
    redactor = new ExportRedactionService();
    audit = new FakeAuditService();
  });

  afterEach(() => {
    setFlag(ORIGINAL_FLAG === undefined ? undefined : (ORIGINAL_FLAG as 'true' | 'false'));
  });

  it('no @ExportGate metadata → passthrough', async () => {
    const interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({})),
      redactor,
      audit,
    );
    const payload = { items: [], total: 0 };
    const ctx = makeCtx({ req: { user: USER } });
    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.deepEqual(out, payload);
    assert.equal(audit.calls.length, 0);
  });

  it('flag off → passthrough even with metadata + structured payload', async () => {
    setFlag('false');
    const interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { lead: ['phone'] } })),
      redactor,
      audit,
    );
    const payload = structured({
      columns: [col('phone', 'lead', 'phone'), col('name', 'lead', 'name')],
      rows: [{ phone: '+1', name: 'X' }],
    });
    const ctx = makeCtx({
      req: { user: USER, query: {}, originalUrl: '/x' },
      metadata: { primary: 'lead', format: 'csv', filename: 'x.csv' },
    });
    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.equal(out, payload, 'structure returned unchanged when flag off');
    assert.equal(audit.calls.length, 0);
  });

  it('non-structured payload → passthrough (controller still uses legacy res.send)', async () => {
    const interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { lead: ['phone'] } })),
      redactor,
      audit,
    );
    const ctx = makeCtx({
      req: { user: USER, query: {}, originalUrl: '/x' },
      metadata: { primary: 'lead', format: 'csv', filename: 'x.csv' },
    });
    const payload = 'raw,csv,string\n1,2,3\n';
    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.equal(out, payload);
    assert.equal(audit.calls.length, 0);
  });

  it('missing req.user → passthrough', async () => {
    const interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({})),
      redactor,
      audit,
    );
    const payload = structured({
      columns: [col('phone', 'lead', 'phone')],
      rows: [{ phone: '+1' }],
    });
    const ctx = makeCtx({
      req: { query: {}, originalUrl: '/x' },
      metadata: { primary: 'lead', format: 'csv', filename: 'x.csv' },
    });
    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.equal(out, payload);
    assert.equal(audit.calls.length, 0);
  });

  it('active path: redacts columns, serialises CSV, sets headers, writes audit row', async () => {
    const { res, headers } = makeRes();
    const interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { lead: ['phone'] } })),
      redactor,
      audit,
    );
    const payload = structured({
      columns: [col('phone', 'lead', 'phone'), col('name', 'lead', 'name')],
      rows: [
        { phone: '+1', name: 'X' },
        { phone: '+2', name: 'Y' },
      ],
      comments: ['# generated: 2026-05-01'],
    });
    const ctx = makeCtx({
      req: {
        user: USER,
        query: { partnerSourceId: 's-1' },
        originalUrl: '/partner/reconciliation/export.csv?partnerSourceId=s-1',
        method: 'GET',
      },
      res,
      metadata: { primary: 'partner.reconciliation', format: 'csv', filename: 'recon.csv' },
    });

    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));

    assert.equal(typeof out, 'string');
    // Header line should contain only `name` (phone redacted).
    const text = out as string;
    const lines = text.split('\n');
    assert.equal(lines[0], '# generated: 2026-05-01');
    assert.equal(lines[1], 'name', 'header excludes redacted phone column');
    assert.equal(lines[2], 'X');
    assert.equal(lines[3], 'Y');

    // Headers set.
    assert.equal(headers['Content-Type'], 'text/csv; charset=utf-8');
    assert.equal(headers['Content-Disposition'], 'attachment; filename="recon.csv"');
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(headers['X-Export-Redacted-Columns'], 'phone');
    assert.equal(headers['X-Export-Audit-Id'], 'audit-fixed-id');

    // Audit row written exactly once.
    assert.equal(audit.calls.length, 1);
    const auditCall = audit.calls[0] as {
      resource: string;
      actorUserId: string;
      endpoint: string;
      filters: Record<string, unknown>;
      columnsExported: string[];
      columnsRedacted: string[];
      rowCount: number;
      bytesShipped: number;
      flagState: string;
    };
    assert.equal(auditCall.resource, 'partner.reconciliation');
    assert.equal(auditCall.actorUserId, 'u1');
    assert.equal(auditCall.endpoint, 'GET /partner/reconciliation/export.csv');
    assert.deepEqual(auditCall.filters, { partnerSourceId: 's-1' });
    assert.deepEqual(auditCall.columnsExported, ['name']);
    assert.deepEqual(auditCall.columnsRedacted, ['phone']);
    assert.equal(auditCall.rowCount, 2);
    assert.ok(auditCall.bytesShipped > 0);
    assert.equal(auditCall.flagState, 'on');
  });

  it('active path with no deny rules: header lists "(none)" for redacted columns', async () => {
    const { res, headers } = makeRes();
    const interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({})),
      redactor,
      audit,
    );
    const payload = structured({
      columns: [col('name', 'lead', 'name')],
      rows: [{ name: 'X' }],
    });
    const ctx = makeCtx({
      req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
      res,
      metadata: { primary: 'lead', format: 'csv', filename: 'leads.csv' },
    });
    await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.equal(headers['X-Export-Redacted-Columns'], '(none)');
  });

  it('super_admin path: bypass returns full body, audit still fires for forensic trail', async () => {
    const { res } = makeRes();
    const interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ code: 'super_admin', deniedRead: { lead: ['phone'] } })),
      redactor,
      audit,
    );
    const payload = structured({
      columns: [col('phone', 'lead', 'phone'), col('name', 'lead', 'name')],
      rows: [{ phone: '+1', name: 'X' }],
    });
    const ctx = makeCtx({
      req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
      res,
      metadata: { primary: 'lead', format: 'csv', filename: 'leads.csv' },
    });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as string;
    // Both columns survive.
    const lines = out.split('\n');
    assert.equal(lines[0], 'phone,name');
    assert.equal(lines[1], '+1,X');
    // Audit was still written — super_admin downloads remain
    // forensically tracked.
    assert.equal(audit.calls.length, 1);
    const a = audit.calls[0] as { columnsRedacted: string[] };
    assert.deepEqual(a.columnsRedacted, []);
  });
});

// ════════════════════════════════════════════════════════════════
// Smoke imports — confirm public surfaces from D5.1-D5.5 untouched
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6A — earlier surfaces unchanged', () => {
  it('FieldRedactionInterceptor still exports its constructor', async () => {
    const mod = await import('./field-redaction.interceptor');
    assert.equal(typeof mod.FieldRedactionInterceptor, 'function');
  });

  it('PermissionResolverService still exports its constructor', async () => {
    const mod = await import('./permission-resolver.service');
    assert.equal(typeof mod.PermissionResolverService, 'function');
  });

  it('FieldFilterService still exports its constructor', async () => {
    const mod = await import('./field-filter.service');
    assert.equal(typeof mod.FieldFilterService, 'function');
  });
});
