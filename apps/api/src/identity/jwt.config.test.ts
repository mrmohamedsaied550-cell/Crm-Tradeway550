/**
 * C27 — JWT config production gates. Pure unit tests — no Postgres,
 * no process.env mutation (the env is passed explicitly).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JwtConfigError, buildJwtConfig } from './jwt.config';

const STRONG_A = 'A'.repeat(48);
const STRONG_B = 'B'.repeat(48);

describe('identity/jwt.config — buildJwtConfig (C27 production gates)', () => {
  it('returns the dev defaults outside production', () => {
    const cfg = buildJwtConfig({ NODE_ENV: 'development' });
    assert.equal(cfg.accessSecret, 'change-me-access');
    assert.equal(cfg.refreshSecret, 'change-me-refresh');
  });

  it('honors explicit env values outside production without throwing', () => {
    const cfg = buildJwtConfig({
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: STRONG_A,
      JWT_REFRESH_SECRET: STRONG_B,
    });
    assert.equal(cfg.accessSecret, STRONG_A);
    assert.equal(cfg.refreshSecret, STRONG_B);
  });

  it('throws in production when JWT_ACCESS_SECRET is missing', () => {
    assert.throws(
      () => buildJwtConfig({ NODE_ENV: 'production', JWT_REFRESH_SECRET: STRONG_B }),
      (err: unknown) => err instanceof JwtConfigError && /JWT_ACCESS_SECRET/.test(err.message),
    );
  });

  it('throws in production when JWT_REFRESH_SECRET is missing', () => {
    assert.throws(
      () => buildJwtConfig({ NODE_ENV: 'production', JWT_ACCESS_SECRET: STRONG_A }),
      (err: unknown) => err instanceof JwtConfigError && /JWT_REFRESH_SECRET/.test(err.message),
    );
  });

  it('throws in production when secrets are still the dev placeholders', () => {
    assert.throws(
      () =>
        buildJwtConfig({
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: 'change-me-access',
          JWT_REFRESH_SECRET: STRONG_B,
        }),
      (err: unknown) => err instanceof JwtConfigError && /placeholder/.test(err.message),
    );
  });

  it('throws in production when secrets are too short', () => {
    assert.throws(
      () =>
        buildJwtConfig({
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: 'short',
          JWT_REFRESH_SECRET: STRONG_B,
        }),
      (err: unknown) => err instanceof JwtConfigError && /strong/.test(err.message),
    );
  });

  it('throws in production when access and refresh secrets are identical', () => {
    assert.throws(
      () =>
        buildJwtConfig({
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: STRONG_A,
          JWT_REFRESH_SECRET: STRONG_A,
        }),
      (err: unknown) => err instanceof JwtConfigError && /must differ/.test(err.message),
    );
  });

  it('returns the config in production when both secrets are strong and distinct', () => {
    const cfg = buildJwtConfig({
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: STRONG_A,
      JWT_REFRESH_SECRET: STRONG_B,
    });
    assert.equal(cfg.accessSecret, STRONG_A);
    assert.equal(cfg.refreshSecret, STRONG_B);
  });
});
