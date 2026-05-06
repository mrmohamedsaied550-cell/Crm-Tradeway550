/**
 * Phase D5 — D5.11: audit governance filter surface.
 *
 * Pure unit tests covering:
 *
 *   A. AUDIT_ACTION_GROUPS allow-list — every code is unique and
 *      maps to a non-empty list of dot-terminated prefixes.
 *
 *   B. resolveActionPrefixes — known codes return prefix lists;
 *      unknown codes return undefined.
 *
 *   C. AuditController validation — unknown actionPrefix code is
 *      rejected with `audit.action_prefix.unknown` carrying the
 *      allowed-codes list. Known code is forwarded to the service
 *      with the resolved prefix array.
 *
 *   D. AuditController entityId pass-through — string is trimmed
 *      and forwarded; empty / whitespace strings drop.
 *
 *   E. Action-groups endpoint shape — returns every allow-list
 *      entry with the documented `{ code, actionPrefixes }` shape.
 *
 * The service-layer query construction lives behind Prisma; the
 * DB-backed assertion runs in `audit.test.ts` against Postgres.
 * This file exercises the validation + dispatch surface that
 * D5.11 actually changes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';

import { AuditController } from './audit.controller';
import {
  AUDIT_ACTION_GROUPS,
  listActionPrefixCodes,
  resolveActionPrefixes,
} from './audit-action-groups';
import type { AuditService } from './audit.service';

// ─── helpers ──────────────────────────────────────────────────────

function buildController(): {
  controller: AuditController;
  calls: Array<Parameters<AuditService['list']>[0]>;
} {
  const calls: Array<Parameters<AuditService['list']>[0]> = [];
  const fakeService = {
    list: async (opts: Parameters<AuditService['list']>[0] = {}) => {
      calls.push(opts);
      return [];
    },
  } as unknown as AuditService;
  return { controller: new AuditController(fakeService), calls };
}

// ════════════════════════════════════════════════════════════════
// A. allow-list shape
// ════════════════════════════════════════════════════════════════

describe('audit/D5.11 — AUDIT_ACTION_GROUPS', () => {
  it('every code is unique', () => {
    const seen = new Set<string>();
    for (const g of AUDIT_ACTION_GROUPS) {
      assert.equal(seen.has(g.code), false, `duplicate code '${g.code}'`);
      seen.add(g.code);
    }
  });

  it('every code is snake_case (no dots, no wildcards)', () => {
    for (const g of AUDIT_ACTION_GROUPS) {
      assert.match(
        g.code,
        /^[a-z][a-z0-9_]*$/,
        `code '${g.code}' must be snake_case (server uses it for the safe lookup)`,
      );
    }
  });

  it('every actionPrefix ends with a dot (avoids sibling stem collisions)', () => {
    for (const g of AUDIT_ACTION_GROUPS) {
      assert.ok(g.actionPrefixes.length > 0, `code '${g.code}' has no prefixes`);
      for (const p of g.actionPrefixes) {
        assert.ok(p.endsWith('.'), `prefix '${p}' (group '${g.code}') must end with a dot`);
      }
    }
  });

  it('contains the chips D5.11 ships (rbac / role / user_scope / *_export / export_governance)', () => {
    const codes = new Set(AUDIT_ACTION_GROUPS.map((g) => g.code));
    for (const c of [
      'rbac',
      'role',
      'user_scope',
      'tenant_export',
      'report_export',
      'partner_recon_export',
      'partner_commission_export',
      'export_governance',
    ]) {
      assert.ok(codes.has(c), `missing required allow-list code '${c}'`);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// B. resolveActionPrefixes
// ════════════════════════════════════════════════════════════════

describe('audit/D5.11 — resolveActionPrefixes', () => {
  it('returns the prefix list for a known code', () => {
    assert.deepEqual(resolveActionPrefixes('rbac'), ['rbac.']);
    assert.deepEqual(resolveActionPrefixes('tenant_export'), ['tenant.export.']);
  });

  it('returns undefined for unknown / empty / whitespace input', () => {
    assert.equal(resolveActionPrefixes(undefined), undefined);
    assert.equal(resolveActionPrefixes(''), undefined);
    assert.equal(resolveActionPrefixes('lead.*'), undefined);
    assert.equal(resolveActionPrefixes('rbac.role.previewed'), undefined);
    assert.equal(resolveActionPrefixes('arbitrary.dangerous.prefix'), undefined);
  });

  it('export_governance umbrella OR-fans-out to four governance prefixes', () => {
    const list = resolveActionPrefixes('export_governance')!;
    for (const p of [
      'tenant.export.',
      'report.export.',
      'partner.reconciliation.export.',
      'partner.commission.export.',
    ]) {
      assert.ok(list.includes(p), `umbrella missing prefix '${p}'`);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// C. AuditController validation
// ════════════════════════════════════════════════════════════════

// D5.12-B: AuditController.list now takes `@CurrentUser()` as the
// first argument so the WhatsApp handover-payload redactor can
// resolve the caller's whatsapp.conversation deny list. Tests
// pass a fake claims envelope.
const FAKE_USER = {
  typ: 'access' as const,
  sub: 'u-1',
  tid: 't-1',
  rid: 'r-1',
};

describe('audit/D5.11 — AuditController', () => {
  it('forwards a known actionPrefix as the resolved prefix array', async () => {
    const { controller, calls } = buildController();
    await controller.list(FAKE_USER, undefined, undefined, undefined, 'rbac');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.actionPrefixes, ['rbac.']);
    assert.equal(calls[0]!.action, undefined);
  });

  it('forwards an umbrella actionPrefix as the multi-prefix array', async () => {
    const { controller, calls } = buildController();
    await controller.list(FAKE_USER, undefined, undefined, undefined, 'export_governance');
    assert.equal(calls.length, 1);
    const ps = calls[0]!.actionPrefixes!;
    assert.ok(ps.length >= 4);
    assert.ok(ps.includes('tenant.export.'));
    assert.ok(ps.includes('report.export.'));
  });

  it('rejects an unknown actionPrefix with audit.action_prefix.unknown', async () => {
    const { controller } = buildController();
    let thrown: BadRequestException | null = null;
    try {
      await controller.list(FAKE_USER, undefined, undefined, undefined, 'arbitrary.prefix');
    } catch (err) {
      thrown = err as BadRequestException;
    }
    assert.ok(thrown);
    const response = thrown!.getResponse() as {
      code: string;
      message: string;
      allowedCodes: string[];
    };
    assert.equal(response.code, 'audit.action_prefix.unknown');
    assert.match(response.message, /Allowed codes/);
    assert.deepEqual(response.allowedCodes, [...listActionPrefixCodes()]);
  });

  it('treats an empty / whitespace actionPrefix as absent (no validation, no filter)', async () => {
    const { controller, calls } = buildController();
    await controller.list(FAKE_USER, undefined, undefined, undefined, '   ');
    assert.equal(calls[0]!.actionPrefixes, undefined);
  });

  it('still accepts the legacy `action` exact + wildcard filter', async () => {
    const { controller, calls } = buildController();
    await controller.list(FAKE_USER, undefined, undefined, 'lead.rotated');
    assert.equal(calls[0]!.action, 'lead.rotated');
    assert.equal(calls[0]!.actionPrefixes, undefined);
  });

  it('accepts both action and actionPrefix simultaneously (service ANDs them)', async () => {
    const { controller, calls } = buildController();
    await controller.list(FAKE_USER, undefined, undefined, 'lead.rotated', 'rbac');
    assert.equal(calls[0]!.action, 'lead.rotated');
    assert.deepEqual(calls[0]!.actionPrefixes, ['rbac.']);
  });

  it('forwards a trimmed entityId', async () => {
    const { controller, calls } = buildController();
    await controller.list(FAKE_USER, undefined, undefined, undefined, undefined, '  role-1  ');
    assert.equal(calls[0]!.entityId, 'role-1');
  });

  it('drops empty / whitespace entityId', async () => {
    const { controller, calls } = buildController();
    await controller.list(FAKE_USER, undefined, undefined, undefined, undefined, '   ');
    assert.equal(calls[0]!.entityId, undefined);
  });

  it('forwards the calling claims as userClaims', async () => {
    const { controller, calls } = buildController();
    await controller.list(FAKE_USER);
    assert.deepEqual(calls[0]!.userClaims, { userId: 'u-1', tenantId: 't-1', roleId: 'r-1' });
  });
});

// ════════════════════════════════════════════════════════════════
// D. action-groups endpoint
// ════════════════════════════════════════════════════════════════

describe('audit/D5.11 — listActionGroups endpoint', () => {
  it('returns one entry per allow-list group', async () => {
    const { controller } = buildController();
    const out = controller.listActionGroups();
    assert.equal(out.groups.length, AUDIT_ACTION_GROUPS.length);
  });

  it('every entry carries `code` + `actionPrefixes` and nothing else', async () => {
    const { controller } = buildController();
    const out = controller.listActionGroups();
    for (const g of out.groups) {
      assert.equal(typeof g.code, 'string');
      assert.ok(Array.isArray(g.actionPrefixes));
      assert.deepEqual(Object.keys(g).sort(), ['actionPrefixes', 'code']);
    }
  });

  it('payload is metadata only — no audit row VALUES leak', async () => {
    const { controller } = buildController();
    const out = controller.listActionGroups();
    const blob = JSON.stringify(out);
    // No PII / row-shaped values can enter — the response is
    // structural prefix metadata.
    assert.equal(blob.includes('+201'), false);
    assert.equal(blob.includes('@'), false);
  });
});
