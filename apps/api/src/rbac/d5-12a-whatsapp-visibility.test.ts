/**
 * Phase D5 — D5.12-A: WhatsApp conversation visibility governance.
 *
 * Pure unit tests covering:
 *
 *   A. resolveConversationVisibility — flat boolean projection
 *      derived from `whatsapp.conversation` field-permission deny
 *      rows; super-admin bypass.
 *
 *   B. resolveTransferMode — reads the most recent
 *      `LeadActivity` row of `type='assignment'` with
 *      `payload.event='whatsapp_handover'` matching the
 *      conversation id, returns 'full' / 'summary' / 'clean' /
 *      'unknown'.
 *
 *   C. shouldHidePriorMessages — the strict-rule-wins gate:
 *        — super-admin bypass → never hide.
 *        — clean transfer    → always hide (overrides field perm).
 *        — summary transfer  → always hide.
 *        — full transfer     → field permission decides.
 *        — unknown           → field permission decides.
 *
 *   D. applyConversationListRow — list-shape redactor:
 *        — when prior messages must be hidden AND
 *          `lastMessageAt < assignedAt`, `lastMessageText`
 *          becomes null.
 *        — when `internalMetadata` denied, `assignmentSource`
 *          becomes null and `assignedTo.email` is dropped.
 *
 *   E. applyConversationDetailRow — detail-shape redactor; same
 *      column-level rules plus three top-level boolean flags
 *      (priorMessagesHidden / handoverChainHidden / historyHidden).
 *
 *   F. applyMessageList — DB-cutoff helper; bypass returns input
 *      unchanged; null `assignedAt` returns input unchanged
 *      (inbound-routed conversation has no handover anchor); when
 *      hidden, returns only messages with `createdAt >=
 *      assignedAt`. Row count is reduced — never faked.
 *
 *   G. Default deny rows — the seed/migration `D5_7_OWNERSHIP_HISTORY_DENIES`
 *      lists every D5.12-A whatsapp.conversation field for the
 *      agent cohort.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';

import type { DeniedReadFields, FieldFilterService } from './field-filter.service';
import type { ScopeUserClaims } from './scope-context.service';
import {
  WhatsAppVisibilityService,
  type ConversationVisibility,
  type WhatsAppTransferMode,
} from './whatsapp-visibility.service';

// ─── helpers ──────────────────────────────────────────────────────

const CLAIMS: ScopeUserClaims = { tenantId: 't1', userId: 'u1', roleId: 'r1' };

function fakeFieldFilter(byResource: Record<string, DeniedReadFields>): FieldFilterService {
  return {
    listDeniedReadFields: async (_claims: ScopeUserClaims, resource: string) => {
      return byResource[resource] ?? { bypassed: false, paths: [] };
    },
  } as unknown as FieldFilterService;
}

function buildVisibility(opts: {
  bypassed?: boolean;
  denied?: readonly string[];
}): ConversationVisibility {
  if (opts.bypassed) {
    return {
      canReadPriorAgentMessages: true,
      canReadHandoverChain: true,
      canReadHandoverSummary: true,
      canReadConversationHistory: true,
      canReadReviewNotes: true,
      canReadInternalMetadata: true,
      bypassedFieldPermissions: true,
    };
  }
  const set = new Set(opts.denied ?? []);
  return {
    canReadPriorAgentMessages: !set.has('priorAgentMessages'),
    canReadHandoverChain: !set.has('handoverChain'),
    canReadHandoverSummary: !set.has('handoverSummary'),
    canReadConversationHistory: !set.has('conversationHistory'),
    canReadReviewNotes: !set.has('reviewNotes'),
    canReadInternalMetadata: !set.has('internalMetadata'),
    bypassedFieldPermissions: false,
  };
}

/**
 * Synthetic Prisma transaction client that returns the supplied
 * `LeadActivity` row from `findFirst`. Only the
 * `tx.leadActivity.findFirst` shape is exercised by
 * `resolveTransferMode`.
 */
function fakeTx(
  latestActivity: {
    payload: Prisma.JsonValue;
  } | null,
): Prisma.TransactionClient {
  return {
    leadActivity: {
      findFirst: async () => latestActivity,
    },
  } as unknown as Prisma.TransactionClient;
}

