/**
 * Phase D5 — D5.11: audit action-prefix allow-list.
 *
 * The admin audit page's filter chips call the audit list endpoint
 * with `?actionPrefix=<group code>`. The controller translates the
 * code to a canonical list of action prefix strings via this
 * registry. Unknown codes are rejected with a stable
 * `audit.action_prefix.unknown` error — the allow-list is the
 * single source of truth for "which prefixes the audit feed
 * permits filtering by."
 *
 * The registry is intentionally narrow:
 *
 *   • Existing audit verbs we want to surface as governance chips
 *     (rbac.*, role.*, user.scope.*, *.export.completed, etc.).
 *   • One row per chip — never a free-form `startsWith` field
 *     coming from the client. This avoids accidental "leak the
 *     whole audit log" filters via `?actionPrefix=`.
 *   • Codes are SAFE identifiers: snake_case, no dots, no
 *     wildcards. The frontend renders them through i18n keys; the
 *     server uses them only for the allow-list lookup.
 *
 * Adding a new chip later: append a row + update the EN/AR i18n
 * `admin.audit.groups.<code>` keys.
 */

export interface AuditActionGroup {
  /** SAFE allow-list code surfaced to the client. snake_case. */
  readonly code: string;
  /**
   * Canonical action prefix strings the service ORs into the
   * `audit_events.action` filter (each via `startsWith`). Always
   * ends with a dot so prefix matches don't collide with sibling
   * verbs that happen to share a stem. Multi-prefix groups
   * (`export_governance`) cover several namespaces in one chip.
   */
  readonly actionPrefixes: readonly string[];
}

export const AUDIT_ACTION_GROUPS: readonly AuditActionGroup[] = [
  // RBAC governance — role.previewed (D5.10), role.field.update,
  // role.scope.update, role.capability.update written by RbacService.
  { code: 'rbac', actionPrefixes: ['rbac.'] },
  // Role lifecycle — role.create / .update / .duplicate / .delete.
  { code: 'role', actionPrefixes: ['role.'] },
  // User-scope assignment trail.
  { code: 'user_scope', actionPrefixes: ['user.scope.'] },
  // D5.6D-1 / D5.6D-2 — tenant backup export (action prefix
  // `tenant.export.`; today only `tenant.export.completed` exists).
  { code: 'tenant_export', actionPrefixes: ['tenant.export.'] },
  // D5.6C — reports CSV export.
  { code: 'report_export', actionPrefixes: ['report.export.'] },
  // D5.6B — partner reconciliation CSV export.
  { code: 'partner_recon_export', actionPrefixes: ['partner.reconciliation.export.'] },
  // D5.6B — partner commission CSV export.
  { code: 'partner_commission_export', actionPrefixes: ['partner.commission.export.'] },
  // D5.13 — WhatsApp handover governance. Today only
  // `whatsapp.handover.completed` exists; the trailing dot keeps
  // future verbs (`whatsapp.handover.failed`, ...) inside the
  // same chip without a code change.
  { code: 'whatsapp_handover', actionPrefixes: ['whatsapp.handover.'] },
  // Umbrella chip — every governed-export verb in one OR. Order
  // intentional so the more-specific chips above stay first in
  // the rendered strip.
  {
    code: 'export_governance',
    actionPrefixes: [
      'tenant.export.',
      'report.export.',
      'partner.reconciliation.export.',
      'partner.commission.export.',
      'lead.export.',
      'audit.export.',
    ],
  },
] as const;

const BY_CODE: Map<string, AuditActionGroup> = new Map(AUDIT_ACTION_GROUPS.map((g) => [g.code, g]));

/**
 * Look up the canonical action prefix list for an allow-list code.
 * Returns `undefined` for unknown codes so the caller can raise
 * `audit.action_prefix.unknown`.
 */
export function resolveActionPrefixes(code: string | undefined): readonly string[] | undefined {
  if (!code) return undefined;
  return BY_CODE.get(code)?.actionPrefixes;
}

/** Return the list of allow-listed group codes — used by the
 *  controller's typed error response so the operator sees the
 *  valid set. */
export function listActionPrefixCodes(): readonly string[] {
  return AUDIT_ACTION_GROUPS.map((g) => g.code);
}
