/**
 * Phase D5 — D5.13: realtime + notification + audit leak closure.
 *
 * Pure unit tests covering:
 *
 *   A. RealtimeLeadAssigned envelope — `fromUserId` is the literal
 *      `null`. The type-level guarantee + the value-level emit both
 *      have to hold so a future emitter can't accidentally re-add
 *      the previous-owner identity through the realtime channel.
 *
 *   B. AUDIT_ACTION_GROUPS — `whatsapp_handover` chip is registered
 *      with the `whatsapp.handover.` prefix; `resolveActionPrefixes`
 *      resolves it; `listActionPrefixCodes` includes it. Code is
 *      snake_case and the prefix ends with a dot (D5.11 invariants).
 *
 *   C. WhatsAppVisibilityService.applyReviewRow — when the
 *      `whatsapp.conversation.internalMetadata` field permission is
 *      denied, the helper sets a top-level `internalMetadataHidden`
 *      boolean on the cloned review row so the review-card
 *      component can render a `<RedactedFieldBadge>` notice.
 *      Bypass / allowed roles do NOT carry the flag (cleaner UX —
 *      "no badge" means "nothing hidden").
 *
 * The cross-flow safety rule (server is the source of truth, the
 * realtime channel is a notification channel not a data channel)
 * is encoded in the type signature itself — `RealtimeLeadAssigned.fromUserId`
 * is typed as the literal `null`, so any future emitter that tries
 * to set `before.assignedToId ?? null` (the pre-D5.13 shape) fails
 * `pnpm typecheck` before the test even runs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_ACTION_GROUPS,
  listActionPrefixCodes,
  resolveActionPrefixes,
} from '../audit/audit-action-groups';
import { RealtimeService } from '../realtime/realtime.service';
import type { RealtimeEvent, RealtimeLeadAssigned } from '../realtime/realtime.types';
import type { DeniedReadFields, FieldFilterService } from './field-filter.service';
import type { ScopeUserClaims } from './scope-context.service';

import {
  WhatsAppVisibilityService,
  type ConversationVisibility,
  type WhatsAppTransferMode,
} from './whatsapp-visibility.service';

// ─── helpers ──────────────────────────────────────────────────────

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

// ════════════════════════════════════════════════════════════════
// A. RealtimeLeadAssigned envelope — fromUserId is always null
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.13 — RealtimeLeadAssigned envelope', () => {
  it('the typed envelope carries fromUserId: null (compile-time guarantee)', () => {
    // The cast itself proves the type contract: assigning anything
    // OTHER than `null` to `fromUserId` would fail tsc. The
    // runtime assertion is belt + suspenders.
    const ev: RealtimeLeadAssigned = {
      type: 'lead.assigned',
      leadId: 'l1',
      toUserId: 'u-recipient',
      fromUserId: null,
      reason: 'manual',
    };
    assert.equal(ev.fromUserId, null);
    assert.equal(ev.type, 'lead.assigned');
  });

  it('emit+subscribe end-to-end never carries a previous-owner identity', () => {
    const realtime = new RealtimeService();
    const captured: RealtimeEvent[] = [];
    realtime.subscribe('t-1', 'u-recipient', (ev) => captured.push(ev));

    // Emit one of each reason so we cover manual / auto / sla_breach.
    for (const reason of ['manual', 'auto', 'sla_breach'] as const) {
      realtime.emitToUser('t-1', 'u-recipient', {
        type: 'lead.assigned',
        leadId: `l-${reason}`,
        toUserId: 'u-recipient',
        fromUserId: null,
        reason,
      });
    }

    assert.equal(captured.length, 3);
    for (const ev of captured) {
      assert.equal(ev.type, 'lead.assigned');
      // The cast is safe inside the type-narrowing branch.
      const la = ev as RealtimeLeadAssigned;
      assert.equal(la.fromUserId, null, `reason=${la.reason} leaked a fromUserId`);
    }
  });

  it('does NOT deliver the event to a different user in the same tenant', () => {
    const realtime = new RealtimeService();
    const captured: RealtimeEvent[] = [];
    realtime.subscribe('t-1', 'u-other', (ev) => captured.push(ev));

    realtime.emitToUser('t-1', 'u-recipient', {
      type: 'lead.assigned',
      leadId: 'l1',
      toUserId: 'u-recipient',
      fromUserId: null,
      reason: 'manual',
    });

    assert.equal(captured.length, 0, 'lead.assigned must be user-scoped');
  });
});

// ════════════════════════════════════════════════════════════════
// B. AUDIT_ACTION_GROUPS — whatsapp_handover chip
// ════════════════════════════════════════════════════════════════

describe('audit/D5.13 — whatsapp_handover allow-list entry', () => {
  it('whatsapp_handover code is registered with the whatsapp.handover. prefix', () => {
    const entry = AUDIT_ACTION_GROUPS.find((g) => g.code === 'whatsapp_handover');
    assert.ok(entry, 'whatsapp_handover code missing from AUDIT_ACTION_GROUPS');
    assert.deepEqual(entry!.actionPrefixes, ['whatsapp.handover.']);
  });

  it('resolveActionPrefixes resolves whatsapp_handover', () => {
    assert.deepEqual(resolveActionPrefixes('whatsapp_handover'), ['whatsapp.handover.']);
  });

  it('listActionPrefixCodes contains whatsapp_handover', () => {
    assert.ok(listActionPrefixCodes().includes('whatsapp_handover'));
  });

  it('whatsapp_handover honours the D5.11 allow-list invariants (snake_case + dot suffix)', () => {
    const entry = AUDIT_ACTION_GROUPS.find((g) => g.code === 'whatsapp_handover')!;
    assert.match(entry.code, /^[a-z][a-z0-9_]*$/);
    for (const p of entry.actionPrefixes) {
      assert.ok(p.endsWith('.'), `prefix '${p}' must end with a dot`);
    }
  });

  it('does NOT collide with sibling stems (e.g. whatsapp.review.*)', () => {
    // The dot-terminated prefix is exactly what guards this. A
    // hypothetical `whatsapp.handover_review.foo` row would fail
    // the prefix match even though the human-readable verb sounds
    // similar — that is the property D5.11's "always trailing dot"
    // rule buys us.
    const ps = resolveActionPrefixes('whatsapp_handover')!;
    assert.equal(
      ps.some((p) => 'whatsapp.review.resolved'.startsWith(p)),
      false,
    );
    assert.equal(
      ps.some((p) => 'whatsapp.handover.completed'.startsWith(p)),
      true,
    );
  });
});

// ════════════════════════════════════════════════════════════════
// C. applyReviewRow — D5.13 internalMetadataHidden flag
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.13 — applyReviewRow internalMetadataHidden flag', () => {
  const svc = new WhatsAppVisibilityService(fakeFieldFilter({}));

  function row() {
    return {
      id: 'review-1',
      conversation: {
        id: 'conv-1',
        phone: '+201000000000',
        lastMessageText: 'hello',
        lastInboundAt: new Date('2026-04-01T00:00:00Z'),
        assignedToId: 'agent-prev',
        assignedAt: new Date('2026-04-01T01:00:00Z'),
        assignmentSource: 'manual_handover',
      },
    };
  }

  const FULL_TRANSFER: WhatsAppTransferMode = 'full';

  it('sets internalMetadataHidden=true when internalMetadata is denied', () => {
    const v = buildVisibility({ denied: ['internalMetadata'] });
    const out = svc.applyReviewRow(row(), v, FULL_TRANSFER);
    assert.equal(out.internalMetadataHidden, true);
    // Side effect — the embedded conversation has both fields nulled.
    assert.equal(out.conversation!.assignedToId, null);
    assert.equal(out.conversation!.assignmentSource, null);
  });

  it('omits internalMetadataHidden when internalMetadata is allowed', () => {
    const v = buildVisibility({ denied: [] });
    const out = svc.applyReviewRow(row(), v, FULL_TRANSFER);
    assert.equal(out.internalMetadataHidden, undefined);
    // Embedded conversation passes through.
    assert.equal(out.conversation!.assignedToId, 'agent-prev');
    assert.equal(out.conversation!.assignmentSource, 'manual_handover');
  });

  it('omits internalMetadataHidden on super-admin bypass', () => {
    const v = buildVisibility({ bypassed: true });
    const out = svc.applyReviewRow(row(), v, FULL_TRANSFER);
    assert.equal(out.internalMetadataHidden, undefined);
    assert.equal(out.conversation!.assignedToId, 'agent-prev');
  });

  it('does not mutate the input row', () => {
    const v = buildVisibility({ denied: ['internalMetadata'] });
    const input = row();
    const before = JSON.stringify(input);
    svc.applyReviewRow(input, v, FULL_TRANSFER);
    assert.equal(JSON.stringify(input), before, 'applyReviewRow must be pure');
  });

  it('preserves the lastInboundAt operational field across the redaction', () => {
    const v = buildVisibility({ denied: ['internalMetadata'] });
    const out = svc.applyReviewRow(row(), v, FULL_TRANSFER);
    // Operational context — TL needs to see when the customer
    // last replied even when the prior-agent identity is hidden.
    assert.ok(out.conversation!.lastInboundAt instanceof Date);
  });
});
