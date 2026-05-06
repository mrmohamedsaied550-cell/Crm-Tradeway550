/**
 * Phase D5 — D5.14: capability dependency graph + risk classification.
 *
 * Pure data + pure helpers. The role builder UI calls
 * `analyseCapabilitySet(proposedCodes)` (via RoleDependencyService)
 * before save and surfaces:
 *
 *   • missing read dependencies — every write/export/admin verb that
 *     needs a paired read cap to be operationally meaningful;
 *   • high-risk caps — broad export / structural admin verbs that
 *     deserve a yellow banner before the admin clicks save;
 *   • lockout-relevant caps — a separate slice that the service
 *     uses to detect "actor is editing their OWN role and just
 *     dropped the cap that lets them keep managing roles".
 *
 * Hard rules:
 *
 *   1. The graph is acyclic. The unit test `dependency graph is
 *      acyclic` enforces this with a topological sort. Any cycle
 *      (`A → B → A`) would cause `expandRequired` to recurse.
 *
 *   2. Dependencies are NEVER auto-granted. The graph drives
 *      WARNINGS only. Silent mutation of the admin's intent would
 *      hide the issue rather than fix it; the dependency-check
 *      endpoint is the chokepoint that surfaces it.
 *
 *   3. The graph references capability codes as plain strings on
 *      purpose: every code lives in `capabilities.registry.ts` (the
 *      seed source of truth). The graph entries are validated
 *      against that registry by the unit test
 *      `every dependency code is in CAPABILITY_DEFINITIONS`. New
 *      capabilities ADDED later that don't appear here are simply
 *      treated as "no dependency known" — the graph is additive.
 */

import { ALL_CAPABILITY_CODES } from './capabilities.registry';

/**
 * `(capability) → (codes the capability needs to be operationally
 * meaningful)` map. The right-hand side is OR'd: a proposed set
 * satisfies the dependency iff at least ONE listed code is present.
 *
 * The most common case is a singleton `[<read cap>]`; multi-entry
 * arrays exist where the dependent code can be satisfied by either
 * of two read surfaces (e.g. `partner.commission.export` reads from
 * the reconciliation surface today, but a future commission-only
 * view could come online — we list both so the warning isn't
 * over-fired).
 */
export const CAPABILITY_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // ─── Leads ─────────────────────────────────────────────────────
  'lead.write': ['lead.read'],
  'lead.assign': ['lead.read'],
  'lead.stage.move': ['lead.read'],
  'lead.activity.write': ['lead.read'],
  'lead.convert': ['lead.read'],
  'lead.import': ['lead.read'],
  'lead.reactivate': ['lead.read'],
  'lead.stage.status.write': ['lead.read'],
  'lead.rotate': ['lead.read'],
  'lead.review.resolve': ['lead.review.read'],
  'lead.export': ['lead.read'],

  // ─── Pipeline / catalogue / org ────────────────────────────────
  'pipeline.write': ['pipeline.read'],
  'meta.leadsource.write': ['meta.leadsource.read'],
  'org.company.write': ['org.company.read'],
  'org.country.write': ['org.country.read'],
  'org.country.holidays.write': ['org.country.read'],
  'org.team.write': ['org.team.read'],

  // ─── Captains ──────────────────────────────────────────────────
  'captain.document.write': ['captain.read'],
  'captain.document.review': ['captain.read'],
  'captain.trip.write': ['captain.read'],

  // ─── Follow-ups ────────────────────────────────────────────────
  'followup.write': ['followup.read'],
  'followup.complete': ['followup.read'],

  // ─── WhatsApp ──────────────────────────────────────────────────
  'whatsapp.account.write': ['whatsapp.account.read'],
  'whatsapp.message.send': ['whatsapp.conversation.read'],
  'whatsapp.media.send': ['whatsapp.conversation.read'],
  'whatsapp.handover': ['whatsapp.conversation.read'],
  'whatsapp.link.lead': ['whatsapp.conversation.read', 'lead.read'],
  'whatsapp.conversation.assign': ['whatsapp.conversation.read'],
  'whatsapp.conversation.close': ['whatsapp.conversation.read'],
  'whatsapp.conversation.reopen': ['whatsapp.conversation.read'],
  'whatsapp.template.write': ['whatsapp.template.read'],
  'whatsapp.contact.write': ['whatsapp.contact.read'],
  'whatsapp.contact.write.raw': ['whatsapp.contact.read', 'whatsapp.contact.write'],
  'whatsapp.review.resolve': ['whatsapp.review.read'],

  // ─── Bonuses / competitions ────────────────────────────────────
  'bonus.write': ['bonus.read'],
  'competition.write': ['competition.read'],

  // ─── Reports / audit ───────────────────────────────────────────
  'report.export': ['report.read'],
  'audit.export': ['audit.read'],

  // ─── Roles / governance ────────────────────────────────────────
  'roles.write': ['roles.read'],
  'permission.preview': ['roles.read'],

  // ─── Tenant settings ───────────────────────────────────────────
  'tenant.settings.write': ['tenant.settings.read'],
  'tenant.duplicate_rules.write': ['tenant.settings.read'],

  // ─── Distribution ──────────────────────────────────────────────
  'distribution.write': ['distribution.read'],

  // ─── Users ─────────────────────────────────────────────────────
  'users.write': ['users.read'],
  'users.disable': ['users.read'],
  'users.reset': ['users.read'],

  // ─── Partners ──────────────────────────────────────────────────
  'partner.source.write': ['partner.source.read'],
  'partner.sync.run': ['partner.source.read'],
  'partner.merge.write': ['partner.verification.read'],
  'partner.evidence.write': ['partner.verification.read'],
  'partner.milestone.write': ['partner.verification.read'],
  'partner.reconciliation.resolve': ['partner.reconciliation.read'],
  'partner.reconciliation.export': ['partner.reconciliation.read'],
  // Commission CSV is a slice of the reconciliation surface today
  // (D5.6B). We accept either reconciliation.read OR verification.read
  // so a finance role that holds verification.read but not
  // reconciliation.read isn't over-fired (the audit row will still
  // show the export was governed).
  'partner.commission.export': ['partner.reconciliation.read', 'partner.verification.read'],
});

