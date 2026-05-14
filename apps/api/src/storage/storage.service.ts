import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

/**
 * Sprint 16 (D16) — private storage abstraction.
 *
 * One small surface so the rest of the CRM never sees the underlying
 * provider:
 *
 *   - `save(scope, buffer, mimeType)`  → returns the opaque key + sha256
 *   - `openStream(key)`                → returns a readable stream
 *   - `stat(key)`                      → returns { sizeBytes } or null
 *   - `delete(key)`                    → best-effort removal
 *
 * The active provider is decided at construction time from `STORAGE_ROOT`.
 * This sprint ships a single `LocalDiskProvider` (filesystem path outside
 * any web-served tree); future sprints can drop in an S3 provider behind
 * the same interface without touching callers.
 *
 * Safety:
 *   - The `key` returned by `save` is opaque — it includes the tenantId
 *     and leadId in the path so a separate tenant's file is never
 *     reachable via the disk layout.
 *   - `openStream` re-derives the absolute path from the active provider's
 *     root and rejects keys with `..` segments — a malicious key that
 *     escaped DB validation can never read outside the storage root.
 *   - No `key` ever crosses the wire — the controller resolves
 *     `documentId → key` via Prisma under the tenant RLS and only then
 *     opens the stream.
 */

export interface StorageScope {
  tenantId: string;
  leadId: string;
  documentId: string;
}

export interface StoredObject {
  /** Opaque path inside the active provider's namespace. */
  key: string;
  /** SHA-256 hex digest of the persisted bytes. */
  fileHash: string;
  /** Size of the persisted bytes — re-measured from disk after write. */
  sizeBytes: number;
  /** Identifier of the provider that owns this key ('local', future 's3'). */
  provider: string;
}

export interface StorageProvider {
  readonly id: string;
  save(scope: StorageScope, buffer: Buffer, mimeType: string): Promise<StoredObject>;
  openStream(key: string): Promise<ReadStream>;
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  delete(key: string): Promise<void>;
}

/**
 * LocalDiskProvider — writes private files under `STORAGE_ROOT`, with
 * one directory per (tenant, lead) so admin tools and ops scripts can
 * find a tenant's files quickly. Filenames are
 * `{documentId}-{hash8}.bin` so a same-tenant file collision is not
 * possible.
 *
 * `bin` extension is used regardless of the upload's MIME type: the
 * served Content-Type comes from the DB row, not the file extension,
 * so giving every file the same boring extension keeps shell tools
 * (ls, find) from sniffing them.
 */
export class LocalDiskProvider implements StorageProvider {
  public readonly id = 'local';
  private readonly logger = new Logger(LocalDiskProvider.name);
  /** Absolute, fully-resolved storage root. Set in the constructor. */
  public readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async save(scope: StorageScope, buffer: Buffer, _mimeType: string): Promise<StoredObject> {
    const hash = createHash('sha256').update(buffer).digest('hex');
    const relativeKey = this.buildKey(scope, hash);
    const absolutePath = this.resolveSafe(relativeKey);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, buffer, { flag: 'w' });
    const st = await stat(absolutePath);
    return {
      key: relativeKey,
      fileHash: hash,
      sizeBytes: st.size,
      provider: this.id,
    };
  }

  async openStream(key: string): Promise<ReadStream> {
    const absolutePath = this.resolveSafe(key);
    return createReadStream(absolutePath);
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const absolutePath = this.resolveSafe(key);
      const st = await stat(absolutePath);
      return { sizeBytes: st.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const absolutePath = this.resolveSafe(key);
      await unlink(absolutePath);
    } catch (err) {
      // Best-effort; the row deletion proceeds regardless.
      this.logger.warn(`delete(${key}) failed: ${String(err)}`);
    }
  }

  /** Compose the storage key. Kept in one place so save + resolve agree. */
  private buildKey(scope: StorageScope, hash: string): string {
    return `leads/${scope.tenantId}/${scope.leadId}/${scope.documentId}-${hash.slice(0, 16)}.bin`;
  }

  /**
   * Translate an opaque key into an absolute filesystem path AND assert
   * the result is still under `this.root`. A key carrying `..` segments
   * or an absolute-path prefix is rejected — this is the last line of
   * defence against a path-traversal that slipped past DB validation.
   */
  private resolveSafe(key: string): string {
    if (!key || key.startsWith('/') || key.includes('..')) {
      throw new Error(`storage: invalid key: ${key}`);
    }
    const absolutePath = resolve(this.root, key);
    if (!absolutePath.startsWith(this.root + '/') && absolutePath !== this.root) {
      throw new Error(`storage: key resolves outside root: ${key}`);
    }
    return absolutePath;
  }
}

