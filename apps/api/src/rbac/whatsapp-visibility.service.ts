import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { FieldFilterService } from './field-filter.service';
import type { ScopeUserClaims } from './scope-context.service';

/**
 * Phase D5 — D5.12-A: WhatsApp conversation visibility resolver.
 *
 * Read-only enforcement layer for the WhatsApp conversations
 * surface. Two orthogonal gates combine here:
 *
 *   1. Field permissions — `whatsapp.conversation.*` deny rows
 *      (D5.12-A migration installs the agent-cohort defaults).
 *      Mirrors the D5.7/D5.8 pattern: read `field_permissions` via
 *      `FieldFilterService`, super-admin bypasses.
 *
 *   2. Transfer-mode restrictions — when the conversation has
 *      passed through `WhatsAppService.handoverConversation`, the
 *      most recent handover's mode (`full` / `summary` / `clean`)
 *      sets a privacy floor that the field-permission layer alone
 *      cannot lift:
 *
 *        • `clean`   — prior messages (`createdAt < assignedAt`)
 *                       are HIDDEN from any non-super-admin caller,
 *                       regardless of role grants. Mirrors the
 *                       `clean transfer` product invariant
 *                       documented in `WhatsAppService.handoverConversation`.
 *        • `summary` — prior messages HIDDEN by default. Handover
 *                       summary itself is gated by the catalogue's
 *                       `whatsapp.conversation.handoverSummary`
 *                       field permission.
 *        • `full`    — prior messages may be visible IF
 *                       `whatsapp.conversation.priorAgentMessages`
 *                       is allowed. Field permission is the only
 *                       gate; transfer-mode adds nothing.
 *        • `unknown` — no recent handover (e.g. inbound-routed
 *                       conversation, never handed over). Field
 *                       permission decides alone.
 *
 *   The "stricter rule wins" invariant: if EITHER the field
 *   permission OR the transfer mode says hide, prior messages are
 *   hidden.
 *
 * Super-admin bypass:
 *   `super_admin` bypasses BOTH layers — field permissions
 *   (mirrors `FieldFilterService`) AND the transfer-mode floor.
 *   The product driver: super-admin investigators must be able to
 *   surface prior conversation context for fraud investigation.
 *   The audit trail captures every super-admin read at the
 *   controller layer (existing `audit.read` capability + the
 *   tenant audit feed). The `WhatsAppMessage` rows are persisted
 *   regardless; hiding them via the API for super-admin would be
 *   security theatre. Documented + tested.
 *
 * Pure metadata projection — never reads message body bytes,
 * never echoes raw payload values, never produces side effects
 * outside the redaction call.
 */

/**
 * Per-(role × field) decisions on `whatsapp.conversation`. Empty
 * deny list ⇒ every flag is `true` (default-allow per the
 * catalogue's `defaultRead: true`). Super-admin returns the same
 * shape with every flag `true`.
 */
export interface ConversationVisibility {
  /** Show messages older than `conversation.assignedAt`. */
  readonly canReadPriorAgentMessages: boolean;
  /** Show the structured chain of handover events. */
  readonly canReadHandoverChain: boolean;
  /** Show the operator-authored handover summary (Summary mode). */
  readonly canReadHandoverSummary: boolean;
  /** Show full conversation history regardless of assignment cuts. */
  readonly canReadConversationHistory: boolean;
  /** Show handover review notes (admin TL surface). */
  readonly canReadReviewNotes: boolean;
  /** Show internal metadata (assignmentSource, debug payload). */
  readonly canReadInternalMetadata: boolean;
  /** True when the bypass path ran (super_admin). */
  readonly bypassedFieldPermissions: boolean;
}

const ALL_VISIBLE: ConversationVisibility = {
  canReadPriorAgentMessages: true,
  canReadHandoverChain: true,
  canReadHandoverSummary: true,
  canReadConversationHistory: true,
  canReadReviewNotes: true,
  canReadInternalMetadata: true,
  bypassedFieldPermissions: true,
};

export type WhatsAppHandoverMode = 'full' | 'summary' | 'clean';
export type WhatsAppTransferMode = WhatsAppHandoverMode | 'unknown';

/**
 * Result of `applyConversationDetailVisibility`. Carries the
 * sanitised conversation row plus three boolean flags the
 * frontend renders as `<RedactedFieldBadge>` placeholders.
 */
