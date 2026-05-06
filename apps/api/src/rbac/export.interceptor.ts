import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';

import type { AccessTokenClaims } from '../identity/jwt.types';

import { isD5DynamicPermissionsV1Enabled } from './d5-feature-flag';
import { serializeCsv } from './csv-serializer';
import type { ExportFormat, StructuredExport } from './export-contract';
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
 * Bypass paths (interceptor returns the controller's payload
 * unchanged):
 *
 *   1. No `@ExportGate` metadata on the route.
 *   2. `D5_DYNAMIC_PERMISSIONS_V1` is `false`.
 *   3. The handler did not return a `StructuredExport` shape (e.g.
 *      a controller still uses `@Res() res.send(...)` — D5.6A
 *      does NOT wire any controller, so this is the universal
 *      state until D5.6B-D land).
 *   4. Missing `req.user` (defensive — JwtAuthGuard would have
 *      rejected the request before reaching here).
 *
 * Active path:
 *
 *   • Resolve permissions via `PermissionResolverService` (cached
 *     by D5.1's LRU).
 *   • Run `ExportRedactionService.redactColumns` — non-redactable
 *     ID columns + super-admin always survive.
 *   • Serialise the redacted shape to the requested `format`.
 *   • Set headers.
 *   • Persist the audit row via `ExportAuditService`.
 *   • Return the serialised string.
 *
 * Audit failures are swallowed inside `AuditService.writeEvent`;
 * this layer never blocks the download on an audit failure.
 *
 * D5.6A registers the interceptor globally. No controller has
 * `@ExportGate` yet — every existing endpoint passes through.
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

    if (!isD5DynamicPermissionsV1Enabled()) {
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
    if (!isStructuredExport(data)) {
      // The handler hasn't been refactored to the structured
      // contract yet (D5.6A is foundation only — no controller
      // wires this in this commit). Pass the payload through
      // unchanged; later chunks will retire the legacy paths.
      this.logger.debug(
        `ExportInterceptor: route ${req.method} ${req.url} declared @ExportGate(${gate.primary}) but returned a non-structured payload; passthrough.`,
      );
      return data;
    }

    const resolved = await this.resolver.resolveForUser({
      tenantId: user.tid,
      userId: user.sub,
      roleId: user.rid,
    });

    const outcome = this.redactor.redactColumns(data, resolved);

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

    // Persist audit metadata — best-effort.
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