/**
 * Nest-injected wrapper. Resolves `STORAGE_ROOT` from env once at boot
 * and exposes the active provider via a thin facade so callers don't
 * import the provider class directly.
 */
@Injectable()
export class StorageService {
  private readonly provider: StorageProvider;

  constructor() {
    const root = process.env['STORAGE_ROOT'] ?? './data/storage';
    this.provider = new LocalDiskProvider(root);
  }

  get providerId(): string {
    return this.provider.id;
  }

  save(scope: StorageScope, buffer: Buffer, mimeType: string): Promise<StoredObject> {
    return this.provider.save(scope, buffer, mimeType);
  }

  openStream(key: string): Promise<ReadStream> {
    return this.provider.openStream(key);
  }

  stat(key: string): Promise<{ sizeBytes: number } | null> {
    return this.provider.stat(key);
  }

  delete(key: string): Promise<void> {
    return this.provider.delete(key);
  }

  /**
   * Test-only override for the storage root. Used by the unit suite to
   * point at an isolated tmpdir; production code never touches this.
   */
  static withProvider(provider: StorageProvider): StorageService {
    const svc = Object.create(StorageService.prototype) as StorageService;
    (svc as unknown as { provider: StorageProvider }).provider = provider;
    return svc;
  }
}

/** Convenience helper used by tests + scripts. */
export function buildLocalProvider(root: string): LocalDiskProvider {
  return new LocalDiskProvider(root);
}

/**
 * Sprint 16 (D16) — server-side MIME allow-list.
 *
 * Documents are operator-curated uploads (national ID, driving licence,
 * permit scans). The allow-list intentionally rejects every executable
 * type, every archive type, and every script type — the server NEVER
 * runs the bytes, but a stolen file with an .exe header could still
 * fool a downstream consumer.
 */
export const ALLOWED_DOCUMENT_MIMES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

/** Default upload size limit (10 MiB). Overridable via env. */
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export function readUploadLimit(): number {
  const raw = process.env['DOCUMENT_UPLOAD_MAX_BYTES'];
  if (!raw) return DEFAULT_UPLOAD_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_UPLOAD_MAX_BYTES;
  return parsed;
}

/**
 * Sanitise an operator-supplied filename for storage in the DB. Strips
 * any path component, removes characters that the OS or a typical
 * browser would misinterpret, and caps the length so a malicious upload
 * can't blow up the column. Returns a non-empty string in every case.
 */
export function sanitizeFileName(rawName: string | null | undefined): string {
  if (!rawName) return 'file';
  // Drop any directory part — path traversal is impossible at the
  // storage layer but the DB row should still hold just the leaf name.
  const leaf =
    rawName
      .replace(/[\\/]+/gu, '/')
      .split('/')
      .pop() ?? 'file';
  /* eslint-disable no-control-regex */
  const trimmed = leaf
    .trim()
    .replace(/[ -]/gu, '') // strip control chars
    .replace(/[\s]+/gu, ' ') // collapse whitespace
    .replace(/["<>:|?*]/gu, '_') // Windows-reserved
    .slice(0, 200);
  /* eslint-enable no-control-regex */
  return trimmed.length > 0 ? trimmed : 'file';
}