// ════════════════════════════════════════════════════════════════
// A. resolveConversationVisibility
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.12-A — resolveConversationVisibility', () => {
  it('super-admin bypass → every flag visible', async () => {
    const svc = new WhatsAppVisibilityService(
      fakeFieldFilter({ 'whatsapp.conversation': { bypassed: true, paths: [] } }),
    );
    const v = await svc.resolveConversationVisibility(CLAIMS);
    assert.equal(v.canReadPriorAgentMessages, true);
    assert.equal(v.canReadHandoverChain, true);
    assert.equal(v.canReadHandoverSummary, true);
    assert.equal(v.canReadConversationHistory, true);
    assert.equal(v.canReadReviewNotes, true);
    assert.equal(v.canReadInternalMetadata, true);
    assert.equal(v.bypassedFieldPermissions, true);
  });

  it('empty deny list → every flag visible (default allow)', async () => {
    const svc = new WhatsAppVisibilityService(
      fakeFieldFilter({ 'whatsapp.conversation': { bypassed: false, paths: [] } }),
    );
    const v = await svc.resolveConversationVisibility(CLAIMS);
    assert.equal(v.canReadPriorAgentMessages, true);
    assert.equal(v.bypassedFieldPermissions, false);
  });

  it('agent-cohort defaults flip the four denied flags only', async () => {
    const svc = new WhatsAppVisibilityService(
      fakeFieldFilter({
        'whatsapp.conversation': {
          bypassed: false,
          paths: ['handoverChain', 'priorAgentMessages', 'reviewNotes', 'internalMetadata'],
        },
      }),
    );
    const v = await svc.resolveConversationVisibility(CLAIMS);
    assert.equal(v.canReadHandoverChain, false);
    assert.equal(v.canReadPriorAgentMessages, false);
    assert.equal(v.canReadReviewNotes, false);
    assert.equal(v.canReadInternalMetadata, false);
    // handoverSummary + conversationHistory remain visible for the
    // agent-cohort defaults so the read-path transfer-mode floor
    // is the actual gate.
    assert.equal(v.canReadHandoverSummary, true);
    assert.equal(v.canReadConversationHistory, true);
  });
});

// ════════════════════════════════════════════════════════════════
// B. resolveTransferMode
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.12-A — resolveTransferMode', () => {
  const svc = new WhatsAppVisibilityService(fakeFieldFilter({}));

  it('returns "unknown" when the conversation has no linked lead', async () => {
    const mode = await svc.resolveTransferMode(fakeTx(null), {
      id: 'conv-1',
      leadId: null,
      assignmentSource: 'manual_handover',
    });
    assert.equal(mode, 'unknown');
  });

  it('returns "unknown" when assignmentSource is not manual_handover', async () => {
    const mode = await svc.resolveTransferMode(fakeTx(null), {
      id: 'conv-1',
      leadId: 'lead-1',
      assignmentSource: 'inbound_route',
    });
    assert.equal(mode, 'unknown');
  });

  it('returns "unknown" when no handover activity exists', async () => {
    const mode = await svc.resolveTransferMode(fakeTx(null), {
      id: 'conv-1',
      leadId: 'lead-1',
      assignmentSource: 'manual_handover',
    });
    assert.equal(mode, 'unknown');
  });

  it('returns the activity payload mode for "full" handover', async () => {
    const mode = await svc.resolveTransferMode(
      fakeTx({
        payload: { event: 'whatsapp_handover', conversationId: 'conv-1', mode: 'full' },
      }),
      { id: 'conv-1', leadId: 'lead-1', assignmentSource: 'manual_handover' },
    );
    assert.equal(mode, 'full');
  });

  it('returns "summary" / "clean" verbatim from the payload', async () => {
    for (const target of ['summary', 'clean'] as const) {
      const mode = await svc.resolveTransferMode(
        fakeTx({
          payload: { event: 'whatsapp_handover', conversationId: 'conv-1', mode: target },
        }),
        { id: 'conv-1', leadId: 'lead-1', assignmentSource: 'manual_handover' },
      );
      assert.equal(mode, target);
    }
  });

  it('returns "unknown" when the activity belongs to a sibling conversation', async () => {
    const mode = await svc.resolveTransferMode(
      fakeTx({
        payload: { event: 'whatsapp_handover', conversationId: 'OTHER', mode: 'full' },
      }),
      { id: 'conv-1', leadId: 'lead-1', assignmentSource: 'manual_handover' },
    );
    assert.equal(mode, 'unknown');
  });

  it('returns "unknown" for a payload with an unknown mode value', async () => {
    const mode = await svc.resolveTransferMode(
      fakeTx({
        payload: {
          event: 'whatsapp_handover',
          conversationId: 'conv-1',
          mode: 'arbitrary',
        },
      }),
      { id: 'conv-1', leadId: 'lead-1', assignmentSource: 'manual_handover' },
    );
    assert.equal(mode, 'unknown');
  });
});

