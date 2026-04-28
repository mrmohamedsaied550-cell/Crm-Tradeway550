/**
 * Phone number normalisation for the CRM.
 *
 * Accepts user input with spaces, dashes, parentheses, leading `+` or
 * leading `00`, and produces a strict E.164 string of the form
 * `^\+\d{8,15}$`. Throws on input that cannot be coerced.
 *
 * Per-tenant default country prefix is out of scope for C10 — callers
 * must pass already-prefixed input. (Egypt-default mapping arrives with
 * the tenant configuration model in a later chunk.)
 */

const CLEAN_RE = /[\s\-()]/g;
const E164_RE = /^\+\d{8,15}$/;

export function normalizeE164(input: string): string {
  if (typeof input !== 'string') {
    throw new Error('Phone must be a string');
  }
  let stripped = input.trim().replace(CLEAN_RE, '');
  // Allow `00...` international prefix as a synonym for `+`.
  if (stripped.startsWith('00')) {
    stripped = '+' + stripped.slice(2);
  }
  if (!E164_RE.test(stripped)) {
    throw new Error(`Invalid phone number: must be E.164 (e.g. +201001234567), got "${input}"`);
  }
  return stripped;
}

export function isValidE164(value: string): boolean {
  return E164_RE.test(value);
}
