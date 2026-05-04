import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { LeadAttemptsService } from '../crm/lead-attempts.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { requireTenantId } from '../tenants/tenant-context';

import {
  DEFAULT_DUPLICATE_RULES,
  parseDuplicateRulesJson,
  type DuplicateRulesConfig,
} from './duplicate-rules.dto';
import {
  DuplicateRulesService,
  type DuplicateContext,
  type DuplicateDecision,
  type MatchingCaptain,
  type MatchingLead,
} from './duplicate-rules.service';
import { isLeadAttemptsV2Enabled } from './feature-flag';

/**
 * Phase D2 — D2.2: orchestrator for duplicate / reactivation decisions.
 *
 * Composition:
 *   1. Gathers matching Contact / Lead / Captain rows for the
 *      incoming phone (via Prisma).
 *   2. Loads the tenant's duplicate rules (or defaults).
 *   3. Calls `DuplicateRulesService.evaluate(...)` (pure logic).
 *   4. Writes one DuplicateDecisionLog row capturing the decision.
 *   5. Optionally executes the decision side-effects (create a new
 *      Lead attempt with chained `previous_lead_id` + reactivation
 *      audit metadata, OR record the queue_review intent so the
 *      caller can enqueue the review row).
 *
 * D2.2 ships the SERVICE only. NO existing create path invokes it
 * yet. The Nest container wires it; D2.3 routes manual / CSV / Meta /
 * WhatsApp inbound / review-resolve through it.
 *
 * Feature flag: `LEAD_ATTEMPTS_V2`. When false (production default),
 * `evaluateAndApply(...)` short-circuits to `{ skipped: true }` so
 * a future caller that forgot to read the flag can't accidentally
 * write rows. When true (dev/test default), the service does its
 * work as documented.
 *
 * Tx-awareness: every public method accepts an optional
 * `tx?: Prisma.TransactionClient`. Callers from inside an existing
 * transaction (D2.3 create paths) pass their tx; standalone callers
 * (tests, future bulk-reactivation tooling) let the service open
 * its own.
 */

export type DecisionApplyOutcome =
  | { kind: 'created_new_attempt'; leadId: string; attemptIndex: number }
  | { kind: 'queued_review'; payload: ReviewIntent }
  | { kind: 'linked_to_existing'; leadId: string }
  | { kind: 'rejected' }
  | { kind: 'skipped'; reason: 'flag_disabled' };

/**
 * Snapshot a future caller (D2.3 review-queue extension) needs to
 * enqueue a WhatsAppConversationReview row when the rule engine
 * decides `queue_review`. D2.2 stores this in the DuplicateDecisionLog
 * payload; D2.3 reads it to materialise the review row.
 */
export interface ReviewIntent {
  reason: 'duplicate_lead' | 'captain_active' | 'won_lead' | 'cooldown';
  matchedLeadIds: readonly string[];
  matchedCaptainId: string | null;
  ruleApplied: string;
}

/** Input for `evaluate` / `evaluateAndApply` — what the caller knows. */
export interface DecisionInput {
  /** E.164 phone (caller normalised). */
  phone: string;
  /** Optional contactId — when known the orchestrator can skip the
   *  "find contact by phone" round-trip and dedupe matches faster. */
  contactId: string | null;
  context: Omit<DuplicateContext, 'phone'>;
  /** When the caller wants new-attempt creation, supply the Lead
   *  fields the orchestrator should use (other than the chain /
   *  reactivation audit fields it manages itself). Optional — when
   *  omitted, the orchestrator only logs and returns the decision
   *  without creating anything. */
  attemptDraft?: NewAttemptDraft;
}

/** Lead fields the orchestrator copies onto the new Lead row when
 *  it executes `create_new_attempt`. Mirrors the minimum set the
 *  existing `LeadsService.create` writes — the orchestrator does
 *  NOT run distribution / SLA recalc / activity feed; D2.3 wires
 *  those after this returns the new lead id. */