// ════════════════════════════════════════════════════════════════
// C. shouldHidePriorMessages — strict-rule-wins matrix
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.12-A — shouldHidePriorMessages', () => {
  const svc = new WhatsAppVisibilityService(fakeFieldFilter({}));

  function check(
    visibility: ConversationVisibility,
    mode: WhatsAppTransferMode,
    expected: boolean,
    note?: string,
  ): void {
    assert.equal(svc.shouldHidePriorMessages(visibility, mode), expected, note);
  }

  it('super-admin bypass → never hides, even on clean transfer', () => {
    check(buildVisibility({ bypassed: true }), 'clean', false, 'super-admin sees clean transfer');
    check(buildVisibility({ bypassed: true }), 'full', false, 'super-admin sees full transfer');
    check(buildVisibility({ bypassed: true }), 'unknown', false, 'super-admin sees inbound');
  });

  it('clean transfer → always hides for non-super-admin, regardless of field permission', () => {
    check(buildVisibility({}), 'clean', true, 'agent w/ allow-by-default still blocked');
    check(
      buildVisibility({ denied: ['priorAgentMessages'] }),
      'clean',
      true,
      'agent w/ deny still blocked',
    );
  });

  it('summary transfer → always hides for non-super-admin', () => {
    check(buildVisibility({}), 'summary', true, 'summary mode hides prior messages');
    check(buildVisibility({ denied: ['priorAgentMessages'] }), 'summary', true);
  });

  it('full transfer → field permission decides', () => {
    check(buildVisibility({}), 'full', false, 'full + allow → visible');
    check(
      buildVisibility({ denied: ['priorAgentMessages'] }),
      'full',
      true,
      'full + deny → hidden',
    );
  });

  it('unknown mode (no handover) → field permission decides', () => {
    check(buildVisibility({}), 'unknown', false);
    check(buildVisibility({ denied: ['priorAgentMessages'] }), 'unknown', true);
  });
});