/**
 * Capabilities that ship data off-platform or grant structural
 * authority. The role editor surfaces these as a yellow "high-risk"
 * banner so an admin doesn't accidentally hand out tenant-wide
 * exfiltration without thinking.
 *
 * Categories:
 *   • EXPORT — anything that produces a file the user can keep:
 *     `tenant.export` (the legacy whole-tenant JSON dump),
 *     `*.export` (the D5.6 CSV surfaces), and `audit.export`.
 *   • PARTNER_MERGE — `partner.merge.write` writes data INTO
 *     leads/captains from external partner records. The blast
 *     radius is per-row but the verb is irreversible at the row
 *     level (the merge is auditable but rolls forward).
 *   • LOCKOUT_ADMIN — `roles.write` is the godmode that lets an
 *     admin grant ANY other capability, including itself, to any
 *     role. We classify it as high-risk so the admin sees a clear
 *     marker before saving.
 *   • PERMISSION_PREVIEW — `permission.preview` exposes role
 *     STRUCTURE. Granting it broadly can leak the security
 *     posture of the tenant.
 */
export const HIGH_RISK_CAPABILITIES: Readonly<Record<string, HighRiskKind>> = Object.freeze({
  'tenant.export': 'export',
  'lead.export': 'export',
  'audit.export': 'export',
  'report.export': 'export',
  'partner.reconciliation.export': 'export',
  'partner.commission.export': 'export',
  'partner.merge.write': 'partner_merge',
  'roles.write': 'lockout_admin',
  'permission.preview': 'permission_preview',
});

export type HighRiskKind = 'export' | 'partner_merge' | 'lockout_admin' | 'permission_preview';

/**
 * Capabilities the actor's OWN role must keep to stay
 * operationally functional after the save. Removing any of these
 * from the actor's own role triggers a CRITICAL lockout warning
 * + typed-confirmation requirement. The list is conservative on
 * purpose — the goal is "don't let an admin accidentally lock
 * themselves out", not "block every removal".
 *
 *   • `roles.read` / `roles.write` — without these the admin
 *     can't open / save the role editor at all.
 *   • `audit.read` — without this the admin can't see the
 *     governance audit trail to verify their own changes.
 *   • `permission.preview` — without this the admin can't run
 *     the role-preview tool to verify the effect of changes
 *     they're making to other roles. We classify as critical
 *     ONLY when the actor currently holds it (otherwise they
 *     never had access to lose).
 */
export const SELF_LOCKOUT_CAPABILITIES: ReadonlySet<string> = new Set([
  'roles.read',
  'roles.write',
  'audit.read',
  'permission.preview',
]);

/**
 * Capabilities whose removal from the LAST role that holds them
 * would leave the tenant without anyone able to manage roles. The
 * dependency-check endpoint (which has DB access) can detect this
 * by counting other roles in the tenant; the synchronous
 * `analyseCapabilitySet` returns a hint that the caller should
 * run the DB-backed check.
 */
export const TENANT_LAST_KEEPER_CAPABILITIES: ReadonlySet<string> = new Set(['roles.write']);

/**
 * Stable warning code enumeration. Codes (not free text) so the
 * client can localise via `admin.roles.dependency.warnings.<code>`.
 */
export type RoleDependencyWarningCode =
  | 'capability.dependency.missing'
  | 'capability.high_risk.export'
  | 'capability.high_risk.partner_merge'
  | 'capability.high_risk.lockout_admin'
  | 'capability.high_risk.permission_preview'
  | 'capability.lockout.self_required'
  | 'capability.lockout.last_admin'
  | 'role.system_immutable_attempt';

