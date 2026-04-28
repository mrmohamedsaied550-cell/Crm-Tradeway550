/**
 * Unit tests — password hashing utilities. No database needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getConfiguredBcryptRounds, hashPassword, verifyPassword } from './password.util';

const FAST_ROUNDS = 4;

describe('password.util', () => {
  it('hashPassword produces a bcrypt-format string', async () => {
    const hash = await hashPassword('hunter2', FAST_ROUNDS);
    assert.match(hash, /^\$2[aby]\$/, 'must start with bcrypt prefix');
    assert.equal(hash.length, 60, 'bcrypt hashes are 60 chars');
  });

  it('hashPassword rejects empty plaintext', async () => {
    await assert.rejects(() => hashPassword('', FAST_ROUNDS), /required/);
  });

  it('verifyPassword returns true for the correct plaintext', async () => {
    const hash = await hashPassword('s3cret!', FAST_ROUNDS);
    assert.equal(await verifyPassword('s3cret!', hash), true);
  });

  it('verifyPassword returns false for the wrong plaintext', async () => {
    const hash = await hashPassword('s3cret!', FAST_ROUNDS);
    assert.equal(await verifyPassword('wrong', hash), false);
  });

  it('verifyPassword never throws on malformed hashes', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-bcrypt-hash'), false);
    assert.equal(await verifyPassword('', ''), false);
  });

  it('getConfiguredBcryptRounds reads BCRYPT_ROUNDS with safe defaults', () => {
    assert.equal(getConfiguredBcryptRounds({} as NodeJS.ProcessEnv), 12);
    assert.equal(getConfiguredBcryptRounds({ BCRYPT_ROUNDS: '8' }), 8);
    assert.equal(getConfiguredBcryptRounds({ BCRYPT_ROUNDS: '999' }), 15);
    assert.equal(getConfiguredBcryptRounds({ BCRYPT_ROUNDS: '1' }), 4);
    assert.equal(getConfiguredBcryptRounds({ BCRYPT_ROUNDS: 'nope' }), 12);
  });
});