export interface NewAttemptDraft {
  name: string;
  email: string | null;
  source: string;
  stageId: string;
  pipelineId: string | null;
  companyId: string | null;
  countryId: string | null;
  /** Owner the caller wants — should normally be the routing
   *  engine's choice, OR (when rule.recommendedOwnerStrategy is
   *  'previous_owner') the predecessor's `assignedToId`. */
  assignedToId: string | null;
  createdById: string | null;
  attribution: Prisma.InputJsonValue | null;
}

@Injectable()
export class DuplicateDecisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: DuplicateRulesService,
    private readonly attempts: LeadAttemptsService,
    private readonly audit: AuditService,
    // TenantSettingsService is optional in tests that don't need
    // tenant lookup (they pass `rules` directly via `evaluatePure`).
    @Optional()
    @Inject(TenantSettingsService)
    private readonly tenantSettings?: TenantSettingsService,
  ) {}

  /**
   * Pure evaluation — no DB writes. Used by tests and by callers who
   * want to peek at the decision without applying it.
   *
   * `now` is injectable so the rules engine's cool-off math is
   * deterministic in tests.
   */
  async evaluate(
    input: DecisionInput,
    opts: { tx?: Prisma.TransactionClient; now?: Date } = {},
  ): Promise<DuplicateDecision> {
    const tenantId = requireTenantId();
    const tx = opts.tx ?? null;
    const rules = await this.loadRules(tenantId, tx);

    const { matchingLeads, matchingCaptain } = await this.gatherMatches(tenantId, input, tx);

    return this.rules.evaluate({
      context: { ...input.context, phone: input.phone },
      matchingLeads,
      matchingCaptain,
      rules,
      ...(opts.now && { now: opts.now }),
    });
  }

  /**
   * Evaluate + log + execute the decision. Behind LEAD_ATTEMPTS_V2.
   * When the flag resolves false, returns `{ kind: 'skipped' }` and
   * writes nothing — production is opt-in until D2.3 explicitly
   * flips a tenant in.
   */
  async evaluateAndApply(
    input: DecisionInput,
    opts: { tx?: Prisma.TransactionClient; now?: Date } = {},
  ): Promise<{ decision: DuplicateDecision; outcome: DecisionApplyOutcome }> {
    if (!isLeadAttemptsV2Enabled()) {
      // The decision is still useful to the caller (tests asserting
      // the rules engine outputs); we just skip the side-effects.
      const decision = await this.evaluate(input, opts);
      return { decision, outcome: { kind: 'skipped', reason: 'flag_disabled' } };
    }
    const decision = await this.evaluate(input, opts);
    const outcome = await this.apply(decision, input, opts);
    return { decision, outcome };
  }

  /**
   * Execute a previously-computed decision. Splitting this from
   * `evaluateAndApply` lets D2.3 run extra checks between
   * "what does the engine think?" and "actually do it" — for
   * example, the WhatsApp inbound orchestrator may want to inspect
   * the decision before deciding whether to enqueue a review row
   * vs. silently link.
   */
  async apply(
    decision: DuplicateDecision,
    input: DecisionInput,
    opts: { tx?: Prisma.TransactionClient } = {},
  ): Promise<DecisionApplyOutcome> {
    const tenantId = requireTenantId();
    return this.runWithMaybeTx(tenantId, opts.tx, async (tx) => {
      switch (decision.decision) {
        case 'create_first_attempt': {
          if (!input.attemptDraft) {
            // Caller chose to log the decision without creating; we
            // record it so dashboards can spot "evaluated but not
            // applied" cases. No side-effect.
            await this.writeLog(tx, tenantId, decision, input, null, null);
            return { kind: 'skipped', reason: 'flag_disabled' as const };
          }
          const lead = await this.createAttempt(tx, tenantId, input, decision, /*previous*/ null);
          await this.writeLog(tx, tenantId, decision, input, lead.id, null);
          return { kind: 'created_new_attempt', leadId: lead.id, attemptIndex: lead.attemptIndex };
        }
        case 'create_new_attempt': {
          if (!input.attemptDraft) {
            await this.writeLog(tx, tenantId, decision, input, null, null);
            return { kind: 'skipped', reason: 'flag_disabled' as const };
          }
          const previous = decision.previousLeadId
            ? await tx.lead.findUnique({
                where: { id: decision.previousLeadId },
                select: { id: true, attemptIndex: true, assignedToId: true },
              })
            : null;
          const lead = await this.createAttempt(tx, tenantId, input, decision, previous);
          await this.writeLog(tx, tenantId, decision, input, lead.id, null);
          return { kind: 'created_new_attempt', leadId: lead.id, attemptIndex: lead.attemptIndex };
        }
        case 'queue_review': {
          const reason = ruleToReviewReason(decision.ruleApplied);
          const intent: ReviewIntent = {
            reason,
            matchedLeadIds: decision.matchedLeadIds,
            matchedCaptainId: decision.matchedCaptainId,
            ruleApplied: decision.ruleApplied,
          };
          await this.writeLog(tx, tenantId, decision, input, null, null, { reviewIntent: intent });
          // The caller (D2.3 inbound flow) materialises the
          // WhatsAppConversationReview row from this intent in the
          // SAME tx. D2.2 stops at the audit row.
          return { kind: 'queued_review', payload: intent };
        }
        case 'link_to_existing': {
          const target = decision.matchedOpenLeadId;
          await this.writeLog(tx, tenantId, decision, input, target, null);
          // The caller links the inbound context (e.g. WhatsApp
          // conversation) to `target` itself; the orchestrator only
          // records the decision.
          return { kind: 'linked_to_existing', leadId: target! };
        }
        case 'reject_existing_open': {
          await this.writeLog(tx, tenantId, decision, input, null, null);
          return { kind: 'rejected' };
        }
      }
    });
  }

  // ─── public composition helpers (D2.3) ─────────────────────────────

  /**
   * D2.3 — public log-writer used by callers that own their own
   * create flow (e.g. `LeadsService.create`, `createFromWhatsApp`,
   * `LeadIngestionService.tryCreateLead`). The caller evaluates
   * via `evaluate(...)`, performs its own insert, and then calls
   * this to record the audit row + raise the standard audit verb.
   *
   * Idempotent: callers can safely call once per evaluated row.
   */
  async writeDecisionLogInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    decision: DuplicateDecision,
    input: DecisionInput,
    resultLeadId: string | null,
    resultReviewId: string | null,
    extra: { reviewIntent?: ReviewIntent } = {},
  ): Promise<void> {
    return this.writeLog(tx, tenantId, decision, input, resultLeadId, resultReviewId, extra);
  }

  // ─── internals ─────────────────────────────────────────────────────

  /** Load and parse the tenant's duplicate-rules JSON; defaults
   *  applied when missing or partial. */
  private async loadRules(
    tenantId: string,
    tx: Prisma.TransactionClient | null,
  ): Promise<DuplicateRulesConfig> {
    if (!this.tenantSettings) return { ...DEFAULT_DUPLICATE_RULES };
    // Read the row directly so we can extract the JSON column even
    // when TenantSettingsService.normalize doesn't surface it (D2.2
    // intentionally keeps the typed surface unchanged).
    const row = await this.runWithMaybeTx(tenantId, tx, (txInner) =>
      txInner.tenantSettings.findUnique({
        where: { tenantId },
        select: { duplicateRules: true },
      }),
    );
    return parseDuplicateRulesJson(row?.duplicateRules ?? null);
  }

  /** Gather matching leads + captain for the inbound phone. */
  private async gatherMatches(
    tenantId: string,
    input: DecisionInput,
    tx: Prisma.TransactionClient | null,
  ): Promise<{ matchingLeads: MatchingLead[]; matchingCaptain: MatchingCaptain | null }> {
    return this.runWithMaybeTx(tenantId, tx, async (txInner) => {
      const leads = await txInner.lead.findMany({
        where: { tenantId, phone: input.phone },
        select: {
          id: true,
          lifecycleState: true,
          assignedToId: true,
          companyId: true,
          countryId: true,
          pipelineId: true,
          attemptIndex: true,
          updatedAt: true,
          stage: { select: { code: true } },
          lostReason: { select: { code: true } },
        },
      });
      const matchingLeads: MatchingLead[] = leads.map((l) => ({
        id: l.id,
        lifecycleState: l.lifecycleState,
        stageCode: l.stage?.code ?? null,
        lostReasonCode: l.lostReason?.code ?? null,
        // For closed leads (lost / won / archived) we use updatedAt
        // as the "closed at" anchor. Open leads pass null. The rule
        // engine treats null closedAt as Infinity-aged, which is
        // safe because the only path where closedAt matters is the
        // `lost` branch — open leads short-circuit before then.
        closedAt: l.lifecycleState === 'open' ? null : l.updatedAt,
        pipelineId: l.pipelineId,
        companyId: l.companyId,
        countryId: l.countryId,
        assignedToId: l.assignedToId,
        attemptIndex: l.attemptIndex,
      }));

      // Captain match — find an active captain whose underlying lead
      // shares the phone. We query via the lead chain because Captain
      // doesn't carry a phone-unique constraint of its own.
      const captainRow = await txInner.captain.findFirst({
        where: {
          tenantId,
          status: 'active',
          lead: { phone: input.phone },
        },
        select: { id: true, status: true, leadId: true },
      });
      const matchingCaptain: MatchingCaptain | null = captainRow
        ? { id: captainRow.id, status: captainRow.status, leadId: captainRow.leadId }
        : null;

      return { matchingLeads, matchingCaptain };
    });
  }

  /** Create a new Lead row chained to the predecessor. Pure write —
   *  no SLA, no activity, no routing. D2.3 callers wrap this with
   *  whatever existing helpers they need. */
  private async createAttempt(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: DecisionInput,
    decision: DuplicateDecision,
    previous: { id: string; attemptIndex: number; assignedToId: string | null } | null,
  ): Promise<{ id: string; attemptIndex: number }> {
    const draft = input.attemptDraft!;
    const nextIndex = previous
      ? previous.attemptIndex + 1
      : input.contactId
        ? await this.attempts.getNextAttemptIndex(input.contactId)
        : 1;

    // Resolve owner per rule recommendation.
    const ownerId =
      decision.recommendedOwnerStrategy === 'previous_owner'
        ? (previous?.assignedToId ?? draft.assignedToId)
        : decision.recommendedOwnerStrategy === 'unassigned'
          ? null
          : draft.assignedToId;

    const lead = await tx.lead.create({
      data: {
        tenantId,
        name: draft.name,
        phone: input.phone,
        email: draft.email,
        source: draft.source,
        stageId: draft.stageId,
        pipelineId: draft.pipelineId,
        companyId: draft.companyId,
        countryId: draft.countryId,
        assignedToId: ownerId,
        createdById: draft.createdById,
        contactId: input.contactId,
        attribution: draft.attribution ?? Prisma.JsonNull,
        // D2 fields
        attemptIndex: nextIndex,
        previousLeadId: previous?.id ?? null,
        reactivatedAt: previous ? new Date() : null,
        reactivatedById: previous ? input.context.actorUserId : null,
        reactivationRule: previous ? decision.ruleApplied : null,
      },
      select: { id: true, attemptIndex: true },
    });

    // Append a `system` LeadActivity row so the new attempt's
    // timeline starts with a clear "reactivated from {prev}" entry.
    // (D2.5 also surfaces this in the lead detail UI.)
    if (previous) {
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId: lead.id,
          type: 'system',
          actionSource: 'system',
          body: `Reactivated as attempt #${lead.attemptIndex} from previous attempt #${previous.attemptIndex}.`,
          payload: {
            event: 'reactivation',
            previousLeadId: previous.id,
            previousAttemptIndex: previous.attemptIndex,
            ruleApplied: decision.ruleApplied,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return lead;
  }

  /** Append the audit row. Always called once per `apply(...)` invocation. */
  private async writeLog(
    tx: Prisma.TransactionClient,
    tenantId: string,
    decision: DuplicateDecision,
    input: DecisionInput,
    resultLeadId: string | null,
    resultReviewId: string | null,
    extra: { reviewIntent?: ReviewIntent } = {},
  ): Promise<void> {
    await tx.duplicateDecisionLog.create({
      data: {
        tenantId,
        contactId: input.contactId,
        phone: input.phone,
        trigger: input.context.trigger,
        matchedLeadIds: [...decision.matchedLeadIds],
        matchedCaptainId: decision.matchedCaptainId,
        ruleApplied: decision.ruleApplied,
        decision: mapDecisionToColumn(decision.decision),
        confidence: decision.confidence,
        actorUserId: input.context.actorUserId,
        resultLeadId,
        resultReviewId,
        payload: {
          reason: decision.reason,
          recommendedOwnerStrategy: decision.recommendedOwnerStrategy,
          matchedOpenLeadId: decision.matchedOpenLeadId,
          companyId: input.context.companyId,
          countryId: input.context.countryId,
          pipelineId: input.context.pipelineId,
          ...(extra.reviewIntent && { reviewIntent: extra.reviewIntent }),
        } as unknown as Prisma.InputJsonValue,
      },
    });
    // Audit verb for cross-tenant analytics. The full payload sits
    // on the duplicate_decision_log row above; the audit row is the
    // dashboard-friendly handle.
    await this.audit.writeInTx(tx, tenantId, {
      action: 'lead.duplicate_decision',
      entityType: 'duplicate_decision_log',
      entityId: null,
      actorUserId: input.context.actorUserId,
      payload: {
        decision: decision.decision,
        ruleApplied: decision.ruleApplied,
        confidence: decision.confidence,
        trigger: input.context.trigger,
        contactId: input.contactId,
      } as unknown as Prisma.InputJsonValue,
    });
  }

  /**
   * Run a callback either inside an existing tx or in a fresh
   * `prisma.withTenant(...)` block. Lets every public method be
   * tx-aware without duplicating the wrapping logic.
   */
  private async runWithMaybeTx<T>(
    tenantId: string,
    tx: Prisma.TransactionClient | null | undefined,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (tx) return fn(tx);
    return this.prisma.withTenant(tenantId, fn);
  }
}

/** Map the rule engine's decision union to the audit column's
 *  shorter, dashboard-friendly enum. */
function mapDecisionToColumn(
  decision: DuplicateDecision['decision'],
): 'created_new_attempt' | 'queued_review' | 'linked_to_existing' | 'rejected' {
  switch (decision) {
    case 'create_first_attempt':
    case 'create_new_attempt':
      return 'created_new_attempt';
    case 'queue_review':
      return 'queued_review';
    case 'link_to_existing':
      return 'linked_to_existing';
    case 'reject_existing_open':
      return 'rejected';
  }
}

/** Translate a rule code into a WhatsAppConversationReview.reason
 *  enum so a caller in the inbound flow (D2.3) can enqueue the
 *  right review row without re-evaluating. */
function ruleToReviewReason(rule: string): ReviewIntent['reason'] {
  if (rule === 'route_to_review_active_captain') return 'captain_active';
  if (rule === 'route_to_review_won') return 'won_lead';
  if (rule === 'route_to_review_cooldown') return 'cooldown';
  return 'duplicate_lead';
}
