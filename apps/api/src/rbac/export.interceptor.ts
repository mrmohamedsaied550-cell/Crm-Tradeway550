import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';

import type { AccessTokenClaims } from '../identity/jwt.types';

import { tenantBackupToWireEnvelope } from '../backup/backup.service';

import { isD5DynamicPermissionsV1Enabled } from './d5-feature-flag';
import { serializeCsv } from './csv-serializer';
import type { ExportFormat, StructuredExport, StructuredTenantBackup } from './export-contract';
import { ExportAuditService } from './export-audit.service';
import { EXPORT_GATE_KEY, type ExportGateOptions } from './export-gate.decorator';
import { ExportRedactionService } from './export-redaction.service';
import { PermissionResolverService } from './permission-resolver.service';

/**
 * Phase D5 — D5.6A: HTTP-layer interceptor for governed exports.
 *
 * Reads `@ExportGate(...)` route metadata, applies column-level
 * redaction via `ExportRedactionService`, serialises the
 * structured shape to the requested format via the canonical
 * serialiser, sets download headers (`Content-Type`,
 * `Content-Disposition`, `X-Export-Redacted-Columns`,
 * `X-Export-Audit-Id`), writes a metadata-only audit row, and
 * returns the serialised string body to NestJS for shipment.
 *
 * Distinct from `FieldRedactionInterceptor`:
 *   • Different metadata key — `EXPORT_GATE_KEY`. A route may
 *     carry both decorators; the export interceptor handles the
 *     export semantics, the field interceptor handles JSON
 *     read-path semantics.
 *   • Different output handling — the export interceptor
 *     produces a string body; the field interceptor returns the
 *     same JSON shape with paths deleted.
 *   • Sets download headers via `passthrough` `@Res` (controllers
 *     wire it that way starting in D5.6B).
 *
 * Passthrough paths (interceptor returns the controller's payload
 * unchanged):
 *
 *   1. No `@ExportGate` metadata on the route.
 *   2. The handler did not return a `StructuredExport` shape (a
 *      legacy controller using `@Res() res.send(...)` for example —
 *      D5.6A registered the interceptor; D5.6B is the first chunk
 *      to wire `@ExportGate` + structured shape).
 *   3. Missing `req.user` (defensive — JwtAuthGuard would have
 *      rejected the request before reaching here).
 *
 * Always-serialise path (D5.6B refinement):
 *
 *   When `@ExportGate` is present AND the handler returned a
 *   `StructuredExport`, the interceptor ALWAYS serialises the
 *   structured shape into the format's wire bytes and sets the
 *   download headers — even when the D5 flag is off. This is
 *   required because the structured object is an INTERNAL
 *   contract; allowing it to flow to NestJS would JSON-serialise
 *   it and break the CSV download. The flag controls whether
 *   redaction + audit happen, NOT whether serialisation happens.
 *
 *   • Flag off — no permission resolution, no redaction, no audit.
 *     The structured shape is serialised verbatim. Bytes are
 *     byte-identical to the legacy CSV builders that this
 *     refactor replaces (the StructuredExport columns / rows /
 *     comments are arranged so `serializeCsv(structured)` matches
 *     the previous `buildCsv(rows)` output exactly — pinned by
 *     golden-file tests in D5.6B).
 *
 *   • Flag on — `PermissionResolverService.resolveForUser` →
 *     `ExportRedactionService.redactColumns` → serialiser →
 *     headers (incl. `X-Export-Redacted-Columns`,
 *     `X-Export-Audit-Id`) → `ExportAuditService.recordExport`.
 *
 * Audit failures are swallowed inside `AuditService.writeEvent`;
 * this layer never blocks the download on an audit failure.
 *
 * D5.6A registered the interceptor globally with no controllers
 * wired. D5.6B begins the wiring on partner reconciliation +
 * commission CSV exports.
 */