// ════════════════════════════════════════════════════════════════
// D. applyConversationListRow
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.12-A — applyConversationListRow', () => {
  const svc = new WhatsAppVisibilityService(fakeFieldFilter({}));

  function row(opts: {
    lastMessageAt: string;
    lastMessageText: string;
    assignedAt: string | null;
    assignmentSource: string | null;
  }) {
    return {
      id: 'conv-1',
      lastMessageAt: opts.lastMessageAt,
      lastMessageText: opts.lastMessageText,
      assignedAt: opts.assignedAt,
      assignmentSource: opts.assignmentSource,
      assignedTo: { id: 'u-1', name: 'Alice', email: 'alice@example.test', teamId: 't1' },
    };
  }

  it('lastMessageText nulled when prior preview AND priorAgentMessages denied', () => {
    const out = svc.applyConversationListRow(
      row({
        lastMessageAt: '2026-05-01T10:00:00Z',
        lastMessageText: 'prior chat',
        assignedAt: '2026-05-02T00:00:00Z',
        assignmentSource: 'manual_handover',
      }),
      buildVisibility({ denied: ['priorAgentMessages', 'internalMetadata'] }),
      'full',
    );
    assert.equal(out.lastMessageText, null);
  });

  it('lastMessageText survives when preview is AFTER assignedAt', () => {
    const out = svc.applyConversationListRow(
      row({
        lastMessageAt: '2026-05-03T10:00:00Z',
        lastMessageText: 'recent chat',
        assignedAt: '2026-05-02T00:00:00Z',
        assignmentSource: 'manual_handover',
      }),
      buildVisibility({ denied: ['priorAgentMessages'] }),
      'full',
    );
    assert.equal(out.lastMessageText, 'recent chat');
  });

  it('lastMessageText nulled on clean transfer regardless of field permission', () => {
    const out = svc.applyConversationListRow(
      row({
        lastMessageAt: '2026-05-01T10:00:00Z',
        lastMessageText: 'prior chat',
        assignedAt: '2026-05-02T00:00:00Z',
        assignmentSource: 'manual_handover',
      }),
      // Allow path open; clean still hides.
      buildVisibility({}),
      'clean',
    );
    assert.equal(out.lastMessageText, null);
  });

  it('assignmentSource nulled when internalMetadata denied', () => {
    const out = svc.applyConversationListRow(
      row({
        lastMessageAt: '2026-05-03T10:00:00Z',
        lastMessageText: 'recent',
        assignedAt: '2026-05-02T00:00:00Z',
        assignmentSource: 'manual_handover',
      }),
      buildVisibility({ denied: ['internalMetadata'] }),
      'full',
    );
    assert.equal(out.assignmentSource, null);
  });

  it('assignedTo.email dropped when internalMetadata denied; name preserved', () => {
    const out = svc.applyConversationListRow(
      row({
        lastMessageAt: '2026-05-03T10:00:00Z',
        lastMessageText: 'recent',
        assignedAt: '2026-05-02T00:00:00Z',
        assignmentSource: 'manual_handover',
      }),
      buildVisibility({ denied: ['internalMetadata'] }),
      'full',
    );
    assert.equal(
      'email' in (out.assignedTo as Record<string, unknown>),
      false,
      'email key dropped',
    );
    assert.equal(out.assignedTo!.name, 'Alice');
  });

  it('does not mutate the input row', () => {
    const original = row({
      lastMessageAt: '2026-05-01T10:00:00Z',
      lastMessageText: 'prior chat',
      assignedAt: '2026-05-02T00:00:00Z',
      assignmentSource: 'manual_handover',
    });
    const before = JSON.stringify(original);
    svc.applyConversationListRow(
      original,
      buildVisibility({ denied: ['priorAgentMessages', 'internalMetadata'] }),
      'clean',
    );
    assert.equal(JSON.stringify(original), before, 'redactor mutated input');
  });
});

// ════════════════════════════════════════════════════════════════
// E. applyConversationDetailRow — top-level safety flags
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.12-A — applyConversationDetailRow', () => {
  const svc = new WhatsAppVisibilityService(fakeFieldFilter({}));

  function row() {
    return {
      id: 'conv-1',
      lastMessageAt: '2026-05-01T10:00:00Z',
      lastMessageText: 'prior chat',
      assignedAt: '2026-05-02T00:00:00Z',
      assignmentSource: 'manual_handover',
      assignedTo: { id: 'u-1', name: 'Alice', email: 'alice@example.test', teamId: 't1' },
    };
  }

  it('priorMessagesHidden true under clean transfer', () => {
    const out = svc.applyConversationDetailRow(row(), buildVisibility({}), 'clean');
    assert.equal(out.priorMessagesHidden, true);
    assert.equal(out.handoverChainHidden, false);
    assert.equal(out.historyHidden, true);
  });

  it('handoverChainHidden true when role denies handoverChain', () => {
    const out = svc.applyConversationDetailRow(
      row(),
      buildVisibility({ denied: ['handoverChain'] }),
      'unknown',
    );
    assert.equal(out.handoverChainHidden, true);
    assert.equal(out.priorMessagesHidden, false);
  });

  it('historyHidden true when conversationHistory denied', () => {
    const out = svc.applyConversationDetailRow(
      row(),
      buildVisibility({ denied: ['conversationHistory'] }),
      'full',
    );
    assert.equal(out.historyHidden, true);
  });

  it('all flags false when role is super-admin', () => {
    const out = svc.applyConversationDetailRow(row(), buildVisibility({ bypassed: true }), 'clean');
    assert.equal(out.priorMessagesHidden, false);
    assert.equal(out.handoverChainHidden, false);
    assert.equal(out.historyHidden, false);
  });
});