export type RoleDependencyWarningSeverity = 'info' | 'warning' | 'critical';

/**
 * One warning entry. `messageKey` is an i18n key the client looks
 * up; `meta` is structural detail (capability codes, count) the
 * client renders into the localised string. Never carries free-form
 * text or PII.
 */
export interface RoleDependencyWarning {
  readonly code: RoleDependencyWarningCode;
  readonly severity: RoleDependencyWarningSeverity;
  /** Capability the warning is about (or `null` for whole-role concerns). */
  readonly capability: string | null;
  /** When `code === 'capability.dependency.missing'`, the codes any of which would satisfy. */
  readonly dependsOn: readonly string[];
  /** i18n key for the localised sentence. */
  readonly messageKey: string;
  /** Structural metadata for the client renderer. NEVER row values. */
  readonly meta: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Sync analysis of a proposed capability set. The DB-backed
 * checks (last-keeper detection, system-role attempt, self-lockout
 * vs actor's role) live in `RoleDependencyService` — this helper
 * is the pure-function core that drives them.
 */
export function analyseCapabilitySet(
  proposed: readonly string[],
): readonly RoleDependencyWarning[] {
  const set = new Set(proposed);
  const out: RoleDependencyWarning[] = [];

  // Missing-dependency warnings (one per offending code).
  for (const cap of proposed) {
    const needs = CAPABILITY_DEPENDENCIES[cap];
    if (!needs || needs.length === 0) continue;
    const satisfied = needs.some((r) => set.has(r));
    if (!satisfied) {
      out.push({
        code: 'capability.dependency.missing',
        severity: 'warning',
        capability: cap,
        dependsOn: needs,
        messageKey: 'admin.roles.dependency.warnings.dependencyMissing',
        meta: { capability: cap, dependsOn: needs.join(',') },
      });
    }
  }

  // High-risk capability warnings.
  for (const cap of proposed) {
    const kind = HIGH_RISK_CAPABILITIES[cap];
    if (!kind) continue;
    out.push({
      code: `capability.high_risk.${kind}` as RoleDependencyWarningCode,
      severity: 'warning',
      capability: cap,
      dependsOn: [],
      messageKey: `admin.roles.dependency.warnings.highRisk.${kind}`,
      meta: { capability: cap, kind },
    });
  }

  return out;
}

/**
 * Topological-sort cycle check. Returns the ordered codes when the
 * graph is acyclic; throws when a cycle is detected. Used by the
 * unit test (and as a defensive boot-time invariant if a future
 * developer wants to call it from RbacModule).
 */
export function assertDependencyGraphAcyclic(): readonly string[] {
  const inDegree = new Map<string, number>();
  const reverseEdges = new Map<string, Set<string>>();

  for (const node of Object.keys(CAPABILITY_DEPENDENCIES)) {
    if (!inDegree.has(node)) inDegree.set(node, 0);
    const deps = CAPABILITY_DEPENDENCIES[node] ?? [];
    for (const dep of deps) {
      // edge: dep → node (dep must come before node)
      const set = reverseEdges.get(dep) ?? new Set<string>();
      set.add(node);
      reverseEdges.set(dep, set);
      inDegree.set(node, (inDegree.get(node) ?? 0) + 1);
      if (!inDegree.has(dep)) inDegree.set(dep, 0);
    }
  }

  const queue: string[] = [];
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node);
  }

  const ordered: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    ordered.push(n);
    const out = reverseEdges.get(n);
    if (!out) continue;
    for (const next of out) {
      const newDeg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  if (ordered.length !== inDegree.size) {
    const remaining = Array.from(inDegree.entries())
      .filter(([, deg]) => deg > 0)
      .map(([n]) => n);
    throw new Error(`capability-dependencies: cycle detected involving ${remaining.join(', ')}`);
  }

  return ordered;
}

/**
 * Boot-time invariant: every code referenced by the graph (left or
 * right side) must exist in the global registry. Returns the list
 * of unknown codes (empty when valid). Driven from the unit test.
 */
export function unknownCodesInGraph(): readonly string[] {
  const known: ReadonlySet<string> = new Set(ALL_CAPABILITY_CODES);
  const all = new Set<string>();
  for (const [node, deps] of Object.entries(CAPABILITY_DEPENDENCIES)) {
    all.add(node);
    for (const d of deps) all.add(d);
  }
  for (const c of Object.keys(HIGH_RISK_CAPABILITIES)) all.add(c);
  for (const c of SELF_LOCKOUT_CAPABILITIES) all.add(c);
  for (const c of TENANT_LAST_KEEPER_CAPABILITIES) all.add(c);
  return Array.from(all).filter((c) => !known.has(c));
}
