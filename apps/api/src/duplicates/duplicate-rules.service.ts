import { Injectable } from '@nestjs/common';

import type { DuplicateRulesConfig } from './duplicate-rules.dto';

/**
 * Phase D2 — D2.2: pure decision engine for duplicate / reactivation
 * outcomes.
 *
 * Pure: no DB, no Nest context, no Prisma. Inputs in, decision out.
 * Caller (DuplicateDecisionService in D2.2; create-paths in D2.3)
 * gathers the matching leads + captain + tenant config, hands them
 * to `evaluate(...)`, and acts on the returned `DuplicateDecision`.
 *
 * Decision space:
 *   - 'create_first_attempt'  — no prior context for this phone.
 *                               attemptIndex starts at 1.
 *   - 'create_new_attempt'    — eligible reactivation; new Lead with
 *                               attemptIndex = previous + 1 and a
 *                               populated previousLeadId.
 *   - 'queue_review'          — ambiguous / sensitive case (active
 *                               captain, won lead, low confidence,
 *                               cool-off still active). Caller
 *                               should enqueue a WhatsApp review row
 *                               (or surface the decision back to a
 *                               human operator for non-WhatsApp
 *                               triggers).
 *   - 'link_to_existing'      — exactly one open lead matches; the
 *                               new context (e.g. an inbound
 *                               WhatsApp conversation) should attach
 *                               to it.
 *   - 'reject_existing_open'  — explicit rejection (e.g. manual
 *                               create attempted while an open lead
 *                               already exists for the phone). The
 *                               caller surfaces a 409 to the user.
 *
 * Confidence:
 *   - 'high'   — single unambiguous match path applied.
 *   - 'medium' — rule fired but a human-readable nuance lurks
 *                (e.g. multiple historical lost leads).
 *   - 'low'    — rules can't decide cleanly; safer to queue.
 *
 * Recommended owner:
 *   - 'route_engine'   — caller should run DistributionService.
 *   - 'previous_owner' — caller should reuse the closed lead's owner.
 *   - 'unassigned'     — caller should leave assignedToId null.
 *
 * The actual create / log / route side-effects live in
 * DuplicateDecisionService; this service only decides.
 */

export type DuplicateDecisionKind =
  | 'create_first_attempt'
  | 'create_new_attempt'
  | 'queue_review'
  | 'link_to_existing'
  | 'reject_existing_open';

export type DuplicateConfidence = 'high' | 'medium' | 'low';

export type RecommendedOwnerStrategy = 'route_engine' | 'previous_owner' | 'unassigned';

/**
 * Stable rule codes — each value is a column-friendly string suited
 * for dashboarding (`SELECT rule_applied, count(*) ...`). Adding a
 * code requires only a new entry; the audit log column is plain
 * TEXT so no migration is needed.
 */
export type RuleApplied =
  | 'create_first_attempt'
  | 'reactivate_lost_aged_out'
  | 'reactivate_no_answer_aged_out'
  | 'route_to_review_active_captain'
  | 'route_to_review_won'
  | 'route_to_review_open_lead'
  | 'route_to_review_cooldown'
  | 'route_to_review_low_confidence'
  | 'route_to_review_cross_pipeline'
  | 'reject_existing_open'
  | 'link_to_existing_open'
  | 'manual_override';

/** Where the trigger came from. Mirrors DuplicateDecisionLog.trigger. */
export type DuplicateTrigger =
  | 'manual'
  | 'csv'
  | 'meta'
  | 'whatsapp_inbound'
  | 'review_resolve_new_lead'
  | 'review_resolve_new_attempt'
  | 'manual_override';

/**
 * A single matching lead, stripped to the fields the rule engine
 * needs. Caller MUST scope this to the same tenant; the engine
 * does no tenant validation itself.
 */
