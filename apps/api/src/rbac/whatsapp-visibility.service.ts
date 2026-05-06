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
