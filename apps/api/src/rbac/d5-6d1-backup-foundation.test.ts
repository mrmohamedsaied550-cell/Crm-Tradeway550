/**
 * Phase D5 — D5.6D-1: tenant backup export governance foundation.
 *
 * Pure unit tests covering:
 *
 *   A. Catalogue coverage — every column emitted by every backup
 *      table maps to a `FIELD_CATALOGUE` entry under its resource;
 *      restore-critical fields (id / FK / tenantId / schemaVersion /
 *      …) carry `redactable: false`; raw credentials are NEVER
 *      catalogued (they're stripped at the BackupService boundary
 *      and would expose a UI toggle for a non-existent field).
 *
 *   B. Decorator wiring — `BackupController.export` carries
 *      `@RequireCapability('tenant.export')` AND
 *      `@ExportGate({primary:'tenant', format:'json-tenant-backup',
 *      inherits:[<every backup-table resource>]})`. The capability
 *      stays `tenant.export` (un-renamed by D5.6D-1); `ResourceFieldGate`
 *      is intentionally NOT set on the export route.
 *
 *   C. Wire-envelope compatibility — `tenantBackupToWireEnvelope`
 *      produces a byte-shape identical to the pre-D5.6D-1
 *      `TenantBackup` JSON: top-level metadata, counts envelope,
 *      per-table data arrays. Restore tooling (`scripts/restore.sh`)
 *      continues to round-trip an export → restore cycle.
 *
 *   D. ExportInterceptor — `json-tenant-backup` format is wired
 *      end-to-end:
 *        — passthrough when no `@ExportGate` metadata,
 *        — flag-on path serialises wire envelope, sets headers,
 *          writes audit row with per-table metadata,
 *        — flag-off path serialises identical bytes WITHOUT writing
 *          an audit row,
 *        — super-admin bypass returns full body, audit still fires,
 *        — D5.6D-1 redaction is a NO-OP: deny rule on `lead.phone`
 *          does NOT strip the column from the leads table (D5.6D-2
 *          will introduce real redaction + the
 *          `E_BACKUP_REDACTED_NOT_RESTORABLE` guard).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, type Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

import { BackupController } from '../backup/backup.controller';
import {
  BACKUP_INHERIT_RESOURCES,
  BACKUP_TABLE_COLUMN_FIELDS,
  BACKUP_TABLE_RESOURCES,
  tenantBackupToWireEnvelope,
} from '../backup/backup.service';

import {
  CATALOGUE_RESOURCES,
  FIELD_CATALOGUE,
  isRedactable,
  type CatalogueResource,
} from './field-catalogue.registry';
import type { StructuredTenantBackup } from './export-contract';
import { ExportAuditService } from './export-audit.service';
import { ExportInterceptor } from './export.interceptor';
import { ExportRedactionService } from './export-redaction.service';
import { EXPORT_GATE_KEY } from './export-gate.decorator';
import { CAPABILITY_KEY } from './require-capability.decorator';
import { RESOURCE_FIELD_GATE_KEY } from './resource-field-gate.decorator';
import { PermissionResolverService, type ResolvedPermissions } from './permission-resolver.service';

// ─── helpers ──────────────────────────────────────────────────────

function metaOn(method: unknown, key: string): unknown {
  if (typeof method !== 'function') return undefined;
  return Reflect.getMetadata(key, method);
}

function bundle(opts: {
  code?: string;
  deniedRead?: Record<string, readonly string[]>;
}): ResolvedPermissions {
  return {
    tenantId: 't1',
    userId: 'u1',
    role: {
      id: 'r1',
      code: opts.code ?? 'ops_manager',
      level: 90,
      isSystem: true,
      versionTag: 0,
    },
    capabilities: [],
    scopesByResource: {},
    deniedReadFieldsByResource: opts.deniedRead ?? {},
    deniedWriteFieldsByResource: {},
    userScopes: { companyIds: [], countryIds: [] },
    servedFromCache: false,
  };
}

function makeResolver(b: ResolvedPermissions): PermissionResolverService {
  return { resolveForUser: async () => b } as unknown as PermissionResolverService;
}

class FakeAuditService extends ExportAuditService {
  public calls: Parameters<ExportAuditService['recordExport']>[0][] = [];
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super({} as any);
  }
  override async recordExport(input: Parameters<ExportAuditService['recordExport']>[0]) {
    this.calls.push(input);
    return { entityId: 'audit-id-d5-6d1' };
  }
}

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  } as unknown as { setHeader: (n: string, v: string) => void };
  return { res, headers };
}

function makeCtx(opts: { req: unknown; res?: unknown; metadata?: unknown }): ExecutionContext {
  const handler = function fakeHandler() {
    /* placeholder */
  };
  if (opts.metadata !== undefined) {
    Reflect.defineMetadata(EXPORT_GATE_KEY, opts.metadata, handler);
  }
  return {
    switchToHttp: () => ({
      getRequest: () => opts.req,
      getResponse: () => opts.res ?? makeRes().res,
    }),
    getHandler: () => handler,
    getClass: () =>
      class Anon {
        /* placeholder class */
      },
  } as unknown as ExecutionContext;
}

