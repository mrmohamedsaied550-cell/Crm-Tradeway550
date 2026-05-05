/**
 * Phase D4 — D4.1: feature-flag helper for the Partner Data Hub.
 *
 * `D4_PARTNER_HUB_V1` follows the same shape as `LEAD_ATTEMPTS_V2`,
 * `WHATSAPP_INBOUND_V2`, and `D3_ENGINE_V1`:
 *
 *   Resolution order:
 *     1. Explicit env value `'true' | 'false' | '1' | '0'` wins.
 *     2. Otherwise, default depends on `NODE_ENV`:
 *          'production' ⇒ false (opt-in)
 *          everything else ⇒ true.
 *
 * What flips when the flag flips:
 *
 *   FALSE (production default) — the Partner Data Hub is dormant:
 *     - Schema is present (additive migration `0039_d4_partner_data_hub`)
 *       but no service writes through it.
 *     - Capability registry is populated but no role bundle yet
 *       grants the `partner.*` codes (D4.1 ships zero default grants).
 *     - No scheduler tick, no admin page, no lead-detail card.
 *     - Every existing runtime path is byte-identical to pre-D4.1.
 *
 *   TRUE (dev/test default) — same as FALSE for D4.1; the flag is
 *   wired now so later chunks (D4.2 partner-source admin, D4.3 sync
 *   engine, D4.4 verification card, D4.5 controlled merge, …) can
 *   gate themselves on it without a separate rollout.
 *
 * Production stays opt-in across every D4.x chunk — flipping the env
 * var is an explicit operator step, exactly like the D2 / D3 rollouts.
 */
export function isD4PartnerHubV1Enabled(): boolean {
  const raw = process.env['D4_PARTNER_HUB_V1'];
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return process.env['NODE_ENV'] !== 'production';
}