// ════════════════════════════════════════════════════════════════
// F. applyMessageList — DB-cutoff helper
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.12-A — applyMessageList', () => {
  const svc = new WhatsAppVisibilityService(fakeFieldFilter({}));

  const messages = [
    { createdAt: '2026-05-01T10:00:00Z', text: 'prior 1' },
    { createdAt: '2026-05-01T11:00:00Z', text: 'prior 2' },
    { createdAt: '2026-05-02T09:00:00Z', text: 'after 1' },
    { createdAt: '2026-05-03T08:00:00Z', text: 'after 2' },
  ];

  it('super-admin → returns input unchanged', () => {
    const out = svc.applyMessageList(messages, buildVisibility({ bypassed: true }), 'clean', {
      assignedAt: '2026-05-02T00:00:00Z',
    });
    assert.equal(out.length, 4);
  });

  it('full + allow → returns input unchanged', () => {
    const out = svc.applyMessageList(messages, buildVisibility({}), 'full', {
      assignedAt: '2026-05-02T00:00:00Z',
    });
    assert.equal(out.length, 4);
  });

  it('clean → returns only messages at/after assignedAt; row count reduced', () => {
    const out = svc.applyMessageList(messages, buildVisibility({}), 'clean', {
      assignedAt: '2026-05-02T00:00:00Z',
    });
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((m) => m.text),
      ['after 1', 'after 2'],
    );
  });

  it('full + deny priorAgentMessages → cuts off at assignedAt', () => {
    const out = svc.applyMessageList(
      messages,
      buildVisibility({ denied: ['priorAgentMessages'] }),
      'full',
      { assignedAt: '2026-05-02T00:00:00Z' },
    );
    assert.equal(out.length, 2);
  });

  it('null assignedAt (inbound-routed conversation) → no cutoff applied', () => {
    const out = svc.applyMessageList(messages, buildVisibility({}), 'clean', {
      assignedAt: null,
    });
    assert.equal(out.length, 4);
  });

  it('row count reduction is real — no placeholders are inserted', () => {
    const out = svc.applyMessageList(messages, buildVisibility({}), 'clean', {
      assignedAt: '2026-05-02T00:00:00Z',
    });
    for (const m of out) {
      assert.equal(typeof m.text, 'string');
      assert.notEqual(m.text, null);
      assert.notEqual(m.text, '');
    }
  });
});

// ════════════════════════════════════════════════════════════════
// G. Default deny rows — seed list contract
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.12-A — seed default deny rows', () => {
  it('the four whatsapp.conversation deny rows are in the agent-cohort seed list', async () => {
    // Read the seed source to assert the registry includes the
    // D5.12-A defaults. We prefer this over a runtime DB lookup so
    // the test runs without Postgres.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const seedPath = path.resolve(
      // Locate via __dirname-equivalent under tsx — `import.meta.url`
      // would need to be set up; use the workspace-relative path
      // instead. Test runs from `apps/api` cwd.
      process.cwd(),
      'prisma',
      'seed.ts',
    );
    const source = await fs.readFile(seedPath, 'utf8');
    for (const field of [
      'handoverChain',
      'priorAgentMessages',
      'reviewNotes',
      'internalMetadata',
    ]) {
      assert.ok(
        source.includes(`'whatsapp.conversation', '${field}'`),
        `seed must list whatsapp.conversation/${field} as a default deny`,
      );
    }
  });

  it('the migration installs deny rows ON CONFLICT DO NOTHING (idempotent)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const migrationPath = path.resolve(
      process.cwd(),
      'prisma',
      'migrations',
      '20260620000000_0042_d5_12_whatsapp_visibility',
      'migration.sql',
    );
    const source = await fs.readFile(migrationPath, 'utf8');
    assert.match(source, /ON CONFLICT \("role_id", "resource", "field"\) DO NOTHING/);
    for (const field of [
      'handoverChain',
      'priorAgentMessages',
      'reviewNotes',
      'internalMetadata',
    ]) {
      assert.ok(
        source.includes(`'${field}'`),
        `migration must install whatsapp.conversation/${field}`,
      );
    }
    assert.match(source, /sales_agent.*activation_agent.*driving_agent/s);
  });
});