function handlerOf<T>(value: T): CallHandler<T> {
  return { handle: (): Observable<T> => of(value) };
}

const USER = { typ: 'access' as const, sub: 'u-d5-6d1', tid: 't-d5-6d1', rid: 'r-d5-6d1' };

const ORIGINAL_FLAG = process.env['D5_DYNAMIC_PERMISSIONS_V1'];
function setFlag(value: 'true' | 'false' | undefined): void {
  if (value === undefined) delete process.env['D5_DYNAMIC_PERMISSIONS_V1'];
  else process.env['D5_DYNAMIC_PERMISSIONS_V1'] = value;
}

/**
 * Build a tiny `StructuredTenantBackup` for the interceptor tests.
 * Mirrors the real BackupService output shape with one row per
 * table (tenantId / id / FK columns populated so restore-criticality
 * assertions have something to verify) and no secrets.
 */
function tinyBackup(opts?: { exportedAt?: string }): StructuredTenantBackup {
  const exportedAt = opts?.exportedAt ?? '2026-05-06T00:00:00.000Z';
  const tenant = { id: 'ten-1', code: 'acme', name: 'Acme Tenant' };

  // Build one synthetic row per table from the column-field registry.
  const tables = Object.entries(BACKUP_TABLE_COLUMN_FIELDS).map(([tableName, fields]) => {
    const row: Record<string, unknown> = {};
    for (const f of fields) {
      // Populate IDs / FKs / known timestamps so audit metrics and
      // restore-critical assertions see meaningful values.
      if (f === 'id' || f === 'tenantId' || f.endsWith('Id')) {
        row[f] = `${tableName}-${f}-1`;
      } else if (f === 'createdAt' || f === 'updatedAt' || f.endsWith('At')) {
        row[f] = exportedAt;
      } else if (f === 'phone') {
        row[f] = '+201005551234';
      } else if (f === 'email') {
        row[f] = 'demo@example.test';
      } else if (f === 'name' || f === 'displayName' || f === 'title' || f === 'fileName') {
        row[f] = `name-${tableName}`;
      } else if (
        f === 'isActive' ||
        f === 'isDefault' ||
        f === 'isTerminal' ||
        f === 'hasIdCard' ||
        f === 'hasLicense' ||
        f === 'hasVehicleRegistration'
      ) {
        row[f] = false;
      } else if (f === 'order' || f === 'sizeBytes' || f === 'tripCount' || f === 'variableCount') {
        row[f] = 0;
      } else if (f === 'amount') {
        row[f] = 0;
      } else if (f === 'attemptIndex') {
        row[f] = 1;
      } else {
        row[f] = `${f}-value`;
      }
    }
    return {
      tableName,
      export: {
        format: 'json' as const,
        filename: `${tableName}.json`,
        columns: [...fields].map((field) => ({
          key: field,
          label: field,
          resource: BACKUP_TABLE_RESOURCES[tableName]!,
          field,
        })),
        rows: [row],
      },
    };
  });

  return {
    format: 'json-tenant-backup',
    filename: 'tenant-backup-2026-05-06.json',
    exportedAt,
    tenant,
    schemaVersion: 1,
    rowCap: 10_000,
    tables,
  };
}

