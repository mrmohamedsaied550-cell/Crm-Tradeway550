/**
 * Phase D5 — D5.11: client-side governance audit helpers.
 *
 * The admin audit page renders human-readable labels + safe
 * metadata summaries for the governance verbs added across D5.6 –
 * D5.10:
 *
 *   • rbac.role.previewed                       (D5.10)
 *   • role.create / .update / .duplicate / .delete
 *   • role.capability.update
 *   • role.scope.update
 *   • role.field.update
 *   • user.scope.assign / .update / .revoke
 *   • tenant.export.completed                   (D5.6D-1)
 *   • report.export.completed                   (D5.6C)
 *   • partner.reconciliation.export.completed    (D5.6B)
 *   • partner.commission.export.completed        (D5.6B)
 *   • lead.export.completed                      (reserved)
 *   • audit.export.completed                     (reserved)
 *   • field_write_denied                          (C5.5)
 *
 * For each verb the helper:
 *
 *   1. Returns a localised label (`groups.actions.<verb>`).
 *   2. Builds a SAFE one-line metadata summary that names rows
 *      shipped, columns redacted, table count, target role code,
 *      warning count, etc. NEVER raw row values, NEVER PII.
 *
 * The chip strip on /admin/audit calls these helpers; the audit
 * row payload itself is server-controlled (every governance verb
 * already ships metadata-only payloads — see D5.6A-D + D5.10).
 */

import type { AuditRow } from './api';

/** Frontend mirror of `AUDIT_ACTION_GROUPS` codes — keep in sync. */
export const AUDIT_ACTION_GROUP_CODES = [
  'rbac',
  'role',
  'user_scope',
  'tenant_export',
  'report_export',
  'partner_recon_export',
  'partner_commission_export',
  'whatsapp_handover',
  'export_governance',
] as const;

export type AuditActionGroupCode = (typeof AUDIT_ACTION_GROUP_CODES)[number];

/**
 * The action-prefixes that mark a row as "governance" — `isGovernanceAction`
 * checks `startsWith` on every entry. Drives the chip-style rendering
 * (warning-toned badge + human-readable label) on /admin/audit.
 */
const GOVERNANCE_PREFIXES: readonly string[] = [
  'rbac.',
  'role.',
  'user.scope.',
  'tenant.export.',
  'report.export.',
  'partner.reconciliation.export.',
  'partner.commission.export.',
  'lead.export.',
  'audit.export.',
  // D5.13 — WhatsApp handover audit verb. The chip strip filters
  // by prefix; the row renderer routes through
  // `governanceActionLabel` + `summariseAuditPayload` below so
  // the row shows safe metadata only (no fromUserId, no summary
  // text — server-side audit row already excludes them).
  'whatsapp.handover.',
];

/**
 * Phase D5 — D5.11: returns true when the audit row's action
 * matches one of the governance prefixes. The page uses this to
 * pick the rendering path: governance verbs get the labelled
 * badge + safe metadata summary; everything else uses the legacy
 * generic key-value summariser.
 */
export function isGovernanceAction(action: string): boolean {
  for (const p of GOVERNANCE_PREFIXES) {
    if (action.startsWith(p)) return true;
  }
  return false;
}

type Translator = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Localised human-readable label for a governance verb. Falls back
 * to the raw action code when the translation key is missing — the
 * page also displays the raw code alongside, so a missing label
 * never breaks the audit feed.
 */
export function governanceActionLabel(t: Translator, action: string): string {
  return t(`actions.${action}` as 'actions.rbac.role.previewed');
}

/**
 * Phase D5 — D5.11: build a one-line, sanitised metadata summary
 * for a governance audit row. Inspects the audit payload for
 * well-known keys (rowCount, redacted, tableNames, etc.) and
 * renders a short string. Never echoes raw payload VALUES —
 * everything is structural. Empty string when the payload carries
 * nothing the helper recognises (the page falls back to no
 * metadata rather than dumping JSON).
 */
export function summariseAuditPayload(action: string, payload: AuditRow['payload']): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];

  // Common export-governance shape (D5.6A audit envelope).
  if (typeof p['rowCount'] === 'number') {
    parts.push(`rows: ${p['rowCount']}`);
  }
  if (Array.isArray(p['tableNames'])) {
    parts.push(`tables: ${p['tableNames'].length}`);
  }
  if (Array.isArray(p['columnsRedacted'])) {
    const n = p['columnsRedacted'].length;
    parts.push(`redacted: ${n}`);
  } else if (p['columnsRedactedByTable'] && typeof p['columnsRedactedByTable'] === 'object') {
    let redacted = 0;
    for (const v of Object.values(p['columnsRedactedByTable'] as Record<string, unknown>)) {
      if (Array.isArray(v)) redacted += v.length;
    }
    parts.push(`redacted: ${redacted}`);
  }
  if (p['redacted'] === true) {
    parts.push('redacted');
  }
  if (p['restorable'] === false) {
    parts.push('non-restorable');
  }
  if (typeof p['bytesShipped'] === 'number') {
    parts.push(`bytes: ${p['bytesShipped']}`);
  }
  if (p['flagState'] === 'on' || p['flagState'] === 'off') {
    parts.push(`flag: ${p['flagState']}`);
  }

  // RBAC role-preview shape (D5.10).
  if (action === 'rbac.role.previewed') {
    if (typeof p['targetRoleCode'] === 'string') {
      parts.push(`target: ${p['targetRoleCode']}`);
    }
    if (typeof p['capabilitiesCount'] === 'number') {
      parts.push(`caps: ${p['capabilitiesCount']}`);
    }
    if (typeof p['deniedReadCount'] === 'number') {
      parts.push(`denied(read): ${p['deniedReadCount']}`);
    }
    if (Array.isArray(p['warnings'])) {
      parts.push(`warnings: ${p['warnings'].length}`);
    }
  }

  // Field-write-denied (C5.5).
  if (action === 'field_write_denied' && Array.isArray(p['deniedFields'])) {
    parts.push(`fields: ${p['deniedFields'].length}`);
  }

  // D5.13 — `whatsapp.handover.completed` summariser. Renders
  // STRUCTURAL metadata only: transfer mode, whether a summary
  // exists (boolean — never the text), whether the recipient
  // was bell-notified. The server-side audit row already
  // excludes `fromUserId` / `toUserId` / the summary text from
  // its payload, so even an attempt to read raw payload here
  // wouldn't leak prior-owner identity. The summariser is the
  // belt over the suspenders.
  if (action === 'whatsapp.handover.completed') {
    if (typeof p['mode'] === 'string') {
      parts.push(`mode: ${p['mode']}`);
    }
    if (p['hasSummary'] === true) {
      parts.push('summary');
    }
    if (p['notify'] === true) {
      parts.push('notified');
    }
  }

  return parts.join(' · ');
}
