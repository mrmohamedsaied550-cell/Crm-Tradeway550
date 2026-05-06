/**
 * Phase D5 — D5.12-B: WhatsApp review queue + timeline visibility.
 *
 * Pure unit tests for three D5.12-B redaction methods on
 * `WhatsAppVisibilityService`:
 *
 *   A. applyReviewRow — list / detail row redactor for the TL
 *      Review Queue. Strips `assignedToId` / `assignmentSource`
 *      when `internalMetadata` denied; nulls
 *      `conversation.lastMessageText` when the preview predates
 *      the handover `assignedAt` AND the strict-rule-wins gate
 *      says hide.
 *
 *   B. applyActivityList / applyActivityRow — `LeadActivity`
 *      timeline redactor. Surgical strip of well-known WhatsApp
 *      handover sub-keys (`fromUserId` / `toUserId` / `summary`)
 *      on `whatsapp_handover` + `whatsapp_handover_summary`
 *      payloads. Non-WhatsApp rows pass through unchanged.
 *
 *   C. applyAuditRowPayload — unified audit feed redactor.
 *      The audit pipeline merges `LeadActivity.body` into
 *      `payload.body`; the redactor nulls that key alongside
 *      structured `summary` when `handoverSummary` denied.
 *
 *   D. Cross-flow safety — non-WhatsApp activity payloads pass
 *      through untouched; super-admin bypass returns input
 *      unchanged on every method; row count preserved everywhere.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DeniedReadFields, FieldFilterService } from './field-filter.service';
import type { ScopeUserClaims } from './scope-context.service';
import {
  WhatsAppVisibilityService,
  type ConversationVisibility,
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

const svc = new WhatsAppVisibilityService(fakeFieldFilter({}));

// ════════════════════════════════════════════════════════════════
// A. applyReviewRow — TL Review Queue list/detail redactor
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.12-B — applyReviewRow', () => {
  function reviewRow() {
    return {
      id: 'rev-1',
      reason: 'orphan',
      conversation: {
        id: 'conv-1',
        phone: '+201005551234',
        lastMessageText: 'hello prior agent',
        lastInboundAt: '2026-05-01T10:00:00Z',
        assignedToId: 'u-prev',
        assignedAt: '2026-05-02T00:00:00Z',
        assignmentSource: 'manual_handover',
      },
    };
  }

  it('agent-cohort defaults — internalMetadata denied → assignedToId + assignmentSource nulled', () => {
    const out = svc.applyReviewRow(
      reviewRow(),
      buildVisibility({
        denied: ['handoverChain', 'priorAgentMessages', 'reviewNotes', 'internalMetadata'],
      }),
      'unknown',
    );
    assert.equal(out.conversation!.assignedToId, null);
    assert.equal(out.conversation!.assignmentSource, null);
  });

  it('priorMessagesHidden + lastInboundAt < assignedAt → lastMessageText nulled', () => {
    const out = svc.applyReviewRow(
      reviewRow(),
      buildVisibility({ denied: ['priorAgentMessages', 'internalMetadata'] }),
      'full',
    );
    assert.equal(out.conversation!.lastMessageText, null);
  });

  it('clean transfer overrides field perm — lastMessageText nulled even when allowed', () => {
    const out = svc.applyReviewRow(reviewRow(), buildVisibility({}), 'clean');
    assert.equal(out.conversation!.lastMessageText, null);
  });

  it('full transfer + allow → lastMessageText survives', () => {
    const out = svc.applyReviewRow(reviewRow(), buildVisibility({}), 'full');
    assert.equal(out.conversation!.lastMessageText, 'hello prior agent');
  });

  it('super-admin bypass → row unchanged', () => {
    const out = svc.applyReviewRow(reviewRow(), buildVisibility({ bypassed: true }), 'clean');
    assert.equal(out.conversation!.lastMessageText, 'hello prior agent');
    assert.equal(out.conversation!.assignedToId, 'u-prev');
    assert.equal(out.conversation!.assignmentSource, 'manual_handover');
  });

  it('does not mutate the input row', () => {
    const original = reviewRow();
    const before = JSON.stringify(original);
    svc.applyReviewRow(
      original,
      buildVisibility({ denied: ['internalMetadata', 'priorAgentMessages'] }),
      'clean',
    );
    assert.equal(JSON.stringify(original), before, 'redactor mutated input');
  });

  it('null conversation → no error, returns input shape', () => {
    const row = { id: 'rev-1', reason: 'orphan', conversation: null };
    const out = svc.applyReviewRow(row, buildVisibility({}), 'unknown');
    assert.equal(out.conversation, null);
  });
});

// ════════════════════════════════════════════════════════════════
// B. applyActivityRow / applyActivityList
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.12-B — applyActivityRow (whatsapp_handover)', () => {
  function activityRow() {
    return {
      id: 'act-1',
      type: 'assignment',
      body: 'WhatsApp handover (full)',
      payload: {
        event: 'whatsapp_handover',
        conversationId: 'conv-1',
        mode: 'full',
        fromUserId: 'u-prev',
        toUserId: 'u-current',
        notify: true,
      },
      createdAt: '2026-05-02T00:00:00Z',
    };
  }

  it('internalMetadata denied → fromUserId nulled; toUserId preserved (current owner)', () => {
    const out = svc.applyActivityRow(
      activityRow(),
      buildVisibility({ denied: ['internalMetadata'] }),
    );
    const payload = out.payload as Record<string, unknown>;
    assert.equal(payload['fromUserId'], null);
    // Primary handover row preserves toUserId — it's the current
    // assignee, hiding it would break the agent's own UI.
    assert.equal(payload['toUserId'], 'u-current');
    // Operational context preserved.
    assert.equal(payload['mode'], 'full');
    assert.equal(payload['conversationId'], 'conv-1');
  });

  it('handoverSummary denied → summary key nulled when present', () => {
    const row = activityRow();
    (row.payload as { summary?: string }).summary = 'TL note about previous agent';
    const out = svc.applyActivityRow(row, buildVisibility({ denied: ['handoverSummary'] }));
    const payload = out.payload as Record<string, unknown>;
    assert.equal(payload['summary'], null);
  });

  it('agent-cohort defaults strip both fromUserId AND nothing else for full mode', () => {
    const out = svc.applyActivityRow(
      activityRow(),
      buildVisibility({
        denied: ['handoverChain', 'priorAgentMessages', 'reviewNotes', 'internalMetadata'],
      }),
    );
    const payload = out.payload as Record<string, unknown>;
    assert.equal(payload['fromUserId'], null);
    assert.equal(payload['mode'], 'full');
    assert.equal(payload['toUserId'], 'u-current');
  });

  it('super-admin bypass → row unchanged', () => {
    const out = svc.applyActivityRow(activityRow(), buildVisibility({ bypassed: true }));
    const payload = out.payload as Record<string, unknown>;
    assert.equal(payload['fromUserId'], 'u-prev');
    assert.equal(payload['toUserId'], 'u-current');
  });

  it('non-WhatsApp activity passes through unchanged', () => {
    const row = {
      id: 'act-2',
      type: 'note',
      body: 'agent note',
      payload: { event: 'note', text: 'a note' },
      createdAt: '2026-05-02T00:00:00Z',
    };
    const before = JSON.stringify(row);
    const out = svc.applyActivityRow(row, buildVisibility({ denied: ['internalMetadata'] }));
    assert.equal(JSON.stringify(out), before);
  });

  it('null payload passes through', () => {
    const row = {
      id: 'act-3',
      type: 'assignment',
      body: null,
      payload: null,
      createdAt: '2026-05-02T00:00:00Z',
    };
    const out = svc.applyActivityRow(row, buildVisibility({ denied: ['internalMetadata'] }));
    assert.equal(out.payload, null);
  });
});

describe('rbac/D5.12-B — applyActivityRow (whatsapp_handover_summary)', () => {
  function summaryRow() {
    return {
      id: 'act-2',
      type: 'note',
      body: 'TL handover summary text',
      payload: {
        event: 'whatsapp_handover_summary',
        fromUserId: 'u-prev',
        toUserId: 'u-current',
      },
      createdAt: '2026-05-02T00:00:01Z',
    };
  }

  it('internalMetadata denied → BOTH fromUserId AND toUserId nulled (chain context)', () => {
    const out = svc.applyActivityRow(
      summaryRow(),
      buildVisibility({ denied: ['internalMetadata'] }),
    );
    const payload = out.payload as Record<string, unknown>;
    assert.equal(payload['fromUserId'], null);
    assert.equal(payload['toUserId'], null);
  });

  it('handoverSummary denied → activity body nulled (summary text)', () => {
    const out = svc.applyActivityRow(
      summaryRow(),
      buildVisibility({ denied: ['handoverSummary'] }),
    );
    assert.equal(out.body, null);
  });

  it('handoverSummary allowed → activity body preserved', () => {
    const out = svc.applyActivityRow(summaryRow(), buildVisibility({}));
    assert.equal(out.body, 'TL handover summary text');
  });

  it('super-admin bypass → body and identities preserved', () => {
    const out = svc.applyActivityRow(summaryRow(), buildVisibility({ bypassed: true }));
    assert.equal(out.body, 'TL handover summary text');
    const payload = out.payload as Record<string, unknown>;
    assert.equal(payload['fromUserId'], 'u-prev');
    assert.equal(payload['toUserId'], 'u-current');
  });
});

describe('rbac/D5.12-B — applyActivityList', () => {
  it('preserves row count exactly', () => {
    const rows = [
      {
        id: '1',
        type: 'assignment',
        body: 'WhatsApp handover (full)',
        payload: { event: 'whatsapp_handover', fromUserId: 'a' },
        createdAt: '2026-05-01T00:00:00Z',
      },
      {
        id: '2',
        type: 'note',
        body: 'note',
        payload: { event: 'note' },
        createdAt: '2026-05-02T00:00:00Z',
      },
      {
        id: '3',
        type: 'note',
        body: 'summary text',
        payload: { event: 'whatsapp_handover_summary', fromUserId: 'a' },
        createdAt: '2026-05-03T00:00:00Z',
      },
    ];
    const out = svc.applyActivityList(rows, buildVisibility({ denied: ['internalMetadata'] }));
    assert.equal(out.length, 3);
  });

  it('super-admin bypass returns input unchanged', () => {
    const rows = [
      {
        id: '1',
        type: 'assignment',
        body: 'h',
        payload: { event: 'whatsapp_handover', fromUserId: 'a' },
        createdAt: '2026-05-01T00:00:00Z',
      },
    ];
    const out = svc.applyActivityList(rows, buildVisibility({ bypassed: true }));
    assert.equal((out[0]!.payload as Record<string, unknown>)['fromUserId'], 'a');
  });
});

// ════════════════════════════════════════════════════════════════
// C. applyAuditRowPayload — unified audit feed redactor
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.12-B — applyAuditRowPayload', () => {
  function auditHandoverRow() {
    // Audit pipeline merges body into payload.body for lead-activity rows.
    return {
      source: 'lead_activity' as const,
      id: 'act-1',
      action: 'lead.assignment',
      entityType: 'lead',
      entityId: 'lead-1',
      actorUserId: null,
      payload: {
        body: 'WhatsApp handover (summary)',
        event: 'whatsapp_handover_summary',
        fromUserId: 'u-prev',
        toUserId: 'u-current',
      },
      createdAt: new Date('2026-05-02T00:00:00Z'),
    };
  }

  it('handoverSummary denied → BOTH structured summary + merged body nulled', () => {
    const row = auditHandoverRow();
    (row.payload as Record<string, unknown>)['summary'] = 'TL summary';
    const out = svc.applyAuditRowPayload(row, buildVisibility({ denied: ['handoverSummary'] }));
    const payload = out.payload as Record<string, unknown>;
    assert.equal(payload['summary'], null);
    assert.equal(payload['body'], null);
  });

  it('internalMetadata denied → fromUserId AND toUserId nulled (summary event)', () => {
    const out = svc.applyAuditRowPayload(
      auditHandoverRow(),
      buildVisibility({ denied: ['internalMetadata'] }),
    );
    const payload = out.payload as Record<string, unknown>;
    assert.equal(payload['fromUserId'], null);
    assert.equal(payload['toUserId'], null);
    // body NOT nulled for internalMetadata gate — only handoverSummary nulls body.
    assert.equal(payload['body'], 'WhatsApp handover (summary)');
  });

  it('non-WhatsApp audit row passes through unchanged', () => {
    const row = {
      source: 'audit_event' as const,
      id: 'evt-1',
      action: 'lead.rotated',
      entityType: 'lead',
      entityId: 'lead-1',
      actorUserId: null,
      payload: { fromUserId: 'a', toUserId: 'b' },
      createdAt: new Date(),
    };
    const before = JSON.stringify(row);
    const out = svc.applyAuditRowPayload(row, buildVisibility({ denied: ['internalMetadata'] }));
    assert.equal(JSON.stringify(out), before);
  });

  it('super-admin bypass → row unchanged', () => {
    const out = svc.applyAuditRowPayload(auditHandoverRow(), buildVisibility({ bypassed: true }));
    const payload = out.payload as Record<string, unknown>;
    assert.equal(payload['body'], 'WhatsApp handover (summary)');
    assert.equal(payload['fromUserId'], 'u-prev');
    assert.equal(payload['toUserId'], 'u-current');
  });
});

// ════════════════════════════════════════════════════════════════
// D. resolveConversationVisibility integration through service
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.12-B — resolveConversationVisibility (service-level integration)', () => {
  it('reads the agent cohort defaults and produces the expected flag set', async () => {
    const local = new WhatsAppVisibilityService(
      fakeFieldFilter({
        'whatsapp.conversation': {
          bypassed: false,
          paths: ['handoverChain', 'priorAgentMessages', 'reviewNotes', 'internalMetadata'],
        },
      }),
    );
    const v = await local.resolveConversationVisibility(CLAIMS);
    assert.equal(v.canReadHandoverChain, false);
    assert.equal(v.canReadPriorAgentMessages, false);
    assert.equal(v.canReadReviewNotes, false);
    assert.equal(v.canReadInternalMetadata, false);
    assert.equal(v.canReadHandoverSummary, true);
    assert.equal(v.canReadConversationHistory, true);
  });
});