// ════════════════════════════════════════════════════════════════
// A. Catalogue coverage
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6D-1 — catalogue coverage', () => {
  it('every backup-table column has a (resource, field) catalogue entry', () => {
    const cataloguedPairs: Set<string> = new Set(
      FIELD_CATALOGUE.map((c) => `${c.resource as string}::${c.field}`),
    );

    for (const [tableName, fields] of Object.entries(BACKUP_TABLE_COLUMN_FIELDS)) {
      const resource = BACKUP_TABLE_RESOURCES[tableName];
      assert.ok(resource, `no resource mapping for backup table '${tableName}'`);
      for (const field of fields) {
        const key = `${resource as string}::${field}`;
        assert.ok(
          cataloguedPairs.has(key),
          `missing catalogue entry for backup column '${tableName}.${field}' (${key})`,
        );
      }
    }
  });

  it('every backup-table resource is in CATALOGUE_RESOURCES', () => {
    const known: Set<string> = new Set(CATALOGUE_RESOURCES as readonly string[]);
    for (const [tableName, resource] of Object.entries(BACKUP_TABLE_RESOURCES)) {
      assert.ok(
        known.has(resource as string),
        `backup table '${tableName}' references uncatalogued resource '${resource}'`,
      );
    }
    // The top-level metadata resource also lives in the catalogue.
    assert.ok(known.has('tenant'), `'tenant' resource must be catalogued for backup metadata`);
  });

  it('primary key (id) and tenant FK (tenantId) are non-redactable for every backup table', () => {
    // Two structural identifiers MUST survive any deny rule across
    // every backup table because they anchor row identity + tenant
    // isolation. Other foreign keys (companyId, countryId,
    // assignedToId, …) keep their read-path catalogue defaults
    // (redactable: true) so role-builders can legitimately hide
    // ownership / scope info on the lead / captain detail pages —
    // D5.6D-2 enforces backup-specific FK survival via a redactor
    // invariant + per-table restore-critical registry, NOT via the
    // shared catalogue's `redactable` flag.
    for (const [tableName, fields] of Object.entries(BACKUP_TABLE_COLUMN_FIELDS)) {
      const resource = BACKUP_TABLE_RESOURCES[tableName]!;
      for (const field of fields) {
        if (field !== 'id' && field !== 'tenantId') continue;
        assert.equal(
          isRedactable(resource, field),
          false,
          `restore-critical field '${tableName}.${field}' must be redactable:false`,
        );
      }
    }
    // The top-level 'tenant' metadata resource has its own anchor.
    assert.equal(isRedactable('tenant', 'id'), false);
    assert.equal(isRedactable('tenant', 'code'), false);
    assert.equal(isRedactable('tenant', 'schemaVersion'), false);
    assert.equal(isRedactable('tenant', 'rowCap'), false);
    assert.equal(isRedactable('tenant', 'exportedAt'), false);
  });

  it('credential / secret fields are NEVER catalogued (passwordHash, mfaSecret, accessToken, appSecret, verifyToken)', () => {
    const FORBIDDEN: ReadonlyArray<{ resource: CatalogueResource; field: string }> = [
      { resource: 'org.user', field: 'passwordHash' },
      { resource: 'org.user', field: 'mfaSecret' },
      { resource: 'org.user', field: 'failedLoginCount' },
      { resource: 'org.user', field: 'lockedUntil' },
      { resource: 'whatsapp.account', field: 'accessToken' },
      { resource: 'whatsapp.account', field: 'appSecret' },
      { resource: 'whatsapp.account', field: 'verifyToken' },
    ];
    for (const { resource, field } of FORBIDDEN) {
      const found = FIELD_CATALOGUE.find((c) => c.resource === resource && c.field === field);
      assert.equal(
        found,
        undefined,
        `secret '${resource}.${field}' must NOT be catalogued (cataloguing creates a UI toggle for a non-existent backup column)`,
      );
    }
  });

  it('manually-stripped credential fields are absent from BACKUP_TABLE_COLUMN_FIELDS too', () => {
    const usersFields = BACKUP_TABLE_COLUMN_FIELDS['users']!;
    assert.equal(usersFields.includes('passwordHash'), false);
    assert.equal(usersFields.includes('mfaSecret'), false);
    assert.equal(usersFields.includes('failedLoginCount'), false);
    assert.equal(usersFields.includes('lockedUntil'), false);

    const waFields = BACKUP_TABLE_COLUMN_FIELDS['whatsappAccounts']!;
    assert.equal(waFields.includes('accessToken'), false);
    assert.equal(waFields.includes('appSecret'), false);
    assert.equal(waFields.includes('verifyToken'), false);
  });
});

