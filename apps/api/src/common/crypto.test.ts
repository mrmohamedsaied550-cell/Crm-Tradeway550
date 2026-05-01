/**
 * P2-05 — unit tests for the field-encryption helpers.
 *
 * No DB. Pure crypto behaviour:
 *   - round-trip: decrypt(encrypt(x)) === x
 *   - ciphertexts vary across calls (random IV)
 *   - tamper detection (GCM auth tag fails closed)
 *   - wire format (v1:iv:tag:ct, base64url)
 *   - legacy plaintext is returned verbatim by decryptSecret
 *   - key loader rejects wrong-sized keys
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  __resetFieldEncryptionKeyForTesting,
  decryptSecret,
  encryptSecret,
  isFieldEncrypted,
  loadFieldEncryptionKey,
} from './crypto';

const KEY = randomBytes(32);

describe('common — crypto (P2-05)', () => {
  it('round-trips a UTF-8 string', () => {
    const original = 'EAAxxxxxx-this-is-a-fake-meta-token-with-اللغة-العربية';
    const cipher = encryptSecret(original, KEY);
    assert.match(cipher, /^v1:/);
    assert.equal(decryptSecret(cipher, KEY), original);
  });

  it('round-trips an empty string', () => {
    const cipher = encryptSecret('', KEY);
    assert.match(cipher, /^v1:/);
    assert.equal(decryptSecret(cipher, KEY), '');
  });

  it('produces a different ciphertext for the same plaintext (random IV)', () => {
    const a = encryptSecret('same', KEY);
    const b = encryptSecret('same', KEY);
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a, KEY), 'same');
    assert.equal(decryptSecret(b, KEY), 'same');
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const cipher = encryptSecret('top secret', KEY);
    // Flip a character in the ciphertext segment.
    const parts = cipher.split(':');
    const ct = parts[3] ?? '';
    const flipped = ct.charAt(0) === 'A' ? 'B' + ct.slice(1) : 'A' + ct.slice(1);
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${flipped}`;
    assert.throws(() => decryptSecret(tampered, KEY));
  });

  it('rejects a ciphertext encrypted with a different key', () => {
    const cipher = encryptSecret('cross-key', KEY);
    const otherKey = randomBytes(32);
    assert.throws(() => decryptSecret(cipher, otherKey));
  });

  it('returns legacy plaintext (no v1: prefix) verbatim', () => {
    const legacy = 'legacy-plaintext-token';
    assert.equal(decryptSecret(legacy, KEY), legacy);
    assert.equal(isFieldEncrypted(legacy), false);
  });

  it('rejects a malformed v1 payload', () => {
    assert.throws(() => decryptSecret('v1:only-one-segment', KEY));
    assert.throws(() => decryptSecret('v1::bad::', KEY));
  });

  it('isFieldEncrypted detects the v1 prefix', () => {
    const cipher = encryptSecret('x', KEY);
    assert.equal(isFieldEncrypted(cipher), true);
    assert.equal(isFieldEncrypted('plain'), false);
    assert.equal(isFieldEncrypted(null), false);
    assert.equal(isFieldEncrypted(undefined), false);
  });

  it('loadFieldEncryptionKey accepts a 32-byte base64 key from the env', () => {
    __resetFieldEncryptionKeyForTesting();
    const key = randomBytes(32);
    const loaded = loadFieldEncryptionKey({
      NODE_ENV: 'test',
      FIELD_ENCRYPTION_KEY: key.toString('base64'),
    });
    assert.equal(loaded.length, 32);
    assert.deepEqual(loaded, key);
  });

  it('loadFieldEncryptionKey rejects a wrong-sized key', () => {
    __resetFieldEncryptionKeyForTesting();
    const tooShort = randomBytes(16).toString('base64');
    assert.throws(
      () => loadFieldEncryptionKey({ NODE_ENV: 'test', FIELD_ENCRYPTION_KEY: tooShort }),
      /must decode to 32 bytes/,
    );
  });

  it('loadFieldEncryptionKey rejects a missing key in production', () => {
    __resetFieldEncryptionKeyForTesting();
    assert.throws(
      () => loadFieldEncryptionKey({ NODE_ENV: 'production' }),
      /required in production/,
    );
    __resetFieldEncryptionKeyForTesting();
  });

  it('loadFieldEncryptionKey falls back to a per-process random key in dev', () => {
    __resetFieldEncryptionKeyForTesting();
    const k = loadFieldEncryptionKey({ NODE_ENV: 'development' });
    assert.equal(k.length, 32);
    // Cached: a second call returns the same buffer.
    const k2 = loadFieldEncryptionKey({ NODE_ENV: 'development' });
    assert.equal(k, k2);
    __resetFieldEncryptionKeyForTesting();
  });

  it('accepts the legacy WHATSAPP_TOKEN_ENCRYPTION_KEY env var', () => {
    __resetFieldEncryptionKeyForTesting();
    const key = randomBytes(32);
    const loaded = loadFieldEncryptionKey({
      NODE_ENV: 'test',
      WHATSAPP_TOKEN_ENCRYPTION_KEY: key.toString('base64'),
    });
    assert.deepEqual(loaded, key);
    __resetFieldEncryptionKeyForTesting();
  });
});