export interface ConversationDetailRedactionFlags {
  readonly priorMessagesHidden: boolean;
  readonly handoverChainHidden: boolean;
  readonly historyHidden: boolean;
}

@Injectable()
export class WhatsAppVisibilityService {
  constructor(private readonly fieldFilter: FieldFilterService) {}

  /**
   * Read the role's `whatsapp.conversation` deny list and project
   * it to a flat boolean shape. One DB read.
   */
  async resolveConversationVisibility(claims: ScopeUserClaims): Promise<ConversationVisibility> {
    const { bypassed, paths } = await this.fieldFilter.listDeniedReadFields(
      claims,
      'whatsapp.conversation',
    );
    if (bypassed) return ALL_VISIBLE;
    const denied = new Set(paths);
    return {
      canReadPriorAgentMessages: !denied.has('priorAgentMessages'),
      canReadHandoverChain: !denied.has('handoverChain'),
      canReadHandoverSummary: !denied.has('handoverSummary'),
      canReadConversationHistory: !denied.has('conversationHistory'),
      canReadReviewNotes: !denied.has('reviewNotes'),
      canReadInternalMetadata: !denied.has('internalMetadata'),
      bypassedFieldPermissions: false,
    };
  }

  /**
   * Resolve the most recent transfer mode for a given conversation.
   *
   * `WhatsAppService.handoverConversation` records the mode in TWO
   * places: `WhatsAppConversation.assignmentSource = 'manual_handover'`
   * (a flag, not a mode) AND a `LeadActivity` row with
   * `payload.event = 'whatsapp_handover'` + `payload.mode`. This
   * helper reads the most-recent matching activity row.
   *
   * Returns `'unknown'` when no handover activity exists (e.g. an
   * inbound-routed conversation that was never handed over) OR
   * when the conversation has no linked lead.
   *
   * Pure read against the `lead_activities` table, scoped by tenant
   * via the caller's transaction client. No clock reads, no
   * mutation.
   */
  async resolveTransferMode(
    tx: Prisma.TransactionClient,
    conversation: {
      readonly id: string;
      readonly leadId: string | null;
      readonly assignmentSource: string | null;
    },
  ): Promise<WhatsAppTransferMode> {
    if (!conversation.leadId) return 'unknown';
    if (conversation.assignmentSource !== 'manual_handover') return 'unknown';

    // Hot path: most recent handover activity for the lead. Filter
    // both on `type='assignment'` and the JSON payload's
    // `conversationId` so a re-handover on a sibling conversation
    // doesn't bleed in.
    const row = await tx.leadActivity.findFirst({
      where: {
        leadId: conversation.leadId,
        type: 'assignment',
        payload: {
          path: ['event'],
          equals: 'whatsapp_handover',
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
      take: 1,
    });
    if (!row?.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
      return 'unknown';
    }
    const payload = row.payload as Record<string, unknown>;
    if (payload['conversationId'] !== conversation.id) return 'unknown';
    const mode = payload['mode'];
    if (mode === 'full' || mode === 'summary' || mode === 'clean') return mode;
    return 'unknown';
  }

  /**
   * Compute whether prior messages (`createdAt < assignedAt`) MUST
   * be hidden from the caller. The "stricter rule wins" gate:
   *
   *   • super-admin bypass → always visible (`false`).
   *   • mode 'clean'        → always hidden (`true`), even when
   *                            `priorAgentMessages` is allowed.
   *   • mode 'summary'      → hidden unless field permission
   *                            allows AND product policy permits
   *                            (this implementation: HIDE).
   *   • mode 'full'         → field permission alone.
   *   • mode 'unknown'      → field permission alone.
   */
  shouldHidePriorMessages(visibility: ConversationVisibility, mode: WhatsAppTransferMode): boolean {
    if (visibility.bypassedFieldPermissions) return false;
    if (mode === 'clean') return true;
    if (mode === 'summary') return true;
    return !visibility.canReadPriorAgentMessages;
  }

  /**
   * Per-row redaction for the conversation list endpoint. Mutates
   * a shallow copy:
   *   • when `priorMessagesHidden` AND the row's `lastMessageAt`
   *     predates `assignedAt`, the `lastMessageText` preview
   *     becomes `null` so the inbox doesn't leak prior-agent
   *     content into the list strip.
   *   • when `internalMetadata` denied, the row's
   *     `assignmentSource` (which leaks "this was handed over"
   *     vs "inbound-routed") is nulled.
   *   • when `assignedTo` row carries an email and the role
   *     doesn't hold `canReadInternalMetadata`, the email is
   *     dropped (the inbox needs the name only).
   *
   * The function is pure — returns a new object reference; the
   * input row is untouched.
   */
  applyConversationListRow<
    T extends {
      lastMessageAt: Date | string | null;
      lastMessageText?: string | null;
      assignedAt?: Date | string | null;
      assignmentSource?: string | null;
      assignedTo?: { id: string; name: string; email?: string; teamId?: string | null } | null;
    },
  >(row: T, visibility: ConversationVisibility, mode: WhatsAppTransferMode): T {
    const out: T = { ...row };
    const hidePrior = this.shouldHidePriorMessages(visibility, mode);
    if (hidePrior && lastMessageBeforeAssignment(row)) {
      (out as { lastMessageText: string | null }).lastMessageText = null;
    }
    if (!visibility.canReadInternalMetadata) {
      (out as { assignmentSource: string | null }).assignmentSource = null;
    }
    if (!visibility.canReadInternalMetadata && out.assignedTo && 'email' in out.assignedTo) {
      const { email: _email, ...assignedToSansEmail } = out.assignedTo as {
        email?: string;
      } & Record<string, unknown>;
      (out as { assignedTo: unknown }).assignedTo = assignedToSansEmail;
    }
    return out;
  }

  /**
   * Detail-shape redactor. Identical column-level rules as the
   * list redactor, plus three top-level safety flags the frontend
   * uses to render `<RedactedFieldBadge>` placeholders.
   */
  applyConversationDetailRow<
    T extends {
      lastMessageAt: Date | string | null;
      lastMessageText?: string | null;
      assignedAt?: Date | string | null;
      assignmentSource?: string | null;
      assignedTo?: { id: string; name: string; email?: string; teamId?: string | null } | null;
    },
  >(
    row: T,
    visibility: ConversationVisibility,
    mode: WhatsAppTransferMode,
  ): T & ConversationDetailRedactionFlags {
    const sanitised = this.applyConversationListRow(row, visibility, mode);
    const priorMessagesHidden = this.shouldHidePriorMessages(visibility, mode);
    const handoverChainHidden = !visibility.canReadHandoverChain;
    const historyHidden = priorMessagesHidden || !visibility.canReadConversationHistory;
    return {
      ...sanitised,
      priorMessagesHidden,
      handoverChainHidden,
      historyHidden,
    };
  }

  /**
   * Filter messages older than the conversation's `assignedAt`
   * timestamp when the visibility rules require it. Returns a
   * subset of the input; row count is intentionally REDUCED, not
   * faked with placeholders. Hidden rows do NOT leak via count or
   * pagination.
   *
   * Behaviour matrix:
   *
   *   • super-admin bypass         → input unchanged.
   *   • shouldHidePriorMessages    → returns only messages with
   *                                   `createdAt >= assignedAt`.
   *                                   When `assignedAt` is null
   *                                   (inbound-routed conversation,
   *                                   no handover ever) the cutoff
   *                                   doesn't apply and every
   *                                   message survives.
   *   • otherwise                  → input unchanged.
   *
   * Pure CPU; no mutation.
   */
  applyMessageList<
    T extends {
      createdAt: Date | string;
    },
  >(
    messages: readonly T[],
    visibility: ConversationVisibility,
    mode: WhatsAppTransferMode,
    conversation: { assignedAt: Date | string | null },
  ): T[] {
    if (visibility.bypassedFieldPermissions) return [...messages];
    if (!this.shouldHidePriorMessages(visibility, mode)) return [...messages];
    const cutoff = parseTimestamp(conversation.assignedAt);
    if (cutoff === null) return [...messages];
    return messages.filter((m) => {
      const t = parseTimestamp(m.createdAt);
      return t !== null && t >= cutoff;
    });
  }

  /**
   * Phase D5 — D5.12-B: WhatsApp review row redactor.
   *
   * The TL Review Queue ships rows that EMBED a conversation
   * projection (id / phone / lastMessageText / lastInboundAt /
   * assignedToId in the list shape; the full row in the detail
   * shape). The embedded conversation may carry prior-agent
   * content the calling role isn't allowed to see — `applyReviewRow`
   * applies the same column-level redaction as
   * `applyConversationListRow` to that nested object plus
   * D5.12-B-specific gates on the review row itself:
   *
   *   • `assignedToId` on the embedded conversation is null'd
   *     when `internalMetadata` is denied (it leaks the previous
   *     assignee identity).
   *   • `lastMessageText` is null'd when its preview predates an
   *     `assignedAt` AND prior messages must hide.
   *   • `lastInboundAt` is preserved (operational context — the
   *     TL needs to see when the customer last replied).
   *   • The review row's top-level `reason` / `resolution` /
   *     `resolvedAt` / `createdAt` columns are operational and
   *     surface verbatim.
   *
   * Transfer-mode resolution requires a `tx` client + a populated
   * `conversation` shape (id / leadId / assignmentSource); the
   * caller passes the same row it embedded so the helper avoids
   * a second DB read.
   *
   * Pure function — returns a fresh row; the input is untouched.
   */
  applyReviewRow<
    T extends {
      conversation: {
        id: string;
        phone: string;
        lastMessageText?: string | null;
        lastInboundAt?: Date | string | null;
        assignedToId?: string | null;
        assignedAt?: Date | string | null;
        assignmentSource?: string | null;
      } | null;
    },
  >(row: T, visibility: ConversationVisibility, mode: WhatsAppTransferMode): T {
    const out: T = { ...row };
    if (!out.conversation) return out;
    const conv = { ...out.conversation } as typeof out.conversation;
    const hidePrior = this.shouldHidePriorMessages(visibility, mode);
    if (
      hidePrior &&
      conv.lastInboundAt !== undefined &&
      conv.assignedAt !== undefined &&
      lastMessageBeforeAssignment({
        lastMessageAt: conv.lastInboundAt ?? null,
        assignedAt: conv.assignedAt ?? null,
      })
    ) {
      conv.lastMessageText = null;
    }
    if (!visibility.canReadInternalMetadata) {
      conv.assignedToId = null;
      conv.assignmentSource = null;
    }
    out.conversation = conv;
    return out;
  }

  /**
   * Phase D5 — D5.12-B: redact WhatsApp handover sub-keys inside a
   * `LeadActivity.payload` JSON blob.
   *
   * The lead-detail timeline + the unified audit feed surface
   * `LeadActivity` rows of `type='assignment'` with
   * `payload.event='whatsapp_handover'` (carries `fromUserId` /
   * `toUserId` / `mode` / `summary` / `notify`) and
   * `type='note'` with `payload.event='whatsapp_handover_summary'`
   * (carries `fromUserId` / `toUserId` and the body string).
   *
   * The catalogue's `lead.activity.payload` field-permission gate
   * is too coarse — it nulls the entire payload, removing
   * operational context an agent legitimately needs (`event`,
   * `mode`, `conversationId`). This redactor is surgical: it only
   * touches the well-known WhatsApp sub-keys.
   *
   * Behaviour matrix:
   *
   *   • super-admin bypass            → input unchanged.
   *   • event !== whatsapp_handover  → row passes through (other
   *     activity types redact at the existing `lead.activity`
   *     `@ResourceFieldGate`).
   *   • whatsapp_handover row:
   *       - `fromUserId` nulled when `internalMetadata` denied
   *         (previous-owner identity).
   *       - `toUserId` preserved (current assignee — the agent
   *         themselves; hiding it would break their own UI).
   *       - `summary` nulled when `handoverSummary` denied.
   *       - `mode` / `conversationId` / `notify` preserved
   *         (operational context).
   *   • whatsapp_handover_summary row:
   *       - `fromUserId` / `toUserId` nulled when
   *         `internalMetadata` denied.
   *       - The activity's `body` text (the summary itself) is
   *         nulled when `handoverSummary` denied.
   *
   * Pure function — returns a fresh array of cloned rows. Row
   * count is preserved exactly; nothing is dropped.
   */
  applyActivityList<
    T extends {
      type: string;
      body?: string | null;
      payload: unknown;
    },
  >(rows: readonly T[], visibility: ConversationVisibility): T[] {
    if (visibility.bypassedFieldPermissions) return [...rows];
    return rows.map((r) => this.applyActivityRow(r, visibility));
  }

  /**
   * Phase D5 — D5.12-B: redact a unified-audit-feed row's
   * `payload` JSON when it represents a `whatsapp_handover` /
   * `whatsapp_handover_summary` event. The audit pipeline merges
   * `LeadActivity.body` into `payload.body` (see
   * `AuditService.list`), so this helper nulls the merged `body`
   * key alongside the regular sub-key redaction.
   *
   * Only the `payload` field is mutated; every other audit-row
   * column passes through.
   */
  applyAuditRowPayload<T extends { payload: unknown }>(
    row: T,
    visibility: ConversationVisibility,
  ): T {
    if (visibility.bypassedFieldPermissions) return row;
    if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
      return row;
    }
    const payload = row.payload as Record<string, unknown>;
    const event = payload['event'];
    if (event !== 'whatsapp_handover' && event !== 'whatsapp_handover_summary') {
      return row;
    }
    const newPayload: Record<string, unknown> = { ...payload };
    let changed = false;
    if (!visibility.canReadInternalMetadata) {
      if ('fromUserId' in newPayload && newPayload['fromUserId'] !== null) {
        newPayload['fromUserId'] = null;
        changed = true;
      }
      if (
        event === 'whatsapp_handover_summary' &&
        'toUserId' in newPayload &&
        newPayload['toUserId'] !== null
      ) {
        newPayload['toUserId'] = null;
        changed = true;
      }
    }
    if (!visibility.canReadHandoverSummary) {
      if ('summary' in newPayload && newPayload['summary'] !== null) {
        newPayload['summary'] = null;
        changed = true;
      }
      // Audit feed merges `LeadActivity.body` into payload.body
      // for lead-activity rows. The whatsapp_handover_summary
      // body is the verbatim summary text — null it on the same
      // gate as the structured `summary` sub-key.
      if (
        event === 'whatsapp_handover_summary' &&
        'body' in newPayload &&
        newPayload['body'] !== null
      ) {
        newPayload['body'] = null;
        changed = true;
      }
    }
    if (!changed) return row;
    return { ...row, payload: newPayload };
  }

  applyActivityRow<
    T extends {
      type: string;
      body?: string | null;
      payload: unknown;
    },
  >(row: T, visibility: ConversationVisibility): T {
    if (visibility.bypassedFieldPermissions) return row;
    if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
      return row;
    }
    const payload = row.payload as Record<string, unknown>;
    const event = payload['event'];
    if (event !== 'whatsapp_handover' && event !== 'whatsapp_handover_summary') {
      return row;
    }

    let changed = false;
    const newPayload: Record<string, unknown> = { ...payload };

    if (!visibility.canReadInternalMetadata) {
      if ('fromUserId' in newPayload && newPayload['fromUserId'] !== null) {
        newPayload['fromUserId'] = null;
        changed = true;
      }
      // For whatsapp_handover_summary the toUserId is the actor's
      // counterpart — the receiver. We null it here too because the
      // surrounding context is the previous-agent → previous-target
      // chain, NOT the current viewer's own assignment. For the
      // primary whatsapp_handover row, toUserId is the current
      // owner, so we preserve it.
      if (
        event === 'whatsapp_handover_summary' &&
        'toUserId' in newPayload &&
        newPayload['toUserId'] !== null
      ) {
        newPayload['toUserId'] = null;
        changed = true;
      }
    }

    if (!visibility.canReadHandoverSummary) {
      if ('summary' in newPayload && newPayload['summary'] !== null) {
        newPayload['summary'] = null;
        changed = true;
      }
    }

    const out: T = { ...row };
    if (changed) {
      (out as { payload: unknown }).payload = newPayload;
    }
    // For whatsapp_handover_summary rows the activity's `body` is
    // a verbatim copy of the operator-authored summary text. Null
    // it when `handoverSummary` is denied so the timeline doesn't
    // leak via the `body` channel that bypasses `payload`.
    if (
      event === 'whatsapp_handover_summary' &&
      !visibility.canReadHandoverSummary &&
      out.body !== null &&
      out.body !== undefined
    ) {
      (out as { body: string | null }).body = null;
    }
    return out;
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function lastMessageBeforeAssignment(row: {
  lastMessageAt: Date | string | null;
  assignedAt?: Date | string | null;
}): boolean {
  const last = parseTimestamp(row.lastMessageAt);
  const assigned = parseTimestamp(row.assignedAt ?? null);
  if (last === null || assigned === null) return false;
  return last < assigned;
}

function parseTimestamp(value: Date | string | null): number | null {
  if (value === null) return null;
  if (value instanceof Date) return value.getTime();
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}