// ════════════════════════════════════════════════════════════════
// B. Decorator wiring
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6D-1 — BackupController decorator wiring', () => {
  it('BackupController.export — @RequireCapability(tenant.export) + @ExportGate(tenant)', () => {
    const proto = BackupController.prototype as unknown as Record<string, unknown>;
    const m = proto['export'];

    const requiredCaps = metaOn(m, CAPABILITY_KEY) as readonly string[] | undefined;
    assert.deepEqual(
      requiredCaps,
      ['tenant.export'],
      'capability must remain tenant.export (D5.6D-1 does not rename it)',
    );

    // ResourceFieldGate is NOT applied — the export interceptor
    // handles the redaction surface; the field interceptor is for
    // JSON read paths.
    const fieldGate = metaOn(m, RESOURCE_FIELD_GATE_KEY);
    assert.equal(fieldGate, undefined);

    const gate = metaOn(m, EXPORT_GATE_KEY) as
      | {
          primary: string;
          inherits: readonly string[];
          format: string;
          filename: unknown;
        }
      | undefined;
    assert.ok(gate, 'BackupController.export must carry @ExportGate metadata');
    assert.equal(gate!.primary, 'tenant');
    assert.equal(gate!.format, 'json-tenant-backup');
    assert.equal(typeof gate!.filename, 'function');

    // `inherits` covers every backup-table resource.
    const inheritsSet: Set<string> = new Set(gate!.inherits as readonly string[]);
    for (const r of BACKUP_INHERIT_RESOURCES) {
      assert.ok(
        inheritsSet.has(r as string),
        `gate.inherits is missing resource '${r}' — the redactor needs the deny list under this resource`,
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════
// C. Wire-envelope compatibility
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6D-1 — tenantBackupToWireEnvelope (restore compatibility)', () => {
  it('produces the legacy {exportedAt, tenant, schemaVersion, rowCap, counts, data} shape', () => {
    const structured = tinyBackup({ exportedAt: '2026-05-06T12:00:00.000Z' });
    const wire = tenantBackupToWireEnvelope(structured) as {
      exportedAt: string;
      tenant: { id: string; code: string; name: string };
      schemaVersion: number;
      rowCap: number;
      counts: Record<string, number>;
      data: Record<string, unknown[]>;
    };

    assert.equal(wire.exportedAt, '2026-05-06T12:00:00.000Z');
    assert.deepEqual(wire.tenant, { id: 'ten-1', code: 'acme', name: 'Acme Tenant' });
    assert.equal(wire.schemaVersion, 1);
    assert.equal(wire.rowCap, 10_000);

    // Top-level keys match the legacy contract — nothing extra, nothing missing.
    assert.deepEqual(Object.keys(wire).sort(), [
      'counts',
      'data',
      'exportedAt',
      'rowCap',
      'schemaVersion',
      'tenant',
    ]);

    // counts.<table> === data.<table>.length for every table.
    for (const [k, v] of Object.entries(wire.counts)) {
      assert.ok(Array.isArray(wire.data[k]), `data.${k} must be an array`);
      assert.equal(wire.data[k]!.length, v, `counts.${k} must match data.${k}.length`);
    }

    // All seventeen backup tables are present.
    assert.equal(Object.keys(wire.data).length, Object.keys(BACKUP_TABLE_COLUMN_FIELDS).length);
    for (const tableName of Object.keys(BACKUP_TABLE_COLUMN_FIELDS)) {
      assert.ok(tableName in wire.data, `wire.data missing table '${tableName}'`);
    }
  });

  it('id / FK / tenantId restore-critical fields survive the wire collapse', () => {
    const structured = tinyBackup();
    const wire = tenantBackupToWireEnvelope(structured) as {
      data: Record<string, Array<Record<string, unknown>>>;
    };

    // Spot-check every table's first row carries id + tenantId (or
    // analogous immutable identifiers).
    for (const [tableName, fields] of Object.entries(BACKUP_TABLE_COLUMN_FIELDS)) {
      const row = wire.data[tableName]?.[0];
      assert.ok(row, `table '${tableName}' should have at least one row in tinyBackup`);
      for (const f of fields) {
        const looksLikeIdOrFk = f === 'id' || f === 'tenantId' || f.endsWith('Id');
        if (!looksLikeIdOrFk) continue;
        assert.ok(f in row, `restore-critical field '${tableName}.${f}' was dropped on the wire`);
      }
    }
  });

  it('is a pure function — does not mutate the input', () => {
    const structured = tinyBackup();
    const before = JSON.stringify(structured);
    tenantBackupToWireEnvelope(structured);
    assert.equal(JSON.stringify(structured), before, 'tenantBackupToWireEnvelope mutated input');
  });
});

// ════════════════════════════════════════════════════════════════
// D. ExportInterceptor — json-tenant-backup wiring
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6D-1 — ExportInterceptor on json-tenant-backup', () => {
  let redactor: ExportRedactionService;
  let audit: FakeAuditService;
  let interceptor: ExportInterceptor;

  beforeEach(() => {
    setFlag('true');
    redactor = new ExportRedactionService();
    audit = new FakeAuditService();
  });

  afterEach(() => {
    setFlag(ORIGINAL_FLAG === undefined ? undefined : (ORIGINAL_FLAG as 'true' | 'false'));
  });

  it('flag on + structured backup → serialises wire envelope, sets headers, writes audit row', async () => {
    const { res, headers } = makeRes();
    interceptor = new ExportInterceptor(new Reflector(), makeResolver(bundle({})), redactor, audit);
    const ctx = makeCtx({
      req: {
        user: USER,
        query: {},
        originalUrl: '/admin/backup/export',
        method: 'GET',
      },
      res,
      metadata: {
        primary: 'tenant',
        inherits: BACKUP_INHERIT_RESOURCES,
        format: 'json-tenant-backup',
        filename: 'tenant-backup.json',
      },
    });
    const out = (await firstValueFrom(
      interceptor.intercept(ctx, handlerOf(tinyBackup())),
    )) as string;

    // Body is a JSON string; parse and check the legacy shape.
    const parsed = JSON.parse(out) as {
      exportedAt: string;
      tenant: { id: string };
      schemaVersion: number;
      rowCap: number;
      counts: Record<string, number>;
      data: Record<string, Array<Record<string, unknown>>>;
    };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.rowCap, 10_000);
    for (const tableName of Object.keys(BACKUP_TABLE_COLUMN_FIELDS)) {
      assert.equal(parsed.counts[tableName], 1);
      assert.equal(parsed.data[tableName]!.length, 1);
    }

    // Headers
    assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(headers['Content-Disposition'], 'attachment; filename="tenant-backup.json"');
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(headers['X-Export-Redacted-Columns'], '(none)');
    assert.equal(headers['X-Export-Audit-Id'], 'audit-id-d5-6d1');

    // Audit row written exactly once with per-table metadata.
    assert.equal(audit.calls.length, 1);
    const a = audit.calls[0]!;
    assert.equal(a.resource, 'tenant');
    assert.equal(a.actorUserId, 'u-d5-6d1');
    assert.equal(a.endpoint, 'GET /admin/backup/export');
    assert.equal(a.flagState, 'on');
    assert.ok(a.bytesShipped > 0);

    // Per-table audit fields populated.
    assert.ok(a.tableNames, 'tableNames should be set on tenant.export audit row');
    assert.equal(a.tableNames!.length, Object.keys(BACKUP_TABLE_COLUMN_FIELDS).length);
    assert.ok(a.rowCountByTable);
    assert.equal(
      Object.values(a.rowCountByTable!).reduce((sum, n) => sum + n, 0),
      a.rowCount,
      'sum of rowCountByTable equals top-level rowCount',
    );
    assert.ok(a.columnsExportedByTable);
    assert.ok(a.columnsRedactedByTable);
    // D5.6D-1 — no redaction in flight; every table has empty redacted list.
    for (const t of a.tableNames!) {
      assert.deepEqual(
        a.columnsRedactedByTable![t],
        [],
        `D5.6D-1 must not redact any column (table '${t}')`,
      );
    }
  });

  it('flag off → serialises wire envelope WITHOUT writing an audit row', async () => {
    setFlag('false');
    const { res, headers } = makeRes();
    interceptor = new ExportInterceptor(new Reflector(), makeResolver(bundle({})), redactor, audit);
    const ctx = makeCtx({
      req: {
        user: USER,
        query: {},
        originalUrl: '/admin/backup/export',
        method: 'GET',
      },
      res,
      metadata: {
        primary: 'tenant',
        inherits: BACKUP_INHERIT_RESOURCES,
        format: 'json-tenant-backup',
        filename: 'tenant-backup.json',
      },
    });
    const out = (await firstValueFrom(
      interceptor.intercept(ctx, handlerOf(tinyBackup())),
    )) as string;
    const parsed = JSON.parse(out) as { schemaVersion: number; rowCap: number };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.rowCap, 10_000);
    // Browser still gets download headers.
    assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(headers['Content-Disposition'], 'attachment; filename="tenant-backup.json"');
    assert.equal(headers['X-Export-Redacted-Columns'], '(none)');
    assert.equal(headers['X-Export-Audit-Id'], undefined);
    // No audit row.
    assert.equal(audit.calls.length, 0);
  });

  it('flag on with deny rule on lead.phone — D5.6D-1 NO-OP: phone column survives in leads table', async () => {
    // D5.6D-1 ships the foundation only; a deny rule on a backup
    // column does NOT strip it. D5.6D-2 will introduce real
    // redaction PLUS the E_BACKUP_REDACTED_NOT_RESTORABLE guard so
    // a redacted backup is never silently restorable.
    const { res, headers } = makeRes();
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ deniedRead: { lead: ['phone'] } })),
      redactor,
      audit,
    );
    const ctx = makeCtx({
      req: {
        user: USER,
        query: {},
        originalUrl: '/admin/backup/export',
        method: 'GET',
      },
      res,
      metadata: {
        primary: 'tenant',
        inherits: BACKUP_INHERIT_RESOURCES,
        format: 'json-tenant-backup',
        filename: 'tenant-backup.json',
      },
    });
    const out = (await firstValueFrom(
      interceptor.intercept(ctx, handlerOf(tinyBackup())),
    )) as string;
    const parsed = JSON.parse(out) as { data: { leads: Array<Record<string, unknown>> } };
    // phone column STILL present in leads — the no-op contract.
    assert.ok('phone' in parsed.data.leads[0]!, 'D5.6D-1 must NOT redact the phone column');
    assert.equal(parsed.data.leads[0]!['phone'], '+201005551234');

    // Audit row reports nothing redacted.
    assert.equal(audit.calls.length, 1);
    const a = audit.calls[0]!;
    for (const t of a.tableNames!) {
      assert.deepEqual(
        a.columnsRedactedByTable![t],
        [],
        `D5.6D-1 redaction must be a no-op (table '${t}')`,
      );
    }
    assert.equal(headers['X-Export-Redacted-Columns'], '(none)');
  });

  it('super-admin → bypass returns full body, audit still fires for forensic trail', async () => {
    const { res } = makeRes();
    interceptor = new ExportInterceptor(
      new Reflector(),
      makeResolver(bundle({ code: 'super_admin' })),
      redactor,
      audit,
    );
    const ctx = makeCtx({
      req: {
        user: USER,
        query: {},
        originalUrl: '/admin/backup/export',
        method: 'GET',
      },
      res,
      metadata: {
        primary: 'tenant',
        inherits: BACKUP_INHERIT_RESOURCES,
        format: 'json-tenant-backup',
        filename: 'tenant-backup.json',
      },
    });
    const out = (await firstValueFrom(
      interceptor.intercept(ctx, handlerOf(tinyBackup())),
    )) as string;
    const parsed = JSON.parse(out) as { data: Record<string, unknown[]> };
    // Every table present in full.
    for (const t of Object.keys(BACKUP_TABLE_COLUMN_FIELDS)) {
      assert.equal(parsed.data[t]!.length, 1);
    }
    // Audit row written.
    assert.equal(audit.calls.length, 1);
    assert.equal(audit.calls[0]!.flagState, 'on');
  });

  it('rowCount audit metric matches sum of per-table row counts', async () => {
    const { res } = makeRes();
    interceptor = new ExportInterceptor(new Reflector(), makeResolver(bundle({})), redactor, audit);
    const ctx = makeCtx({
      req: {
        user: USER,
        query: {},
        originalUrl: '/admin/backup/export',
        method: 'GET',
      },
      res,
      metadata: {
        primary: 'tenant',
        inherits: BACKUP_INHERIT_RESOURCES,
        format: 'json-tenant-backup',
        filename: 'tenant-backup.json',
      },
    });
    await firstValueFrom(interceptor.intercept(ctx, handlerOf(tinyBackup())));

    const a = audit.calls[0]!;
    assert.equal(a.rowCount, Object.keys(BACKUP_TABLE_COLUMN_FIELDS).length);
  });

  it('audit payload contains structural metadata only — no raw row values', async () => {
    const { res } = makeRes();
    interceptor = new ExportInterceptor(new Reflector(), makeResolver(bundle({})), redactor, audit);
    const ctx = makeCtx({
      req: {
        user: USER,
        query: {},
        originalUrl: '/admin/backup/export',
        method: 'GET',
      },
      res,
      metadata: {
        primary: 'tenant',
        inherits: BACKUP_INHERIT_RESOURCES,
        format: 'json-tenant-backup',
        filename: 'tenant-backup.json',
      },
    });
    await firstValueFrom(interceptor.intercept(ctx, handlerOf(tinyBackup())));

    const a = audit.calls[0]!;
    const payload = JSON.stringify(a);
    // No row VALUES leak into the audit payload — phone, email,
    // sample-row strings used in tinyBackup() must never appear.
    assert.equal(payload.includes('+201005551234'), false, 'phone value leaked into audit row');
    assert.equal(payload.includes('demo@example.test'), false, 'email value leaked into audit row');
    // Likewise, the tenant name itself must not be in audit payload.
    assert.equal(payload.includes('Acme Tenant'), false, 'tenant name leaked into audit row');
  });
});

