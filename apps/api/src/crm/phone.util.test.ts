/**
 * Unit tests — phone normalisation. No database needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidE164, normalizeE164 } from './phone.util';

describe('phone.util — normalizeE164', () => {
  it('passes through a clean E.164 number', () => {
    assert.equal(normalizeE164('+201001234567'), '+201001234567');
  });

  it('strips internal whitespace, dashes, and parentheses', () => {
    assert.equal(normalizeE164('+20 (100) 123-4567'), '+201001234567');
    assert.equal(normalizeE164('+20-100-123-4567'), '+201001234567');
  });

  it('treats leading 00 as a synonym for +', () => {
    assert.equal(normalizeE164('00201001234567'), '+201001234567');
    assert.equal(normalizeE164(' 00 20 100 123 4567 '), '+201001234567');
  });

  it('rejects bare local numbers without country code', () => {
    assert.throws(() => normalizeE164('01001234567'), /Invalid phone number/);
  });

  // C26 — WhatsApp Cloud delivers `from` as bare digits with country code,
  // e.g. "201001234567". Treat that as E.164 missing the conventional `+`
  // so inbound conversations and lead lookups land on the same canonical
  // string.
  it('accepts bare-digit input with a country code (WhatsApp Cloud form)', () => {
    assert.equal(normalizeE164('201001234567'), '+201001234567');
    assert.equal(normalizeE164(' 20 100 123 4567 '), '+201001234567');
    assert.equal(normalizeE164('966500110099'), '+966500110099');
  });

  it('still rejects bare digits that are too short', () => {
    assert.throws(() => normalizeE164('1234567'), /Invalid phone number/);
  });

  it('rejects too-short or too-long numbers', () => {
    assert.throws(() => normalizeE164('+1234'), /Invalid phone number/);
    assert.throws(() => normalizeE164('+12345678901234567890'), /Invalid phone number/);
  });

  it('rejects non-string input', () => {
    // @ts-expect-error — runtime check
    assert.throws(() => normalizeE164(20100), /must be a string/);
    // @ts-expect-error — runtime check
    assert.throws(() => normalizeE164(undefined), /must be a string/);
  });

  it('isValidE164 matches normalised output exactly', () => {
    assert.equal(isValidE164('+201001234567'), true);
    assert.equal(isValidE164('20100'), false);
    assert.equal(isValidE164('+20 100 123 4567'), false);
  });
});
