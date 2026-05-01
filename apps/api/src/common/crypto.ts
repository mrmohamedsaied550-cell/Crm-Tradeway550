import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isProduction } from './env';

/**
 * P2-05 — symmetric encryption for at-rest secrets (WhatsApp access
 * tokens today; extensible to other "must not be readable from a
 * dump" columns later).
 *
 * Algorithm: AES-256-GCM.
 *   - 256-bit key (32 bytes, base64-encoded in the env var).
 *   - Random 96-bit IV per ciphertext (12 bytes; the GCM optimum).
 *   - 128-bit auth tag, verified on decrypt; tampered ciphertexts
 *     throw and never produce plaintext.
 *
 * Wire format (one self-contained string per encrypted column value):
 *
 *     v1:<iv_b64url>:<tag_b64url>:<ciphertext_b64url>
 *
 *   - The `v1:` prefix lets us:
 *       a) detect "this field has been encrypted" without a side-band
 *          schema change (so old plaintext rows can be migrated
 *          lazily — every read is tolerant, every write produces v1
 *          ciphertext),
 *       b) rotate to a `v2:` algorithm later without touching the
 *          column type.
 *   - All three parts are base64url (no `+`, `/`, `=`) so the value
 *     stays URL/log/JSON-safe and round-trips through copy-paste in
 *     admin tooling.
 *
 * Key management: the key is read from `FIELD_ENCRYPTION_KEY` (or its
 * legacy alias `WHATSAPP_TOKEN_ENCRYPTION_KEY`). The env var carries
 * a base64-encoded 32-byte buffer:
 *
 *     export FIELD_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
 *
 * In production a missing or wrong-sized key fails fast at startup.
 * In dev / test, a missing key falls back to an in-memory key (a
 * one-time random buffer per process) so local development against a
 * fresh seed doesn't require any env-var setup. That fallback IS
 * production-disabled.
 */

const VERSION_PREFIX = 'v1:';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM optimum
const TAG_BYTES = 16; // 128-bit auth tag
const ENV_KEY_NAMES = ['FIELD_ENCRYPTION_KEY', 'WHATSAPP_TOKEN_ENCRYPTION_KEY'] as const;

let cachedKey: Buffer | null = null;

/**
 * Load and cache the field-encryption key.
 *
 * Resolution order:
 *   1. `FIELD_ENCRYPTION_KEY` (preferred — forward-looking name).
 *   2. `WHATSAPP_TOKEN_ENCRYPTION_KEY` (alias kept while operators
 *      migrate; a deprecation log is the only signal).
 *   3. In NON-production, a per-process random key. Production
 *      ALWAYS requires an explicit env var so a deploy without it
 *      fails before serving traffic instead of silently generating
 *      keys that disappear on every restart.
 */
export function loadFieldEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  if (cachedKey) return cachedKey;

  for (const name of ENV_KEY_NAMES) {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(raw, 'base64');
    } catch {
      throw new Error(`crypto: ${name} must be base64-encoded`);
    }
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `crypto: ${name} must decode to ${KEY_BYTES} bytes (got ${buf.length}); ` +
          `regenerate with: node -e "console.log(require('crypto').randomBytes(${KEY_BYTES}).toString('base64'))"`,
      );
    }
    cachedKey = buf;
    return buf;
  }

  if (isProduction(env)) {
    throw new Error(
      `crypto: ${ENV_KEY_NAMES[0]} is required in production. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(${KEY_BYTES}).toString('base64'))"`,
    );
  }

  // Dev / test fallback. Use a 32-byte random key so the algorithm is
  // exercised end-to-end, but make NO promise about its persistence:
  // every process restart produces a new key, so any rows encrypted
  // with the old key become unreadable. That's by design — local
  // development should set FIELD_ENCRYPTION_KEY explicitly the moment
  // it cares about persistence.
  cachedKey = randomBytes(KEY_BYTES);
  return cachedKey;
}

/** Test-only — clear the cached key so a test can swap envs. */
export function __resetFieldEncryptionKeyForTesting(): void {
  cachedKey = null;
}

/**
 * Encrypt `plaintext` and return the wire-format string.
 *
 * Throws on:
 *   - non-string input,
 *   - missing/wrong-sized key (via `loadFieldEncryptionKey`).
 *
 * An empty string round-trips faithfully (so callers can keep using
 * the same shape for "value present but empty" without special
 * casing).
 */
export function encryptSecret(plaintext: string, key: Buffer = loadFieldEncryptionKey()): string {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encryptSecret: plaintext must be a string');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return VERSION_PREFIX + toBase64Url(iv) + ':' + toBase64Url(tag) + ':' + toBase64Url(ct);
}

/**
 * Decrypt a `v1:` wire-format string. Lenient on legacy plaintext:
 * any input that does NOT start with `v1:` is returned verbatim.
 * That's how the lazy migration path works — rows written before
 * P2-05 deploy are still readable, and the very next write upgrades
 * them to ciphertext.
 *
 * Throws on:
 *   - malformed v1 payloads (wrong segment count, non-base64),
 *   - tampered ciphertexts (GCM auth-tag mismatch),
 *   - wrong key (also surfaces as auth-tag mismatch).
 */
export function decryptSecret(stored: string, key: Buffer = loadFieldEncryptionKey()): string {
  if (typeof stored !== 'string') {
    throw new TypeError('decryptSecret: input must be a string');
  }
  if (!stored.startsWith(VERSION_PREFIX)) {
    // Legacy plaintext. See the file-level docstring on the lazy
    // migration policy.
    return stored;
  }
  const body = stored.slice(VERSION_PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) {
    throw new Error('crypto: malformed v1 payload (expected 3 segments)');
  }
  const [ivPart, tagPart, ctPart] = parts as [string, string, string];
  const iv = fromBase64Url(ivPart);
  const tag = fromBase64Url(tagPart);
  const ct = fromBase64Url(ctPart);
  if (iv.length !== IV_BYTES) throw new Error('crypto: malformed v1 payload (iv size)');
  if (tag.length !== TAG_BYTES) throw new Error('crypto: malformed v1 payload (tag size)');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // GCM throws on tag mismatch from `final()`. We let it surface so
  // the caller knows the ciphertext was tampered with or the wrong
  // key is in use.
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Quick boolean test for the v1 prefix. Useful in migration tooling. */
export function isFieldEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(VERSION_PREFIX);
}

// ─── base64url helpers ─────────────────────────────────────────────

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Buffer {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}