export interface MatchingLead {
  id: string;
  /** Lifecycle classifier — 'open' | 'won' | 'lost' | 'archived'. */
  lifecycleState: string;
  /** Stage code on the matching lead. Used for cool-off context. */
  stageCode: string | null;
  /** Lost-reason code if lifecycleState === 'lost', else null. */
  lostReasonCode: string | null;
  /**
   * The "closed at" timestamp — i.e., when the lead reached its
   * terminal stage. For lost leads this is the cool-off anchor.
   * For open leads this is null. Callers should pass the lead's
   * `updatedAt` for closed leads; we assume no further mutation
   * after terminal entry under the existing service contract.
   */
  closedAt: Date | null;
  /** Pipeline + scope context — used for crossPipelineMatch logic. */
  pipelineId: string | null;
  companyId: string | null;
  countryId: string | null;
  /** Owner of the matching lead — used for `previous_owner` recommendation. */
  assignedToId: string | null;
  /**
   * The lead's own attemptIndex. Used by the orchestrator to
   * compute the next attempt's index.
   */
  attemptIndex: number;
}

/** Active captain matching the phone (Captain.status === 'active'). */
export interface MatchingCaptain {
  id: string;
  status: string;
  leadId: string;
}

/** Inbound context the rule engine needs to evaluate. */
export interface DuplicateContext {
  /** Phone in E.164 form (already normalised by the caller). */
  phone: string;
  trigger: DuplicateTrigger;
  /** Pipeline scope of the new attempt request. NULL on legacy paths
   *  that don't carry pipeline context (e.g. manual create with no
   *  pipeline preference); the engine treats null as "wildcard". */
  companyId: string | null;
  countryId: string | null;
  pipelineId: string | null;
  /** Actor — user or system. NULL for purely automated triggers. */
  actorUserId: string | null;
}

/** Decision returned by `evaluate(...)`. */
export interface DuplicateDecision {
  decision: DuplicateDecisionKind;
  ruleApplied: RuleApplied;
  confidence: DuplicateConfidence;
  /** Human-readable explanation; embedded into the audit log payload. */
  reason: string;
  /** When `create_new_attempt`, the predecessor lead the new attempt
   *  chains from. Otherwise null. */
  previousLeadId: string | null;
  /** When the decision involves the existing open lead (link / reject). */
  matchedOpenLeadId: string | null;
  /** Captain id when the decision was driven by an active-captain match. */
  matchedCaptainId: string | null;
  /** All matched lead ids fed into the engine — surfaced verbatim
   *  into the audit log so downstream filtering doesn't need a
   *  re-query. */
  matchedLeadIds: readonly string[];
  /** What ownership strategy the orchestrator should apply on
   *  `create_new_attempt`. Ignored for other decision kinds. */
  recommendedOwnerStrategy: RecommendedOwnerStrategy;
}

