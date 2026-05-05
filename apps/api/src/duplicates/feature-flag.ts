/**
 * Phase D2 — D2.2: feature-flag helper for the multi-attempt /
 * reactivation engine.
 *
 * `LEAD_ATTEMPTS_V2` follows the same shape as `WHATSAPP_INBOUND_V2`:
 *
 *   Resolution order:
 *     1. Explicit env value `'true' | 'false' | '1' | '0'` wins.
 *     2. Otherwise, default depends on `NODE_ENV`:
 *          'production' ⇒ false (opt-in)
 *          everything else ⇒ true.
 *
 * D2.2 is service-only; even when the flag resolves true, NO existing
 * create path invokes the new services yet. The flag becomes visibly
 * active in D2.3 (when the manual / CSV / Meta / WhatsApp inbound /
 * review-resolve paths start delegating to DuplicateDecisionService).
 *
 * Production stays opt-in across D2.x — flipping the env var is an
 * explicit operator step.
 */
export function isLeadAttemptsV2Enabled(): boolean {
  const raw = process.env['LEAD_ATTEMPTS_V2'];
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return process.env['NODE_ENV'] !== 'production';
}
