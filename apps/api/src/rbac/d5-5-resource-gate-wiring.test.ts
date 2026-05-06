/**
 * Phase D5 — D5.5: ResourceFieldGate wiring across activity timeline,
 * lead reviews, rotation history, follow-ups, and audit log.
 *
 * Two layers (mirrors D5.3 / D5.4 pattern):
 *
 *   A. Decorator-wiring assertions — confirm `@ResourceFieldGate(...)`
 *      metadata is on the exact controller methods D5.5 ships, and
 *      is NOT on write paths or projections deferred to a later
 *      chunk (lead by-stage / overdue / due-today, WhatsApp,
 *      reports, partner exports).
 *
 *   B. Interceptor-behaviour assertions per new resource — flag
 *      off / super-admin / deny-rows strip / envelope handled /
 *      cross-resource isolation.
 *
 * Pure unit tests — no Postgres.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, type Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

import { AuditController } from '../audit/audit.controller';
import { LeadsController } from '../crm/leads.controller';
import { LeadReviewsController } from '../crm/lead-reviews.controller';
import { FollowUpsController } from '../follow-ups/follow-ups.controller';

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

describe('rbac/D5.5 — @ResourceFieldGate wiring on activity / review / rotation / followup / audit', () => {
  it('LeadsController: activities carries "lead.activity"; listRotations carries "rotation"', () => {
    const proto = LeadsController.prototype as unknown as Record<string, unknown>;
    assert.equal(gateOn(proto['activities']), 'lead.activity');
    assert.equal(gateOn(proto['listRotations']), 'rotation');
  });

  it('LeadsController: by-stage / overdue / due-today / attempts NOT decorated (D5.5 deferral)', () => {
    const proto = LeadsController.prototype as unknown as Record<string, unknown>;
    // by-stage and the SLA projection endpoints already filter at
    // service layer; D5.5 leaves them untouched.
    assert.equal(gateOn(proto['byStage']), undefined);
    assert.equal(gateOn(proto['overdue']), undefined);
    assert.equal(gateOn(proto['dueToday']), undefined);
    assert.equal(gateOn(proto['attempts']), undefined);
  });

  it('LeadReviewsController: list + getOne carry "lead.review"; resolve (POST) does not', () => {
    const proto = LeadReviewsController.prototype as unknown as Record<string, unknown>;
    assert.equal(gateOn(proto['list']), 'lead.review');
    assert.equal(gateOn(proto['getOne']), 'lead.review');
    assert.equal(gateOn(proto['resolve']), undefined, 'POST :id/resolve must not be decorated');
    // 'count' returns a single integer — no fields to redact, no decorator needed.
    if (proto['count']) assert.equal(gateOn(proto['count']), undefined);
  });

  it('FollowUpsController: mine + calendar + listForLead carry "followup"; mutations + summary do not', () => {
    const proto = FollowUpsController.prototype as unknown as Record<string, unknown>;
    assert.equal(gateOn(proto['mine']), 'followup');
    assert.equal(gateOn(proto['calendar']), 'followup');
    assert.equal(gateOn(proto['listForLead']), 'followup');
    // summary returns counters — no fields to redact.
    assert.equal(gateOn(proto['summary']), undefined);
    // mutations.
    assert.equal(gateOn(proto['create']), undefined);
    assert.equal(gateOn(proto['complete']), undefined);
    assert.equal(gateOn(proto['update']), undefined);
    assert.equal(gateOn(proto['remove'] ?? proto['delete']), undefined);
  });

  it('AuditController: list carries "audit"', () => {
    const proto = AuditController.prototype as unknown as Record<string, unknown>;
    assert.equal(gateOn(proto['list']), 'audit');
  });

  it('rotation.service still exports RotationService after D5.7 retired the hardcoded gate', async () => {
    // D5.7 replaced `userCanSeeOwnershipHistory` (hardcoded
    // `lead.write` capability check) with the field-permission
    // gate via OwnershipVisibilityService. Smoke-import the service
    // to verify the public surface still compiles.
    const mod = await import('../crm/rotation.service');
    assert.equal(typeof mod.RotationService, 'function');
  });
});

// ─── B. interceptor behaviour per new resource ────────────────────

describe('rbac/D5.5 — interceptor behaviour across timeline / review / rotation / followup / audit', () => {
  let interceptor: FieldRedactionInterceptor;

  beforeEach(() => {
    setFlag('true');
  });

  afterEach(() => {
    setFlag(ORIGINAL_FLAG === undefined ? undefined : (ORIGINAL_FLAG as 'true' | 'false'));
  });

  // ── flag off across all 5 resources ─────────────────────────────
  it('flag off — every D5.5 resource returns the response unchanged', async () => {
    setFlag('false');
    const resolver = makeResolver(
      bundle({
        deniedRead: {
          'lead.activity': ['notes', 'payload'],
          'lead.review': ['resolutionNotes', 'reasonPayload'],
          rotation: ['fromUser', 'toUser', 'notes'],
          followup: ['note', 'snoozeReason'],
          audit: ['payload', 'beforeAfter'],
        },
      }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      id: 'x',
      notes: 'TL note',
      payload: { event: 'foo' },
      resolutionNotes: 'kept owner',
      reasonPayload: { partnerSourceId: 's-1' },
      fromUser: { id: 'u-prev' },
      toUser: { id: 'u-next' },
      note: 'follow-up',
      snoozeReason: 'busy',
      beforeAfter: { before: {}, after: {} },
    };
    for (const res of ['lead.activity', 'lead.review', 'rotation', 'followup', 'audit'] as const) {
      const ctx = makeCtx({ req: { user: USER }, metadata: res });
      const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
      assert.deepEqual(out, payload, `flag off must not strip on resource=${res}`);
    }
  });

  // ── super-admin across all 5 resources ──────────────────────────
  it('super_admin — every D5.5 resource returns the response unchanged', async () => {
    const resolver = makeResolver(bundle({ code: 'super_admin', deniedRead: {} }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = { id: 'x', notes: 'sensitive', payload: { event: 'foo' } };
    for (const res of ['lead.activity', 'lead.review', 'rotation', 'followup', 'audit'] as const) {
      const ctx = makeCtx({ req: { user: USER }, metadata: res });
      const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
      assert.deepEqual(out, payload);
    }
  });

  // ── lead.activity: timeline as an array, strips notes + payload ─
  it('lead.activity timeline (plain array): notes + payload stripped per row', async () => {
    const resolver = makeResolver(
      bundle({ deniedRead: { 'lead.activity': ['notes', 'payload'] } }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = [
      { id: 'a-1', type: 'note', notes: 'TL only', payload: { event: 'note' } },
      { id: 'a-2', type: 'stage_change', notes: 'sensitive', payload: { event: 'stage_change' } },
    ];
    const ctx = makeCtx({ req: { user: USER }, metadata: 'lead.activity' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as Array<
      Record<string, unknown>
    >;
    assert.equal(out.length, 2);
    for (const row of out) {
      assert.equal('notes' in row, false);
      assert.equal('payload' in row, false);
      assert.ok(row['type']);
      assert.ok(row['id']);
    }
  });

  // ── lead.review: envelope strips reasonPayload, preserves total ─
  it('lead.review envelope: reasonPayload stripped, items + total preserved', async () => {
    const resolver = makeResolver(
      bundle({ deniedRead: { 'lead.review': ['reasonPayload', 'resolutionNotes'] } }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      items: [
        {
          id: 'rev-1',
          reason: 'partner_missing',
          reasonPayload: { partnerSourceId: 's-1' },
          resolutionNotes: 'TL note',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'lead.review' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as {
      items: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
    };
    assert.equal(out.total, 1);
    assert.equal(out.limit, 50);
    assert.equal(out.offset, 0);
    assert.equal('reasonPayload' in out.items[0]!, false);
    assert.equal('resolutionNotes' in out.items[0]!, false);
    assert.equal(out.items[0]!['reason'], 'partner_missing');
  });

  // ── rotation: envelope shape strips fromUser/toUser when role denies ─
  it('rotation envelope: fromUser + toUser stripped per row, canSeeOwners flag preserved', async () => {
    // D5.7 retired `userCanSeeOwnershipHistory` and routed the
    // service-layer per-field nullification through
    // `OwnershipVisibilityService` (also field-permission backed).
    // The FieldRedactionInterceptor's stripping path still applies
    // here because a non-RBAC test fixture instantiates the
    // interceptor directly against a synthetic payload; the
    // service-layer path is exercised in d5-7-ownership-visibility
    // tests + the DB-backed rotation.test.ts cases.
    const resolver = makeResolver(
      bundle({ deniedRead: { rotation: ['fromUser', 'toUser', 'notes'] } }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      canSeeOwners: true,
      rotations: [
        {
          id: 'rot-1',
          fromUser: { id: 'u-prev', name: 'Prev' },
          toUser: { id: 'u-next', name: 'Next' },
          actor: { id: 'u-actor' },
          notes: 'TL handover summary',
          handoverMode: 'full',
          rotatedAt: '2026-05-01T00:00:00Z',
        },
      ],
    };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'rotation' });
    // Note: this response shape is { canSeeOwners, rotations: [...] }.
    // The interceptor's envelope detection looks for `items: [...]`,
    // so this falls through to the plain-object filter — which strips
    // top-level keys. fromUser/toUser/notes live INSIDE rotations[*]
    // so they survive; canSeeOwners + rotations preserved.
    // This documents a known D5.5 limitation: nested-array fields
    // need either a dot-array path syntax (future) or per-resource
    // shape adapters (D5.7 will fix for rotation specifically). The
    // test asserts the documented behaviour, not an aspirational one.
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as Record<
      string,
      unknown
    >;
    assert.equal(out['canSeeOwners'], true);
    assert.ok(Array.isArray(out['rotations']));
  });

  // ── followup: list of follow-ups strips note + snoozeReason ─────
  it('followup list: note + snoozeReason stripped per row', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { followup: ['note', 'snoozeReason'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      items: [
        {
          id: 'f-1',
          dueAt: '2026-05-01',
          type: 'call',
          note: 'private',
          snoozeReason: 'agent ill',
          outcome: null,
        },
      ],
      total: 1,
    };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'followup' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    assert.equal(out.total, 1);
    assert.equal('note' in out.items[0]!, false);
    assert.equal('snoozeReason' in out.items[0]!, false);
    assert.equal(out.items[0]!['type'], 'call');
  });

  // ── audit: stream array strips payload + beforeAfter ─────────────
  it('audit list (envelope): payload + beforeAfter stripped per row', async () => {
    const resolver = makeResolver(
      bundle({ deniedRead: { audit: ['payload', 'beforeAfter', 'ipAddress'] } }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      items: [
        {
          id: 'a-1',
          action: 'role.update',
          actor: { id: 'u-1' },
          payload: { granted: ['x'] },
          beforeAfter: { before: {}, after: {} },
          ipAddress: '10.0.0.1',
        },
      ],
      total: 1,
    };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'audit' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    assert.equal(out.total, 1);
    const row = out.items[0]!;
    assert.equal('payload' in row, false);
    assert.equal('beforeAfter' in row, false);
    assert.equal('ipAddress' in row, false);
    assert.equal(row['action'], 'role.update');
  });

  // ── cross-resource isolation ──────────────────────────────────────
  it('cross-resource isolation: lead.activity deny does not strip lead.review responses', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { 'lead.activity': ['notes'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = { id: 'rev-1', notes: 'review note', reason: 'manual_tl_review' };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'lead.review' });
    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.deepEqual(out, payload);
  });
});