@Injectable()
export class DuplicateRulesService {
  /**
   * Pure rule evaluation. Inputs in, decision out. Side-effects
   * (audit log, create, link) live in DuplicateDecisionService.
   *
   * Algorithm (in this order):
   *   1. Active-captain match → queue_review (captainBehavior).
   *   2. Cross-pipeline filter — if `crossPipelineMatch=false`, drop
   *      matches from a different (companyId | countryId | pipelineId)
   *      from consideration. The remaining set drives steps 3..6.
   *   3. Open-lead match → link_to_existing OR reject_existing_open
   *      depending on `trigger` (inbound flows link; manual creates
   *      reject so the user sees a 409).
   *   4. Won-lead match → queue_review (wonBehavior).
   *   5. Lost-lead match → reactivate if cool-off elapsed, otherwise
   *      queue_review.
   *   6. Otherwise → create_first_attempt (no prior context).
   */
  evaluate(input: {
    context: DuplicateContext;
    matchingLeads: readonly MatchingLead[];
    matchingCaptain: MatchingCaptain | null;
    rules: DuplicateRulesConfig;
    /** `now` is injectable so tests can pin time. Defaults to wall clock. */
    now?: Date;
  }): DuplicateDecision {
    const now = input.now ?? new Date();
    const allMatchedIds = input.matchingLeads.map((l) => l.id);

    // 1. Active captain match — captainBehavior is locked to
    // 'always_review'. We explicitly don't auto-create here; the
    // operator decides via the WhatsApp review queue (existing
    // captain_active reason) or via manual override (D2.4 UI).
    if (input.matchingCaptain && input.matchingCaptain.status === 'active') {
      return {
        decision: 'queue_review',
        ruleApplied: 'route_to_review_active_captain',
        confidence: 'high',
        reason:
          'An active captain row exists for this phone; never auto-create a new sales attempt.',
        previousLeadId: null,
        matchedOpenLeadId: null,
        matchedCaptainId: input.matchingCaptain.id,
        matchedLeadIds: allMatchedIds,
        recommendedOwnerStrategy: 'unassigned',
      };
    }

    // 2. Cross-pipeline filter. When `crossPipelineMatch=false`, a
    // match in a DIFFERENT (company, country, pipeline) is treated
    // as "no match" for blocking purposes — we still surface it in
    // matchedLeadIds for the audit log, but the in-scope set drives
    // the rest of the decision.
    const inScopeMatches = input.rules.crossPipelineMatch
      ? input.matchingLeads
      : input.matchingLeads.filter((l) => sameScope(l, input.context));
    const droppedCrossPipeline = input.matchingLeads.length - inScopeMatches.length;

    // 3. Open-lead match in scope.
    const openMatch = inScopeMatches.find((l) => l.lifecycleState === 'open');
    if (openMatch) {
      // Inbound flows (whatsapp_inbound + review-resolve from inbound)
      // typically WANT to link the conversation to the existing open
      // lead; manual / CSV / Meta creates should reject so the
      // operator sees a clear 409 and decides explicitly.
      const linkable =
        input.context.trigger === 'whatsapp_inbound' ||
        input.context.trigger === 'review_resolve_new_lead' ||
        input.context.trigger === 'review_resolve_new_attempt';
      if (linkable) {
        return {
          decision: 'link_to_existing',
          ruleApplied: 'link_to_existing_open',
          confidence: 'high',
          reason: 'An open lead already exists in scope; attach the new context to it.',
          previousLeadId: null,
          matchedOpenLeadId: openMatch.id,
          matchedCaptainId: null,
          matchedLeadIds: allMatchedIds,
          recommendedOwnerStrategy: 'previous_owner',
        };
      }
      return {
        decision: 'reject_existing_open',
        ruleApplied: 'reject_existing_open',
        confidence: 'high',
        reason:
          'An open lead already exists for this phone; the create path must reject so the operator picks an explicit action.',
        previousLeadId: null,
        matchedOpenLeadId: openMatch.id,
        matchedCaptainId: null,
        matchedLeadIds: allMatchedIds,
        recommendedOwnerStrategy: 'unassigned',
      };
    }

    // 4. Won-lead match — captain promotion is the existing happy
    // path; a "won" lead without an active captain is unusual and
    // worth a human eyeball. wonBehavior is locked to 'always_review'.
    const wonMatch = inScopeMatches.find((l) => l.lifecycleState === 'won');
    if (wonMatch) {
      return {
        decision: 'queue_review',
        ruleApplied: 'route_to_review_won',
        confidence: 'high',
        reason:
          'A won lead exists for this phone; route to review so the operator confirms whether to re-enroll.',
        previousLeadId: null,
        matchedOpenLeadId: null,
        matchedCaptainId: null,
        matchedLeadIds: allMatchedIds,
        recommendedOwnerStrategy: 'unassigned',
      };
    }

    // 5. Lost-lead match — eligible for reactivation if the cool-off
    // elapsed. Pick the most recently closed lost lead as the
    // predecessor (its outcome is the freshest signal).
    const lostMatches = inScopeMatches
      .filter((l) => l.lifecycleState === 'lost')
      .sort((a, b) => closedAtTime(b) - closedAtTime(a));
    const mostRecentLost = lostMatches[0];
    if (mostRecentLost) {
      const ageDays = ageInDays(mostRecentLost.closedAt, now);
      const isNoAnswer = mostRecentLost.lostReasonCode
        ? input.rules.reactivateNoAnswerLostReasonCodes.includes(mostRecentLost.lostReasonCode)
        : false;
      const requiredDays = isNoAnswer
        ? input.rules.reactivateNoAnswerAfterDays
        : input.rules.reactivateLostAfterDays;
      if (ageDays >= requiredDays) {
        return {
          decision: 'create_new_attempt',
          ruleApplied: isNoAnswer ? 'reactivate_no_answer_aged_out' : 'reactivate_lost_aged_out',
          // Multiple historical lost leads → still reactivatable, but
          // mark as `medium` so dashboards can spot heavy retry cases.
          confidence: lostMatches.length > 1 ? 'medium' : 'high',
          reason: isNoAnswer
            ? `Previous attempt closed as no-answer ${ageDays} days ago; cool-off (${requiredDays}d) elapsed.`
            : `Previous attempt lost ${ageDays} days ago; cool-off (${requiredDays}d) elapsed.`,
          previousLeadId: mostRecentLost.id,
          matchedOpenLeadId: null,
          matchedCaptainId: null,
          matchedLeadIds: allMatchedIds,
          recommendedOwnerStrategy: input.rules.ownershipOnReactivation,
        };
      }
      return {
        decision: 'queue_review',
        ruleApplied: 'route_to_review_cooldown',
        confidence: 'medium',
        reason: `Previous lost attempt is ${ageDays} day(s) old; cool-off (${requiredDays}d) hasn't elapsed.`,
        previousLeadId: mostRecentLost.id,
        matchedOpenLeadId: null,
        matchedCaptainId: null,
        matchedLeadIds: allMatchedIds,
        recommendedOwnerStrategy: 'unassigned',
      };
    }

    // 6. No in-scope match. If there were cross-pipeline matches we
    // dropped, surface that as a `medium`-confidence first attempt
    // with a distinct rule code so dashboards can find these for
    // policy review.
    if (droppedCrossPipeline > 0) {
      return {
        decision: 'create_first_attempt',
        ruleApplied: 'route_to_review_cross_pipeline',
        confidence: 'medium',
        reason: `${droppedCrossPipeline} matching lead(s) exist in a different pipeline / company / country; tenant rule allows the new attempt.`,
        previousLeadId: null,
        matchedOpenLeadId: null,
        matchedCaptainId: null,
        matchedLeadIds: allMatchedIds,
        // First-attempt creation always routes through the engine —
        // there's no previous owner to fall back to.
        recommendedOwnerStrategy: 'route_engine',
      };
    }

    // No prior context for this phone. Standard first attempt.
    return {
      decision: 'create_first_attempt',
      ruleApplied: 'create_first_attempt',
      confidence: 'high',
      reason: 'No prior lead or captain matches this phone; this is the first attempt.',
      previousLeadId: null,
      matchedOpenLeadId: null,
      matchedCaptainId: null,
      matchedLeadIds: allMatchedIds,
      recommendedOwnerStrategy: 'route_engine',
    };
  }
}

/** Match-scope predicate. Two leads share a scope when their
 *  pipeline + company + country triple agrees with the inbound
 *  context. NULL on the lead matches anything (legacy rows). */
function sameScope(lead: MatchingLead, ctx: DuplicateContext): boolean {
  if (lead.pipelineId !== null && ctx.pipelineId !== null && lead.pipelineId !== ctx.pipelineId) {
    return false;
  }
  if (lead.companyId !== null && ctx.companyId !== null && lead.companyId !== ctx.companyId) {
    return false;
  }
  if (lead.countryId !== null && ctx.countryId !== null && lead.countryId !== ctx.countryId) {
    return false;
  }
  return true;
}

/** Days elapsed between `closedAt` and `now`, floored. NULL closedAt
 *  yields Infinity (treats "unknown close time" as fully aged out
 *  rather than blocking; the orchestrator is conservative about
 *  filling closedAt for terminal leads). */
function ageInDays(closedAt: Date | null, now: Date): number {
  if (!closedAt) return Number.POSITIVE_INFINITY;
  const ms = now.getTime() - closedAt.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function closedAtTime(lead: MatchingLead): number {
  return lead.closedAt ? lead.closedAt.getTime() : 0;
}
