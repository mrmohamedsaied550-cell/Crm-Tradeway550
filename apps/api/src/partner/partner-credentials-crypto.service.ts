import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Phase D4 — D4.2: partner-source credential encryption.
 *
 * Encryption envelope (JSON, stored in
 * `partner_sources.encrypted_credentials` as TEXT):
 *
 *   {
 *     "v": 1,                        // envelope version
 *     "iv": "<base64-encoded 12 B>", // GCM nonce (fresh per write)
 *     "ct": "<base64-encoded N B>",  // ciphertext
 *     "tag": "<base64-encoded 16 B>" // GCM auth tag
 *   }
 *
 * The plaintext is the partner-specific credentials JSON (e.g. for
 * Google Sheets: `{ serviceAccountEmail, privateKey, sheetId }`).
 * Each encryption uses a fresh 12-byte IV; the auth tag prevents
 * tampering at rest.
 *
 * Key source: `PARTNER_CREDENTIALS_KEY` env var. Required format is
 * a base64-encoded 32-byte key (AES-256). Helpers throw a typed
 * `partner.source.credentials_key_missing` error when the env var
 * is absent or malformed — the controller surfaces this as a 400
 * with that error code so the operator can fix the deployment.
 *
 * Plaintext credentials NEVER cross an API boundary:
 *   - The service writes the envelope to the DB and never returns it.
 *   - Read DTOs surface only `{ hasCredentials, lastTestedAt,
 *     connectionStatus, credentialUpdatedAt }`.
 *   - Decrypt is exposed only as a server-side utility for D4.3's
 *     adapters when they need to authenticate against the partner.
 *
 * Single tenant-wide KEK for v1 — per-tenant KEK is a future option
 * (D5 / Final UX & User Stories Audit) if isolation needs grow.
 * Documented rotation procedure: re-enter credentials in the admin
 * UI after rotating the env var; the DB-stored envelopes from the
 * previous key become unreadable until re-saved.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export class PartnerCredentialsKeyMissingError extends Error {
  readonly code = 'partner.source.credentials_key_missing';
  constructor(reason: string) {
    super(reason);
    this.name = 'PartnerCredentialsKeyMissingError';
  }
}

export class PartnerCredentialsInvalidShapeError extends Error {
  readonly code = 'partner.source.invalid_credentials_shape';
  constructor(reason: string) {
    super(reason);
    this.name = 'PartnerCredentialsInvalidShapeError';
  }
}

interface CredentialEnvelope {
  v: 1;
  iv: string;
  ct: string;
  tag: string;
}

@Injectable()
export class PartnerCredentialsCryptoService {
  /**
   * Resolve the KEK from the env once per call. We deliberately do
   * NOT cache because in dev/test the env var may flip mid-process
   * (matches the D3 feature-flag pattern of resolving on read).
   */
  private resolveKey(): Buffer {
    const raw = process.env['PARTNER_CREDENTIALS_KEY'];
    if (!raw || raw.trim().length === 0) {
      throw new PartnerCredentialsKeyMissingError(
        'PARTNER_CREDENTIALS_KEY is not configured. Set it to a base64-encoded 32-byte key before storing partner credentials.',
      );
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(raw.trim(), 'base64');
    } catch {
      throw new PartnerCredentialsKeyMissingError('PARTNER_CREDENTIALS_KEY is not valid base64.');
    }
    if (buf.length !== KEY_LENGTH) {
      throw new PartnerCredentialsKeyMissingError(
        `PARTNER_CREDENTIALS_KEY must decode to ${KEY_LENGTH} bytes; got ${buf.length}.`,
      );
    }
    return buf;
  }

  /**
   * Probe whether a key is configured WITHOUT touching it. Service
   * callers use this to short-circuit before doing any work — and
   * they always then catch the typed error from `encrypt` /
   * `decrypt` below as defence-in-depth.
   */
  isConfigured(): boolean {
    try {
      this.resolveKey();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Encrypt a credentials payload. The payload is serialised as JSON
   * before encryption; callers pass the structured object (e.g.
   * `{ serviceAccountEmail, privateKey, sheetId }`).
   *
   * Throws `PartnerCredentialsInvalidShapeError` for non-serialisable
   * payloads — those reach the operator as a 400 so they can fix the
   * form input.
   */
  encrypt(plaintext: unknown): string {
    let json: string;
    try {
      json = JSON.stringify(plaintext);
    } catch (err) {
      throw new PartnerCredentialsInvalidShapeError(
        `Credentials payload must be JSON-serialisable: ${(err as Error).message}`,
      );
    }
    if (typeof plaintext !== 'object' || plaintext === null || Array.isArray(plaintext)) {
      throw new PartnerCredentialsInvalidShapeError(
        'Credentials payload must be a non-null, non-array object.',
      );
    }
    const key = this.resolveKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope: CredentialEnvelope = {
      v: 1,
      iv: iv.toString('base64'),
      ct: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
    return JSON.stringify(envelope);
  }

  /**
   * Decrypt an envelope back into the original payload. Used only by
   * server-side adapter code in D4.3 — never exposed via API.
   *
   * Throws on tamper / missing-key / malformed-envelope. Callers
   * surface a generic "credentials unavailable" error to operators
   * (with `lastTestedAt` flipped to NULL) rather than the specific
   * cryptographic detail.
   */
  decrypt(envelope: string): unknown {
    let parsed: CredentialEnvelope;
    try {
      parsed = JSON.parse(envelope) as CredentialEnvelope;
    } catch {
      throw new PartnerCredentialsInvalidShapeError('Encrypted envelope is not valid JSON.');
    }
    if (
      parsed.v !== 1 ||
      typeof parsed.iv !== 'string' ||
      typeof parsed.ct !== 'string' ||
      typeof parsed.tag !== 'string'
    ) {
      throw new PartnerCredentialsInvalidShapeError(
        'Encrypted envelope is missing required fields.',
      );
    }
    const key = this.resolveKey();
    const iv = Buffer.from(parsed.iv, 'base64');
    const ciphertext = Buffer.from(parsed.ct, 'base64');
    const tag = Buffer.from(parsed.tag, 'base64');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(json);
  }
}
