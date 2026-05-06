/**
 * Phase D5 — D5.6B: governance wiring on partner reconciliation +
 * commission CSV exports.
 *
 * Three layers of assertions:
 *
 *   A. Decorator wiring — @ExportGate + @ResourceFieldGate +
 *      @RequireCapability metadata is present on the three
 *      controller methods D5.6B ships, with the right primary,
 *      inherits, format, capability code.
 *
 *   B. Structured-export builders — `buildStructuredExport` /
 *      `buildStructuredCommissionExport` produce the expected
 *      column set + row shape; columns reference the catalogue
 *      (resource, field) pair so mixed-resource redaction works.
 *
 *   C. End-to-end byte-equality + redaction via the interceptor —
 *      golden-file CSV bytes match a hand-derived expected string;
 *      a deny on `lead.phone` strips the `phone` column from BOTH
 *      reconciliation + commission exports; ID columns survive
 *      via `redactable: false`; super-admin gets all columns +
 *      audit row still fires; flag-off ships unredacted CSV bytes
 *      WITHOUT writing an audit row.
 *
 * Pure unit tests — no Postgres.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, type Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

import { PartnerReconciliationController } from '../partner/partner-reconciliation.controller';
import {
  PartnerMilestonesController,
  buildStructuredCommissionExport,
} from '../partner/partner-milestones.controller';

import { csvEscape } from './csv-serializer';
import type { StructuredExport } from './export-contract';
import { ExportAuditService } from './export-audit.service';
import { ExportInterceptor } from './export.interceptor';
import { ExportRedactionService } from './export-redaction.service';
import { EXPORT_GATE_KEY } from './export-gate.decorator';
import { CAPABILITY_KEY } from './require-capability.decorator';
import { RESOURCE_FIELD_GATE_KEY } from './resource-field-gate.decorator';
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
      code: opts.code ?? 'ops_manager',
      level: 90,
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
    return { entityId: 'audit-id-d5-6b' };
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

// ════════════════════════════════════════════════════════════════
// A. Decorator wiring
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6B — decorator wiring on export endpoints', () => {
  it('PartnerReconciliationController.exportCsv — @RequireCapability + @ExportGate (field gate is redundant on exports)', () => {
    const proto = PartnerReconciliationController.prototype as unknown as Record<string, unknown>;
    const m = proto['exportCsv'];

    const requiredCaps = metaOn(m, CAPABILITY_KEY) as readonly string[] | undefined;
    assert.deepEqual(requiredCaps, ['partner.reconciliation.export']);

    // The export route does NOT carry @ResourceFieldGate — the
    // ExportInterceptor produces a string body after column-level
    // redaction; the JSON read path (`list`) is the one that
    // carries @ResourceFieldGate (D5.4).
    const fieldGate = metaOn(m, RESOURCE_FIELD_GATE_KEY);
    assert.equal(fieldGate, undefined);

    const gate = metaOn(m, EXPORT_GATE_KEY) as
      | { primary: string; inherits: readonly string[]; format: string; filename: unknown }
      | undefined;
    assert.ok(gate);
    assert.equal(gate!.primary, 'partner.reconciliation');
    assert.deepEqual([...gate!.inherits].sort(), [
      'captain',
      'lead',
      'partner.verification',
      'partner_source',
    ]);
    assert.equal(gate!.format, 'csv');
    assert.equal(typeof gate!.filename, 'function');
  });

  it('PartnerMilestonesController.exportProgress / exportRisk — wiring + cap = partner.commission.export', () => {
    const proto = PartnerMilestonesController.prototype as unknown as Record<string, unknown>;
    for (const name of ['exportProgress', 'exportRisk']) {
      const m = proto[name];
      const caps = metaOn(m, CAPABILITY_KEY) as readonly string[] | undefined;
      assert.deepEqual(caps, ['partner.commission.export'], `${name} cap`);
      const gate = metaOn(m, EXPORT_GATE_KEY) as
        | { primary: string; inherits: readonly string[]; format: string }
        | undefined;
      assert.ok(gate, `${name} @ExportGate metadata`);
      assert.equal(gate!.primary, 'partner.commission');
      assert.deepEqual([...gate!.inherits].sort(), ['captain', 'lead', 'partner.verification']);
      assert.equal(gate!.format, 'csv');
    }
  });
});

// ════════════════════════════════════════════════════════════════
// B. Structured-export builder — commission shape
//    (Reconciliation builder is exercised end-to-end in section C
//    via a stub service — here we pin the shape directly for the
//    commission CSV which is a pure controller-side helper.)
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6B — buildStructuredCommissionExport', () => {
  function fixtureRow(
    overrides?: Partial<Parameters<typeof buildStructuredCommissionExport>[0][number]>,
  ) {
    return {
      phone: '+201005551234',
      crmName: 'Captain X',
      crmStage: 'open',
      owner: 'agent-1',
      projection: {
        partnerSourceName: 'Uber EG',
        configCode: 'eg_q2_2026',
        anchorAt: '2026-04-01',
        windowEndsAt: '2026-04-30',
        daysLeft: 14,
        tripCount: 7,
        targetTrips: 25,
        currentMilestone: 5,
        nextMilestone: 25,
        risk: 'medium',
        needsPush: true,
      },
      ...(overrides ?? {}),
    };
  }

  it('returns 15 columns with the expected (resource, field) mapping', () => {
    const out = buildStructuredCommissionExport([fixtureRow()], false);
    assert.equal(out.format, 'csv');
    assert.equal(out.columns.length, 15);
    const byKey = new Map(out.columns.map((c) => [c.key, c]));
    // Spot-check inheritance for redaction routing.
    assert.equal(byKey.get('phone')!.resource, 'lead');
    assert.equal(byKey.get('phone')!.field, 'phone');
    assert.equal(byKey.get('partner_trip_count')!.resource, 'partner.verification');
    assert.equal(byKey.get('target_trips')!.resource, 'partner.commission');
    assert.equal(byKey.get('target_trips')!.field, 'targetTrips');
    assert.equal(byKey.get('owner')!.resource, 'lead');
    assert.equal(byKey.get('owner')!.field, 'assignedToId');
  });

  it('preserves boolean / number / string formatting matching the legacy buildCsv output', () => {
    const out = buildStructuredCommissionExport([fixtureRow()], false);
    assert.equal(out.rows.length, 1);
    const row = out.rows[0]!;
    assert.equal(row['needs_push'], 'true');
    assert.equal(row['target_trips'], '25');
    assert.equal(row['days_left'], '14');
    assert.equal(row['partner_trip_count'], '7');
    assert.equal(row['risk'], 'medium');
  });

  it('riskOnly flag flips comments + filename label', () => {
    const progress = buildStructuredCommissionExport([], false);
    const risk = buildStructuredCommissionExport([], true);
    assert.match(progress.comments![0]!, /commission progress export/);
    assert.match(risk.comments![0]!, /commission risk export/);
    assert.match(progress.filename, /commission-progress/);
    assert.match(risk.filename, /commission-risk/);
  });
});

// ════════════════════════════════════════════════════════════════
// C. End-to-end via the ExportInterceptor — byte equality, mixed-
//    resource redaction, ID survival, super-admin, flag off, audit.
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6B — ExportInterceptor end-to-end', () => {
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

  function commissionStructured(): StructuredExport {
    return buildStructuredCommissionExport(
      [
        {
          phone: '+201005551234',
          crmName: 'Captain X',
          crmStage: 'open',
          owner: 'agent-1',
          projection: {
            partnerSourceName: 'Uber EG',
            configCode: 'eg_q2_2026',
            anchorAt: '2026-04-01',
            windowEndsAt: '2026-04-30',
            daysLeft: 14,
            tripCount: 7,
            targetTrips: 25,
            currentMilestone: 5,
            nextMilestone: 25,
            risk: 'medium',
            needsPush: true,
          },
        },
      ],
      false,
    );
  }

  // ── golden-file byte equality (flag off) ─────────────────────
  it('flag off + commission export — bytes match the legacy buildCsv shape exactly', async () => {
    setFlag('false');
    const { res } = makeRes();
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { lead: ['phone'] } })),
      redactor,
      audit,
    );
    const ctx = makeCtx({
      req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
      res,
      metadata: {
        gate: {
          primary: 'partner.commission',
          inherits: ['lead', 'captain', 'partner.verification'],
          format: 'csv',
          filename: 'partner-commission-progress.csv',
        },
      },
    });
    const out = (await firstValueFrom(
      interceptor.intercept(ctx, handlerOf(commissionStructured())),
    )) as string;

    // Hand-rolled expected bytes — mirrors the legacy buildCsv
    // output line for line.
    const expectedHeader = [
      'phone',
      'crm_name',
      'crm_stage',
      'partner_source',
      'config_code',
      'anchor_at',
      'window_ends_at',
      'days_left',
      'partner_trip_count',
      'target_trips',
      'current_milestone',
      'next_milestone',
      'risk',
      'needs_push',
      'owner',
    ].join(',');
    const expectedRow = [
      csvEscape('+201005551234'),
      csvEscape('Captain X'),
      csvEscape('open'),
      csvEscape('Uber EG'),
      csvEscape('eg_q2_2026'),
      '2026-04-01',
      '2026-04-30',
      '14',
      '7',
      '25',
      '5',
      '25',
      'medium',
      'true',
      csvEscape('agent-1'),
    ].join(',');
    const lines = out.split('\n');
    assert.equal(lines[0], '# Trade Way / Captain Masr CRM — partner commission progress export');
    assert.match(lines[1]!, /^# generated:/);
    assert.equal(lines[2], expectedHeader);
    assert.equal(lines[3], expectedRow);
    assert.equal(lines.length, 4, 'no trailing newline (D4 byte convention)');
    // Flag off → no audit row written.
    assert.equal(audit.calls.length, 0);
  });

  // ── flag on + no deny rules — bytes still match flag-off ─────
  it('flag on + no deny rules — bytes identical to flag off output', async () => {
    setFlag('true');
    const { res: res1, headers: h1 } = makeRes();
    const { res: res2, headers: h2 } = makeRes();

    // Run flag-off first.
    setFlag('false');
    interceptor = new ExportInterceptor(new Reflector(), makeResolver(bundle({})), redactor, audit);
    const off = (await firstValueFrom(
      interceptor.intercept(
        makeCtx({
          req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
          res: res1,
          metadata: {
            gate: {
              primary: 'partner.commission',
              format: 'csv',
              filename: 'a.csv',
            },
          },
        }),
        handlerOf(commissionStructured()),
      ),
    )) as string;

    setFlag('true');
    interceptor = new ExportInterceptor(new Reflector(), makeResolver(bundle({})), redactor, audit);
    const on = (await firstValueFrom(
      interceptor.intercept(
        makeCtx({
          req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
          res: res2,
          metadata: {
            gate: {
              primary: 'partner.commission',
              format: 'csv',
              filename: 'a.csv',
            },
          },
        }),
        handlerOf(commissionStructured()),
      ),
    )) as string;

    // The `# generated: <iso-now>` preamble line ticks per call —
    // strip it before comparison so a sub-millisecond delta between
    // two `new Date()` reads doesn't flake the test.
    const stripGenerated = (s: string) =>
      s
        .split('\n')
        .filter((l) => !l.startsWith('# generated'))
        .join('\n');
    assert.equal(stripGenerated(on), stripGenerated(off), 'bytes match when no deny rules apply');
    // Flag on still writes audit row even with no redactions.
    assert.equal(audit.calls.length, 1);
    assert.equal(h1['X-Export-Audit-Id'], undefined);
    assert.equal(h2['X-Export-Audit-Id'], 'audit-id-d5-6b');
  });

  // ── mixed-resource redaction — lead.phone strips commission/recon col ─
  it('lead.phone deny strips the phone column from a partner.commission export', async () => {
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { lead: ['phone'] } })),
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
            gate: {
              primary: 'partner.commission',
              format: 'csv',
              filename: 'a.csv',
            },
          },
        }),
        handlerOf(commissionStructured()),
      ),
    )) as string;

    const lines = out.split('\n');
    const header = lines[2]!;
    assert.equal(header.startsWith('crm_name,'), true, 'phone column dropped from header');
    assert.equal(header.includes('phone'), false);
    // Row count preserved.
    assert.equal(lines.length, 4);
    assert.equal(headers['X-Export-Redacted-Columns'], 'phone');
    // Audit row carries structural metadata.
    assert.equal(audit.calls.length, 1);
    assert.deepEqual(audit.calls[0]!.columnsRedacted, ['phone']);
    assert.ok(audit.calls[0]!.columnsExported.includes('crm_name'));
    assert.equal(audit.calls[0]!.columnsExported.includes('phone'), false);
    assert.equal(audit.calls[0]!.rowCount, 1);
  });

  // ── partner.verification.tripCount strips partner_trip_count ────
  it('partner.verification.tripCount deny strips partner_trip_count from a commission export', async () => {
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { 'partner.verification': ['tripCount'] } })),
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
            gate: {
              primary: 'partner.commission',
              format: 'csv',
              filename: 'a.csv',
            },
          },
        }),
        handlerOf(commissionStructured()),
      ),
    )) as string;
    assert.equal(out.includes('partner_trip_count'), false);
    assert.deepEqual(audit.calls[0]!.columnsRedacted, ['partner_trip_count']);
  });

  // ── captain.commissionAmount-style deny doesn't strip recon since recon doesn't ship that column ───
  it('cross-resource isolation: a captain deny that does not match any column is a no-op', async () => {
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { captain: ['commissionAmount'] } })),
      redactor,
      audit,
    );
    const { res, headers } = makeRes();
    await firstValueFrom(
      interceptor.intercept(
        makeCtx({
          req: { user: USER, query: {}, originalUrl: '/x', method: 'GET' },
          res,
          metadata: {
            gate: {
              primary: 'partner.commission',
              format: 'csv',
              filename: 'a.csv',
            },
          },
        }),
        handlerOf(commissionStructured()),
      ),
    );
    assert.equal(headers['X-Export-Redacted-Columns'], '(none)');
    assert.deepEqual(audit.calls[0]!.columnsRedacted, []);
  });

  // ── lead.id / captain.id columns survive even if a deny row exists ─
  it('redactable=false ID columns survive even with deny rows on lead.id / captain.id', async () => {
    // Build a reconciliation-style structured export that carries
    // both ID columns; verify they survive with a deny row.
    const reconStructured: StructuredExport = {
      format: 'csv',
      filename: 'recon.csv',
      comments: ['# generated'],
      columns: [
        { key: 'lead_id', label: 'lead_id', resource: 'lead', field: 'id', redactable: false },
        {
          key: 'captain_id',
          label: 'captain_id',
          resource: 'captain',
          field: 'id',
          redactable: false,
        },
        { key: 'phone', label: 'phone', resource: 'lead', field: 'phone' },
      ],
      rows: [{ lead_id: 'lead-1', captain_id: 'cap-1', phone: '+1' }],
    };
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(
        bundle({
          deniedRead: {
            lead: ['id', 'phone'],
            captain: ['id'],
          },
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
            gate: { primary: 'partner.reconciliation', format: 'csv', filename: 'recon.csv' },
          },
        }),
        handlerOf(reconStructured),
      ),
    )) as string;

    const lines = out.split('\n');
    const header = lines[1]!;
    assert.equal(header.includes('lead_id'), true);
    assert.equal(header.includes('captain_id'), true);
    assert.equal(header.includes('phone'), false);
    assert.deepEqual(audit.calls[0]!.columnsRedacted, ['phone']);
  });

  // ── super-admin: full export, audit fires ────────────────────
  it('super_admin: full column set returned, audit row still written', async () => {
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ code: 'super_admin', deniedRead: { lead: ['phone'] } })),
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
            gate: { primary: 'partner.commission', format: 'csv', filename: 'a.csv' },
          },
        }),
        handlerOf(commissionStructured()),
      ),
    )) as string;
    assert.equal(out.includes('phone'), true, 'super_admin keeps phone column');
    assert.equal(headers['X-Export-Redacted-Columns'], '(none)');
    assert.equal(audit.calls.length, 1);
    assert.deepEqual(audit.calls[0]!.columnsRedacted, []);
  });

  // ── audit payload sanity — no row data ───────────────────────
  it('audit payload: structural metadata only, no row data', async () => {
    interceptor = new ExportInterceptor(new Reflector(), makeResolver(bundle({})), redactor, audit);
    const { res } = makeRes();
    await firstValueFrom(
      interceptor.intercept(
        makeCtx({
          req: {
            user: USER,
            query: { partnerSourceId: 's-1', category: 'partner_missing' },
            originalUrl:
              '/partner/reconciliation/export.csv?partnerSourceId=s-1&category=partner_missing',
            method: 'GET',
          },
          res,
          metadata: {
            gate: {
              primary: 'partner.reconciliation',
              format: 'csv',
              filename: 'recon.csv',
            },
          },
        }),
        handlerOf(commissionStructured()),
      ),
    );
    assert.equal(audit.calls.length, 1);
    const row = audit.calls[0]!;
    assert.equal(row.resource, 'partner.reconciliation');
    assert.equal(row.actorUserId, 'u1');
    assert.equal(row.endpoint, 'GET /partner/reconciliation/export.csv');
    assert.deepEqual(row.filters, {
      partnerSourceId: 's-1',
      category: 'partner_missing',
    });
    assert.ok(row.bytesShipped > 0);
    assert.equal(row.flagState, 'on');
    assert.equal(row.rowCount, 1);
    // No row data ever appears in the audit payload.
    const rendered = JSON.stringify(row);
    assert.equal(rendered.includes('+201005551234'), false, 'phone not in audit payload');
    assert.equal(rendered.includes('Captain X'), false, 'crm_name not in audit payload');
    assert.equal(rendered.includes('Uber EG'), false, 'partner_source value not in audit payload');
  });
});