@Injectable()
export class ExportInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ExportInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolverService,
    private readonly redactor: ExportRedactionService,
    private readonly auditService: ExportAuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const gate = this.reflector.getAllAndOverride<ExportGateOptions | undefined>(EXPORT_GATE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!gate) {
      return next.handle();
    }

    const req = ctx.switchToHttp().getRequest<Request & { user?: AccessTokenClaims }>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const user = req.user;
    if (!user) {
      // JwtAuthGuard would normally have rejected the request
      // before reaching here. Defensive — let the handler ship
      // its payload without redaction; the audit row is skipped.
      return next.handle();
    }

    return next
      .handle()
      .pipe(switchMap((data) => from(this.applyExportGovernance(gate, user, req, res, data))));
  }

  private async applyExportGovernance(
    gate: ExportGateOptions,
    user: AccessTokenClaims,
    req: Request,
    res: Response,
    data: unknown,
  ): Promise<unknown> {
    // D5.6D-1 — branch on the structured shape. Tenant backups
    // travel through their own redactor + serialiser path because
    // they ship a COLLECTION of tables in one response.
    if (isStructuredTenantBackup(data)) {
      return this.applyTenantBackupGovernance(gate, user, req, res, data);
    }

    if (!isStructuredExport(data)) {
      // Legacy controller still using `@Res() res.send(...)` —
      // pass through. Later chunks will retire the legacy paths.
      this.logger.debug(
        `ExportInterceptor: route ${req.method} ${req.url} declared @ExportGate(${gate.primary}) but returned a non-structured payload; passthrough.`,
      );
      return data;
    }

    // Always-serialise contract: when the controller returns a
    // StructuredExport, the interceptor MUST serialise it before
    // NestJS sends the response (otherwise NestJS would JSON-
    // serialise the structured object and break the CSV download).
    // The D5 flag controls whether redaction + audit happen, not
    // whether serialisation happens.
    const flagOn = isD5DynamicPermissionsV1Enabled();

    let outcome;
    if (flagOn) {
      const resolved = await this.resolver.resolveForUser({
        tenantId: user.tid,
        userId: user.sub,
        roleId: user.rid,
      });
      outcome = this.redactor.redactColumns(data, resolved, gate);
    } else {
      // Flag off — no redaction, no audit. Bypass-shaped outcome
      // so the rest of the pipeline reads the same.
      outcome = {
        redacted: data,
        columnsExported: data.columns.map((c) => c.key),
        columnsRedacted: [] as readonly string[],
        bypassed: true,
      };
    }

    const filename =
      typeof gate.filename === 'function'
        ? gate.filename({ format: outcome.redacted.format })
        : gate.filename;

    const body = serializeForFormat(outcome.redacted);
    const bytesShipped = Buffer.byteLength(body, 'utf8');

    // Headers — set before NestJS finalises the response. The
    // controller may also have set Content-Disposition; ours
    // overrides because the redacted shape may have changed the
    // filename via callback. `X-Export-Redacted-Columns` is a
    // forward-compat hook for D5.9's "Y columns hidden" UI hint.
    res.setHeader('Content-Type', mimeFor(outcome.redacted.format));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'X-Export-Redacted-Columns',
      outcome.columnsRedacted.length === 0 ? '(none)' : outcome.columnsRedacted.join(','),
    );

    // Persist audit metadata — only when flag is on. Flag-off
    // exports retain pre-D5.6 behaviour byte-for-byte AND skip
    // the audit row, because the operator hasn't opted into the
    // governance layer yet.
    if (flagOn) {
      try {
        const result = await this.auditService.recordExport({
          resource: gate.primary,
          actorUserId: user.sub,
          endpoint: `${req.method} ${stripQueryString(req.originalUrl ?? req.url)}`,
          filters: extractFilters(req),
          columnsExported: outcome.columnsExported,
          columnsRedacted: outcome.columnsRedacted,
          rowCount: outcome.redacted.rows.length,
          bytesShipped,
          flagState: 'on',
        });
        res.setHeader('X-Export-Audit-Id', result.entityId);
      } catch (err) {
        this.logger.warn(
          `ExportInterceptor: audit write failed for ${gate.primary} export; continuing — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return body;
  }

  /**
   * D5.6D-1 — tenant backup governance pipeline.
   *
   * Walks the per-table redaction outcome (no-op in D5.6D-1, real
   * in D5.6D-2), serialises to the legacy wire envelope so
   * `scripts/restore.sh` keeps working byte-for-byte, sets download
   * headers + the per-table audit row.
   *
   * Flag-off path: no redaction, no audit. Same envelope serialised
   * so the wire shape stays consistent and the response stays
   * restore-compatible. Bytes are byte-identical to the pre-D5.6D-1
   * `TenantBackup` JSON.
   */
  private async applyTenantBackupGovernance(
    gate: ExportGateOptions,
    user: AccessTokenClaims,
    req: Request,
    res: Response,
    data: StructuredTenantBackup,
  ): Promise<unknown> {
    const flagOn = isD5DynamicPermissionsV1Enabled();

    let outcome;
    if (flagOn) {
      const resolved = await this.resolver.resolveForUser({
        tenantId: user.tid,
        userId: user.sub,
        roleId: user.rid,
      });
      outcome = this.redactor.redactTenantBackup(data, resolved, gate);
    } else {
      // Flag off — no redaction, no audit. Build a
      // bypass-shaped outcome so the serialiser + headers run.
      const tableNames: string[] = [];
      const rowCountByTable: Record<string, number> = {};
      const columnsExportedByTable: Record<string, readonly string[]> = {};
      const columnsRedactedByTable: Record<string, readonly string[]> = {};
      const protectedColumnsByTable: Record<string, readonly string[]> = {};
      let totalRows = 0;
      for (const t of data.tables) {
        tableNames.push(t.tableName);
        rowCountByTable[t.tableName] = t.export.rows.length;
        columnsExportedByTable[t.tableName] = t.export.columns.map((c) => c.key);
        columnsRedactedByTable[t.tableName] = [];
        protectedColumnsByTable[t.tableName] = [];
        totalRows += t.export.rows.length;
      }
      outcome = {
        redacted: data,
        tableNames,
        rowCountByTable,
        columnsExportedByTable,
        columnsRedactedByTable,
        protectedColumnsByTable,
        totalRows,
        bypassed: true,
        backupRedacted: false,
        restorable: true,
      };
    }

    const filename =
      typeof gate.filename === 'function'
        ? gate.filename({ format: outcome.redacted.format })
        : gate.filename;

    // Collapse the structured shape into the legacy
    // `TenantBackup` JSON envelope. Non-redacted backups keep the
    // pre-D5.6D-1 wire shape exactly so existing restore tooling
    // continues to round-trip them. Redacted backups gain the
    // top-level `backupRedacted` / `restorable` markers + a
    // human-readable warning so a JSON-restore consumer can detect
    // and reject the file before parsing the data section.
    const wire = tenantBackupToWireEnvelope(outcome.redacted);
    const body = JSON.stringify(wire);
    const bytesShipped = Buffer.byteLength(body, 'utf8');

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'X-Export-Redacted-Columns',
      Object.values(outcome.columnsRedactedByTable).every((c) => c.length === 0)
        ? '(none)'
        : Object.entries(outcome.columnsRedactedByTable)
            .filter(([, c]) => c.length > 0)
            .map(([t, c]) => `${t}:${(c as readonly string[]).join('|')}`)
            .join(','),
    );
    if (outcome.backupRedacted) {
      // D5.6D-2 — surface the redacted-backup contract in HTTP
      // headers too so an admin downloading via curl + jq can spot
      // the rejection-required state without parsing the body.
      res.setHeader('X-Backup-Redacted', 'true');
      res.setHeader('X-Backup-Restorable', 'false');
    }

    if (flagOn) {
      try {
        // Flat columns lists (kept for parity with single-table
        // exports) are union sets across all tables, prefixed with
        // the table name so they remain unique.
        const flatColumnsExported: string[] = [];
        const flatColumnsRedacted: string[] = [];
        for (const t of outcome.tableNames) {
          for (const c of outcome.columnsExportedByTable[t] ?? []) {
            flatColumnsExported.push(`${t}.${c}`);
          }
          for (const c of outcome.columnsRedactedByTable[t] ?? []) {
            flatColumnsRedacted.push(`${t}.${c}`);
          }
        }

        const result = await this.auditService.recordExport({
          resource: gate.primary,
          actorUserId: user.sub,
          endpoint: `${req.method} ${stripQueryString(req.originalUrl ?? req.url)}`,
          filters: extractFilters(req),
          columnsExported: flatColumnsExported,
          columnsRedacted: flatColumnsRedacted,
          rowCount: outcome.totalRows,
          bytesShipped,
          flagState: 'on',
          tableNames: outcome.tableNames,
          rowCountByTable: outcome.rowCountByTable,
          columnsExportedByTable: outcome.columnsExportedByTable,
          columnsRedactedByTable: outcome.columnsRedactedByTable,
          protectedColumnsByTable: outcome.protectedColumnsByTable,
          redacted: outcome.backupRedacted,
          restorable: outcome.restorable,
        });
        res.setHeader('X-Export-Audit-Id', result.entityId);
      } catch (err) {
        this.logger.warn(
          `ExportInterceptor: audit write failed for ${gate.primary} export; continuing — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return body;
  }
}

// ─── helpers ───────────────────────────────────────────────────────

function isStructuredExport(value: unknown): value is StructuredExport {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<StructuredExport>;
  return (
    typeof v.format === 'string' &&
    typeof v.filename === 'string' &&
    Array.isArray(v.columns) &&
    Array.isArray(v.rows)
  );
}

function isStructuredTenantBackup(value: unknown): value is StructuredTenantBackup {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<StructuredTenantBackup>;
  return (
    v.format === 'json-tenant-backup' &&
    typeof v.filename === 'string' &&
    typeof v.exportedAt === 'string' &&
    typeof v.schemaVersion === 'number' &&
    typeof v.rowCap === 'number' &&
    Array.isArray(v.tables) &&
    typeof v.tenant === 'object' &&
    v.tenant !== null
  );
}

function serializeForFormat(structured: StructuredExport): string {
  switch (structured.format) {
    case 'csv':
    case 'csv-keyvalue':
      return serializeCsv(structured);
    case 'json':
      // D5.6A keeps json serialisation deliberately minimal —
      // the tenant backup hardening (D5.6D) will introduce a
      // per-table JSON serialiser. Until then, a JSON export
      // round-trips the redacted structure as-is for parity.
      return JSON.stringify(
        {
          comments: structured.comments ?? [],
          columns: structured.columns.map((c) => ({ key: c.key, label: c.label })),
          rows: structured.rows,
        },
        null,
        0,
      );
    default:
      throw new Error(`ExportInterceptor: unsupported format '${structured.format as string}'`);
  }
}

function mimeFor(format: ExportFormat): string {
  switch (format) {
    case 'csv':
    case 'csv-keyvalue':
      return 'text/csv; charset=utf-8';
    case 'json':
    case 'json-tenant-backup':
      return 'application/json; charset=utf-8';
  }
}

function stripQueryString(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

function extractFilters(req: Request): Record<string, unknown> {
  // Audit row records the parsed query string only — no body
  // contents (POST exports are out of scope today). Object copy
  // so the audit payload doesn't pin Express's internal request
  // shape.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.query ?? {})) {
    out[k] = v as unknown;
  }
  return out;
}
