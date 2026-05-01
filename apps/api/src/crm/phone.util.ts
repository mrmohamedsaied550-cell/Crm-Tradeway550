/**
 * Phone number normalisation for the CRM.
 *
 * Accepts user input with spaces, dashes, parentheses, leading `+`,
 * leading `00`, OR bare-digit country-code-prefixed input (the format
 * WhatsApp Cloud delivers — e.g. `201001234567` for a Cairo number).
 * Produces a strict E.164 string of the form `^\+\d{8,15}$`. Throws on
 * input that cannot be coerced.
 *
 * Per-tenant default country prefix is out of scope for C10 — callers
 * must pass already-prefixed input. (Egypt-default mapping arrives with
 * the tenant configuration model in a later chunk.)
 */

const CLEAN_RE = /[\s\-()]/g;
const E164_RE = /^\+\d{8,15}$/;
/** Bare digits that already carry a country code (first digit != 0). */
const BARE_DIGITS_RE = /^[1-9]\d{7,14}$/;

export function normalizeE164(input: string): string {
  if (typeof input !== 'string') {
    throw new Error('Phone must be a string');
  }
  let stripped = input.trim().replace(CLEAN_RE, '');
  // Allow `00...` international prefix as a synonym for `+`.
  if (stripped.startsWith('00')) {
    stripped = '+' + stripped.slice(2);
  }
  // Allow bare-digit input that already carries a country code (first
  // digit non-zero, 8–15 digits total). This is what WhatsApp Cloud
  // delivers in webhook payloads. Local-format numbers starting with
  // `0` (e.g. Egyptian `01001234567`) are still rejected — they need
  // an explicit country code.
  if (BARE_DIGITS_RE.test(stripped)) {
    stripped = '+' + stripped;
  }
  if (!E164_RE.test(stripped)) {
    throw new Error(`Invalid phone number: must be E.164 (e.g. +201001234567), got "${input}"`);
  }
  return stripped;
}

export function isValidE164(value: string): boolean {
  return E164_RE.test(value);
}

const LOCAL_LEADING_ZERO_RE = /^0\d{6,14}$/u;
const DIAL_CODE_RE = /^\+\d{1,4}$/u;

/**
 * P2-08 — same as `normalizeE164`, but accepts a tenant default
 * dial code (e.g. `"+20"`). Local-format input that starts with a
 * single leading `0` (Egyptian `01001234567`, Saudi `0501234567`)
 * has the leading `0` stripped and the dial code prepended:
 *
 *     "01001234567" + defaultDialCode "+20"  →  "+201001234567"
 *
 * Already-prefixed input (`+`, `00`, or bare-digit with non-zero
 * first digit) takes the strict `normalizeE164` path unchanged, so
 * an admin who copy-pastes a properly-formatted E.164 string still
 * gets the same result regardless of which tenant they're on.
 *
 * `defaultDialCode` itself is validated at the boundary — a bogus
 * value (`"egypt"`, `"+x"`, ...) throws before we touch the input.
 */
export function normalizeE164WithDefault(input: string, defaultDialCode: string): string {
  if (typeof defaultDialCode !== 'string' || !DIAL_CODE_RE.test(defaultDialCode)) {
    throw new Error(
      `Invalid tenant default dial code: must be E.164 country prefix (e.g. "+20"), got "${defaultDialCode}"`,
    );
  }
  if (typeof input !== 'string') {
    throw new Error('Phone must be a string');
  }
  const stripped = input.trim().replace(CLEAN_RE, '');
  // Local-format with single leading 0 → swap it for the dial code.
  // We only kick in here when the input ISN'T already an E.164 / 00
  // / bare-international shape, i.e. exactly one leading 0 and 7..15
  // total digits. Falling through to `normalizeE164` keeps the
  // strict path's error messaging consistent.
  if (LOCAL_LEADING_ZERO_RE.test(stripped)) {
    return normalizeE164(defaultDialCode + stripped.slice(1));
  }
  return normalizeE164(input);
}
