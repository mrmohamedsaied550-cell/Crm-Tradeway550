/**
 * Phase D3 — D3.2: feature-flag helper for the SLA / Rotation /
 * Stage-Status / Next-Action engine.
 *
 * `D3_ENGINE_V1` follows the same shape as `LEAD_ATTEMPTS_V2` and
 * `WHATSAPP_INBOUND_V2`:
 *
 *   Resolution order:
 *     1. Explicit env value `'true' | 'false' | '1' | '0'` wins.
 *     2. Otherwise, default depends on `NODE_ENV`:
 *          'production' ⇒ false (opt-in)
 *          everything else ⇒ true.
 *
 * What flips when the flag flips:
 *
 *   FALSE (production default) — the legacy SLA contract is preserved
 *   bit-for-bit:
 *     - SlaService.runReassignmentForBreaches behaviour unchanged.
 *     - The scheduler tick only calls runReassignmentForBreaches.
 *     - No threshold transitions are computed or recorded.
 *     - sla_threshold remains 'ok' on every row (the column default).
 *
 *   TRUE (dev/test default) — the threshold engine is on:
 *     - The scheduler tick adds a per-tenant threshold-recompute pass
 *       AFTER the existing breach scan (existing scan is untouched).
 *     - Threshold transitions are written to `lead.sla_threshold` /
 *       `lead.sla_threshold_at` and emit a single `LeadActivity` row
 *       (`type: 'sla_threshold_crossed'`).
 *     - Rotation / escalation / TL Review Queue remain inert — those
 *       arrive in D3.4+ behind the same flag.
 *
 * Production stays opt-in across every D3.x chunk — flipping the env
 * var is an explicit operator step, exactly like the D2 rollout.
 */
export function isD3EngineV1Enabled(): boolean {
  const raw = process.env['D3_ENGINE_V1'];
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return process.env['NODE_ENV'] !== 'production';
}
