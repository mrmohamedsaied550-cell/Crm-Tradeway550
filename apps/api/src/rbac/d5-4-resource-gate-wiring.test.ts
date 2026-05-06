/**
 * Phase D5 — D5.4: ResourceFieldGate wiring across captain, contact,
 * partner_source, partner.verification, partner.evidence, and
 * partner.reconciliation read paths.
 *
 * Two sets of tests:
 *
 *   A. Decorator-wiring assertions — confirm `@ResourceFieldGate(...)`
 *      metadata is attached to the exact controller methods D5.4
 *      ships, and is NOT attached to write paths (POST / PATCH /
 *      DELETE) or to CSV exports.
 *
 *   B. Interceptor-behaviour assertions for each new resource —
 *      flag off / super-admin bypass / deny rows strip / id-fields
 *      survive / pagination envelope handled.
 *
 * Pure unit tests — no Postgres.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, type Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

import { CaptainsController } from '../crm/captains.controller';
import { ContactsController } from '../contact/contacts.controller';
import { PartnerSourcesController } from '../partner/partner-sources.controller';
import { PartnerVerificationController } from '../partner/partner-verification.controller';
import { PartnerReconciliationController } from '../partner/partner-reconciliation.controller';

import { FieldFilterService } from './field-filter.service';
import { FieldRedactionInterceptor } from './field-redaction.interceptor';
import { PermissionResolverService, type ResolvedPermissions } from './permission-resolver.service';
import { RESOURCE_FIELD_GATE_KEY } from './resource-field-gate.decorator';

// ─── helpers ──────────────────────────────────────────────────────

function gateOn(method: unknown): string | undefined {
  if (typeof method !== 'function') return undefined;
  return Reflect.getMetadata(RESOURCE_FIELD_GATE_KEY, method);
}

function makeCtx(opts: { req: unknown; metadata?: string }): ExecutionContext {
  const handler = function fakeHandler() {
    /* placeholder */
  };
  if (opts.metadata) {
    Reflect.defineMetadata(RESOURCE_FIELD_GATE_KEY, opts.metadata, handler);
  }
  return {
    switchToHttp: () => ({ getRequest: () => opts.req }),
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

const fieldFilter = new FieldFilterService(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  {} as any,
);

const USER = { typ: 'access' as const, sub: 'u1', tid: 't1', rid: 'r1' };

const ORIGINAL_FLAG = process.env['D5_DYNAMIC_PERMISSIONS_V1'];
function setFlag(value: 'true' | 'false' | undefined): void {
  if (value === undefined) delete process.env['D5_DYNAMIC_PERMISSIONS_V1'];
  else process.env['D5_DYNAMIC_PERMISSIONS_V1'] = value;
}

// ─── A. decorator wiring ──────────────────────────────────────────

describe('rbac/D5.4 — @ResourceFieldGate wiring on read paths', () => {
  it('CaptainsController: list + getOne carry "captain"', () => {
    const proto = CaptainsController.prototype;
    assert.equal(gateOn(proto.list), 'captain');
    assert.equal(gateOn(proto.getOne), 'captain');
  });

  it('ContactsController: findOne carries "contact"', () => {
    const proto = ContactsController.prototype;
    assert.equal(gateOn(proto.findOne), 'contact');
  });

  it('ContactsController: write paths NOT decorated', () => {
    const proto = ContactsController.prototype as unknown as Record<string, unknown>;
    if (proto['update']) assert.equal(gateOn(proto['update']), undefined);
    if (proto['updateRaw']) assert.equal(gateOn(proto['updateRaw']), undefined);
  });

  it('PartnerSourcesController: list + findOne carry "partner_source"; mutation paths do not', () => {
    const proto = PartnerSourcesController.prototype as unknown as Record<string, unknown>;
    assert.equal(gateOn(proto['list']), 'partner_source');
    assert.equal(gateOn(proto['findOne']), 'partner_source');
    assert.equal(gateOn(proto['create']), undefined);
    assert.equal(gateOn(proto['update']), undefined);
    assert.equal(gateOn(proto['remove'] ?? proto['delete']), undefined);
  });

  it('PartnerVerificationController: forLead carries "partner.verification"; evidence list carries "partner.evidence"', () => {
    const proto = PartnerVerificationController.prototype as unknown as Record<string, unknown>;
    assert.equal(gateOn(proto['forLead']), 'partner.verification');
    assert.equal(gateOn(proto['evidence']), 'partner.evidence');
  });

  it('PartnerVerificationController: merge + attachEvidence (POSTs) NOT decorated', () => {
    const proto = PartnerVerificationController.prototype as unknown as Record<string, unknown>;
    assert.equal(gateOn(proto['mergePartner']), undefined);
    assert.equal(gateOn(proto['attachEvidence']), undefined);
  });

  it('PartnerReconciliationController: list carries "partner.reconciliation"; export.csv NOT decorated', () => {
    const proto = PartnerReconciliationController.prototype as unknown as Record<string, unknown>;
    assert.equal(gateOn(proto['list']), 'partner.reconciliation');
    const exportMethod =
      proto['exportCsv'] ?? proto['exportCSV'] ?? proto['export'] ?? proto['exportRecords'];
    if (exportMethod) {
      assert.equal(
        gateOn(exportMethod),
        undefined,
        'CSV export must NOT be decorated in D5.4 (export redaction is D5.6)',
      );
    }
  });
});

// ─── B. interceptor behaviour per new resource ────────────────────

describe('rbac/D5.4 — interceptor behaviour across new resources', () => {
  let interceptor: FieldRedactionInterceptor;

  beforeEach(() => {
    setFlag('true');
  });

  afterEach(() => {
    setFlag(ORIGINAL_FLAG === undefined ? undefined : (ORIGINAL_FLAG as 'true' | 'false'));
  });

  // ── flag off across all 6 resources ─────────────────────────────
  it('flag off — every new resource returns the response unchanged', async () => {
    setFlag('false');
    const resolver = makeResolver(
      bundle({
        deniedRead: {
          captain: ['commissionAmount'],
          contact: ['rawMetadata'],
          partner_source: ['credentialsMetadata'],
          'partner.verification': ['partnerStatus'],
          'partner.evidence': ['notes'],
          'partner.reconciliation': ['crmValues'],
        },
      }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    for (const res of [
      'captain',
      'contact',
      'partner_source',
      'partner.verification',
      'partner.evidence',
      'partner.reconciliation',
    ] as const) {
      const payload = {
        id: 'x',
        commissionAmount: 100,
        rawMetadata: { foo: 'bar' },
        credentialsMetadata: { hasCredentials: true },
        partnerStatus: 'active',
        notes: 'secret',
        crmValues: { x: 1 },
      };
      const ctx = makeCtx({ req: { user: USER }, metadata: res });
      const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
      assert.deepEqual(out, payload, `flag-off must not strip on resource=${res}`);
    }
  });

  // ── super-admin across all 6 resources ──────────────────────────
  it('super_admin — every new resource returns the response unchanged', async () => {
    const resolver = makeResolver(bundle({ code: 'super_admin', deniedRead: {} }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    for (const res of [
      'captain',
      'contact',
      'partner_source',
      'partner.verification',
      'partner.evidence',
      'partner.reconciliation',
    ] as const) {
      const payload = { id: 'x', commissionAmount: 100, partnerStatus: 'active' };
      const ctx = makeCtx({ req: { user: USER }, metadata: res });
      const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
      assert.deepEqual(out, payload);
    }
  });

  // ── captain: list envelope strips commissionAmount; id survives ─
  it('captain list envelope: commissionAmount stripped, id survives', async () => {
    const resolver = makeResolver(
      bundle({
        deniedRead: {
          captain: ['id', 'commissionAmount'], // try to deny id; must be ignored.
        },
      }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      items: [
        { id: 'cap-1', name: 'A', commissionAmount: 100 },
        { id: 'cap-2', name: 'B', commissionAmount: 200 },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'captain' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    assert.equal(out.total, 2);
    assert.equal(out.items.length, 2);
    for (const row of out.items) {
      assert.equal('commissionAmount' in row, false);
      assert.ok(row['id'], 'captain.id must always survive (catalogue: redactable=false)');
      assert.ok(row['name']);
    }
  });

  // ── captain detail strips commissionAmount; id survives ────────
  it('captain detail: commissionAmount stripped, id survives', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { captain: ['commissionAmount'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = { id: 'cap-1', name: 'A', commissionAmount: 100, dftAt: '2026-04-01' };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'captain' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as Record<
      string,
      unknown
    >;
    assert.equal(out['id'], 'cap-1');
    assert.equal('commissionAmount' in out, false);
    assert.equal(out['dftAt'], '2026-04-01');
  });

  // ── contact: rawMetadata stripped, id survives ─────────────────
  it('contact detail: rawMetadata stripped, id survives', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { contact: ['id', 'rawMetadata'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = { id: 'c-1', name: 'X', rawMetadata: { foo: 'bar' } };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'contact' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as Record<
      string,
      unknown
    >;
    assert.equal(out['id'], 'c-1', 'contact.id must always survive');
    assert.equal('rawMetadata' in out, false);
  });

  // ── partner_source list strips credentialsMetadata at top level ─
  it('partner_source list envelope: credentialsMetadata stripped per row', async () => {
    const resolver = makeResolver(
      bundle({ deniedRead: { partner_source: ['credentialsMetadata'] } }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      items: [
        {
          id: 's-1',
          displayName: 'Uber EG',
          credentialsMetadata: { hasCredentials: true, updatedAt: '2026-01-01' },
        },
      ],
      total: 1,
    };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'partner_source' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as {
      items: Array<Record<string, unknown>>;
    };
    assert.equal('credentialsMetadata' in out.items[0]!, false);
    assert.equal(out.items[0]!['displayName'], 'Uber EG');
  });

  // ── partner.verification: top-level fields strip ───────────────
  it('partner.verification: top-level fields stripped', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { 'partner.verification': ['phone'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      leadId: 'lead-1',
      phone: '+201005551234',
      hasCaptain: true,
      projections: [{ partnerStatus: 'active' }],
    };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'partner.verification' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as Record<
      string,
      unknown
    >;
    assert.equal('phone' in out, false);
    assert.equal(out['leadId'], 'lead-1');
    assert.equal(out['hasCaptain'], true);
  });

  // ── partner.evidence: list response is a plain array ────────────
  it('partner.evidence: plain-array response strips notes per row', async () => {
    const resolver = makeResolver(
      bundle({ deniedRead: { 'partner.evidence': ['notes', 'storageRef'] } }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = [
      { id: 'e-1', kind: 'partner_record', notes: 'secret', storageRef: 's3://x' },
      { id: 'e-2', kind: 'partner_record', notes: 'another', storageRef: 's3://y' },
    ];
    const ctx = makeCtx({ req: { user: USER }, metadata: 'partner.evidence' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as Array<
      Record<string, unknown>
    >;
    assert.equal(out.length, 2);
    for (const row of out) {
      assert.equal('notes' in row, false);
      assert.equal('storageRef' in row, false);
      assert.ok(row['id']);
      assert.equal(row['kind'], 'partner_record');
    }
  });

  // ── partner.reconciliation: items envelope, recommendedAction kept, severity stripped
  it('partner.reconciliation: items envelope strips configured fields', async () => {
    const resolver = makeResolver(
      bundle({ deniedRead: { 'partner.reconciliation': ['severity'] } }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      items: [
        {
          id: 'r-1',
          category: 'partner_missing',
          severity: 'warning',
          recommendedAction: 'review',
        },
      ],
      counts: { partner_missing: 1 },
      generatedAt: '2026-05-01T00:00:00Z',
    };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'partner.reconciliation' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as {
      items: Array<Record<string, unknown>>;
      counts: Record<string, number>;
      generatedAt: string;
    };
    assert.equal('severity' in out.items[0]!, false);
    assert.equal(out.items[0]!['recommendedAction'], 'review');
    assert.deepEqual(out.counts, { partner_missing: 1 });
    assert.equal(out.generatedAt, '2026-05-01T00:00:00Z');
  });

  // ── deny rows for OTHER resources don't bleed across ───────────
  it('cross-resource isolation: captain deny rows do not strip contact responses', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { captain: ['commissionAmount'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = { id: 'c-1', commissionAmount: 99 };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'contact' });
    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.deepEqual(out, payload, 'captain deny must not affect contact route');
  });
});
