import bcrypt from 'bcryptjs';

/**
 * Password hashing utilities for the Trade Way / Captain Masr CRM.
 *
 * Uses bcryptjs (pure-JS bcrypt). Same hash format as the native `bcrypt`
 * package; portable across environments without a native build step.
 *
 * Cost factor is read from the `BCRYPT_ROUNDS` environment variable (default
 * 12). Tests can lower it for speed (e.g. 4) without changing call sites.
 *
 * Hashes are bcrypt strings of the form `$2a$<rounds>$<salt><digest>` and
 * are SAFE to persist; the bcrypt format embeds salt + cost so a single
 * column suffices.
 */

const DEFAULT_BCRYPT_ROUNDS = 12;
const MIN_ROUNDS = 4;
const MAX_ROUNDS = 15;

function readRounds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['BCRYPT_ROUNDS'];
  if (!raw) return DEFAULT_BCRYPT_ROUNDS;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return DEFAULT_BCRYPT_ROUNDS;
  if (n < MIN_ROUNDS) return MIN_ROUNDS;
  if (n > MAX_ROUNDS) return MAX_ROUNDS;
  return n;
}

/**
 * Hash a plaintext password with bcryptjs.
 *
 * @param plain plaintext password (must be non-empty).
 * @param rounds optional override; defaults to BCRYPT_ROUNDS env / 12.
 */
export async function hashPassword(plain: string, rounds?: number): Promise<string> {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword: plaintext is required');
  }
  const cost = rounds ?? readRounds();
  return bcrypt.hash(plain, cost);
}

/**
 * Verify a plaintext password against a stored bcrypt hash.
 *
 * Returns false (never throws) when the hash is malformed — callers can
 * treat any non-true result as "not authenticated" without special-casing.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** Exposed for tests / OpenAPI metadata. */
export function getConfiguredBcryptRounds(env: NodeJS.ProcessEnv = process.env): number {
  return readRounds(env);
}