// ════════════════════════════════════════════════════════════════
// E. Smoke imports — confirm the public surfaces don't drift
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.6D-1 — public surfaces unchanged', () => {
  it('BackupService still exports tenantBackupToWireEnvelope', async () => {
    const mod = await import('../backup/backup.service');
    assert.equal(typeof mod.tenantBackupToWireEnvelope, 'function');
    assert.equal(typeof mod.BACKUP_TABLE_COLUMN_FIELDS, 'object');
    assert.equal(typeof mod.BACKUP_TABLE_RESOURCES, 'object');
    assert.ok(Array.isArray(mod.BACKUP_INHERIT_RESOURCES));
  });

  it('ExportRedactionService.redactTenantBackup is exposed', () => {
    const svc = new ExportRedactionService();
    assert.equal(typeof svc.redactTenantBackup, 'function');
    // Sanity round-trip: returns bypassed=true with structural metadata.
    const out = svc.redactTenantBackup(tinyBackup(), bundle({}), {
      primary: 'tenant',
      format: 'json-tenant-backup',
      filename: 'x.json',
    });
    assert.equal(out.bypassed, true);
    assert.equal(out.totalRows, Object.keys(BACKUP_TABLE_COLUMN_FIELDS).length);
    assert.equal(out.tableNames.length, Object.keys(BACKUP_TABLE_COLUMN_FIELDS).length);
  });
});
