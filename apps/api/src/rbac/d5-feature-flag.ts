/**
 * Phase D5 — D5.1: feature-flag helper for the dynamic-permissions
 * engine.
 *
 * `D5_DYNAMIC_PERMISSIONS_V1` follows the same shape as
 * `D3_ENGINE_V1` and `D4_PARTNER_HUB_V1`:
 *
 *   Resolution order:
 *     1. Explicit env value `'true' | 'false' | '1' | '0'` wins.
 *     2. Otherwise, default depends on `NODE_ENV`:
 *          'production' ⇒ false (opt-in)
 *          everything else ⇒ true.
 *
 * What flips when the flag flips:
 *
 *   FALSE (production default) — D5 stays dormant:
 *     - The new `PermissionResolverService` exists in the DI graph
 *       but no controller / service consults it; behaviour is
 *       byte-identical to D4.
 *     - Cache invalidation hooks still fire; the cache itself is
 *       just a no-op store from the rest of the app's perspective.
 *
 *   TRUE (dev/test default) — same behaviour as FALSE in D5.1.
 *     The flag is wired now so later D5.x chunks (D5.3 redaction
 *     interceptor, D5.6 export whitelist, D5.7 previous-owner
 *     field permissions) can gate themselves on it without a
 *     separate rollout.
 *
 * Production stays opt-in across every D5.x chunk — flipping the
 * env var is an explicit operator step, exactly like the D2 / D3 /
 * D4 rollouts.
 */
export function isD5DynamicPermissionsV1Enabled(): boolean {
  const raw = process.env['D5_DYNAMIC_PERMISSIONS_V1'];
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return process.env['NODE_ENV'] !== 'production';
}
