/**
 * Sprint 16 (D16) — storage service tests.
 *
 * Verifies the LocalDiskProvider round-trip and the path-safety
 * guards. No database access — these tests exercise the filesystem
 * only.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Readable } from 'node:stream';

import {
  ALLOWED_DOCUMENT_MIMES,
  DEFAULT_UPLOAD_MAX_BYTES,
  buildLocalProvider,
  readUploadLimit,
  sanitizeFileName,
} from './storage.service';

const TENANT = '00000000-0000-0000-0000-000000000001';
const LEAD = '00000000-0000-0000-0000-000000000002';
const DOC = '00000000-0000-0000-0000-000000000003';

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

let storageRoot: string;

describe('storage — local disk provider (Sprint 16 / D16)', () => {
  before(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'd16-storage-'));
  });

  after(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('save + openStream round-trips identical bytes', async () => {
    const provider = buildLocalProvider(storageRoot);
    const payload = Buffer.from('hello world');
    const stored = await provider.save(
      { tenantId: TENANT, leadId: LEAD, documentId: DOC },
      payload,
      'application/pdf',
    );
    assert.equal(stored.sizeBytes, payload.length);
    assert.equal(stored.provider, 'local');
    assert.match(stored.fileHash, /^[0-9a-f]{64}$/u);
    assert.ok(stored.key.startsWith(`leads/${TENANT}/${LEAD}/${DOC}-`));
    assert.ok(stored.key.endsWith('.bin'));

    const stream = await provider.openStream(stored.key);
    const read = await streamToBuffer(stream);
    assert.deepEqual(read, payload);
  });

  it('save isolates one tenant from another at the path level', async () => {
    const provider = buildLocalProvider(storageRoot);
    const a = await provider.save(
      { tenantId: TENANT, leadId: LEAD, documentId: DOC },
      Buffer.from('a'),
      'image/jpeg',
    );
    const b = await provider.save(
      {
        tenantId: '00000000-0000-0000-0000-0000000000ff',
        leadId: LEAD,
        documentId: DOC,
      },
      Buffer.from('b'),
      'image/jpeg',
    );
    assert.notEqual(a.key, b.key);
    assert.ok(a.key.includes(`/${TENANT}/`));
    assert.ok(b.key.includes('/00000000-0000-0000-0000-0000000000ff/'));
  });

  it('openStream rejects keys with ".." segments', async () => {
    const provider = buildLocalProvider(storageRoot);
    await assert.rejects(() => provider.openStream('../etc/passwd'));
    await assert.rejects(() => provider.openStream('leads/../../etc/passwd'));
    await assert.rejects(() => provider.openStream('/etc/passwd'));
  });

  it('stat returns size; null for unknown key', async () => {
    const provider = buildLocalProvider(storageRoot);
    const stored = await provider.save(
      { tenantId: TENANT, leadId: LEAD, documentId: DOC },
      Buffer.from('stat-check'),
      'application/pdf',
    );
    const st = await provider.stat(stored.key);
    assert.ok(st);
    assert.equal(st!.sizeBytes, 'stat-check'.length);
    const missing = await provider.stat('leads/aaa/bbb/ccc-deadbeefdeadbeef.bin');
    assert.equal(missing, null);
  });

  it('delete is best-effort and idempotent', async () => {
    const provider = buildLocalProvider(storageRoot);
    const stored = await provider.save(
      { tenantId: TENANT, leadId: LEAD, documentId: DOC },
      Buffer.from('del'),
      'application/pdf',
    );
    await provider.delete(stored.key);
    const st = await provider.stat(stored.key);
    assert.equal(st, null);
    // Second delete must not throw.
    await provider.delete(stored.key);
  });

  it('ALLOWED_DOCUMENT_MIMES is the canonical allow-list', () => {
    assert.ok(ALLOWED_DOCUMENT_MIMES.has('image/jpeg'));
    assert.ok(ALLOWED_DOCUMENT_MIMES.has('image/png'));
    assert.ok(ALLOWED_DOCUMENT_MIMES.has('image/webp'));
    assert.ok(ALLOWED_DOCUMENT_MIMES.has('application/pdf'));
    assert.ok(!ALLOWED_DOCUMENT_MIMES.has('application/octet-stream'));
    assert.ok(!ALLOWED_DOCUMENT_MIMES.has('application/x-msdownload'));
    assert.ok(!ALLOWED_DOCUMENT_MIMES.has('text/html'));
  });

  it('readUploadLimit honours the env override', () => {
    delete process.env['DOCUMENT_UPLOAD_MAX_BYTES'];
    assert.equal(readUploadLimit(), DEFAULT_UPLOAD_MAX_BYTES);
    process.env['DOCUMENT_UPLOAD_MAX_BYTES'] = '4096';
    assert.equal(readUploadLimit(), 4096);
    process.env['DOCUMENT_UPLOAD_MAX_BYTES'] = 'not-a-number';
    assert.equal(readUploadLimit(), DEFAULT_UPLOAD_MAX_BYTES);
    delete process.env['DOCUMENT_UPLOAD_MAX_BYTES'];
  });

  it('sanitizeFileName strips path components and unsafe characters', () => {
    assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFileName('C:\\Users\\Public\\file.pdf'), 'file.pdf');
    assert.equal(sanitizeFileName('  spaced  name.png  '), 'spaced name.png');
    assert.equal(sanitizeFileName('a"b<c>d:e|f?g*.pdf'), 'a_b_c_d_e_f_g_.pdf');
    assert.equal(sanitizeFileName(''), 'file');
    assert.equal(sanitizeFileName(null), 'file');
    assert.equal(sanitizeFileName('a'.repeat(500)).length, 200);
  });
});
