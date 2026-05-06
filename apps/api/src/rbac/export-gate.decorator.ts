import { SetMetadata } from '@nestjs/common';

import type { CatalogueResource } from './field-catalogue.registry';
import type { ExportFormat } from './export-contract';

/**
 * Phase D5 — D5.6A: route metadata key consumed by
 * `ExportInterceptor`. Distinct from `RESOURCE_FIELD_GATE_KEY` so
 * an export route can carry both decorators (the field gate also
 * applies to non-export reads, but the export interceptor needs
 * extra metadata: format, filename, inherits).
 */
export const EXPORT_GATE_KEY = 'd5.exportGate';

/**
 * Configuration for an export route.
 */
export interface ExportGateOptions {
  /**
   * Primary resource the export reports against. Used as the
   * audit row's `entityType` and as the action prefix —
   * `<primary>.export.completed`.
   */
  readonly primary: CatalogueResource;
  /**
   * Optional list of OTHER resources whose deny rules also apply
   * to columns in this export. The redactor reads
   * `deniedReadFieldsByResource[r]` for every `r` in
   * `[primary, ...inherits]` and looks up each column's deny rule
   * under its own `column.resource`. `inherits` documents the
   * intent for code reviewers — a runtime mismatch (a column
   * pointing at a resource not in `inherits`) is non-fatal but
   * flagged by tests.
   */
  readonly inherits?: readonly CatalogueResource[];
  /** Output format. Drives serialiser selection. */
  readonly format: ExportFormat;
  /**
   * Static filename or callback. The interceptor uses it for
   * `Content-Disposition`. Callback receives the structured
   * export so a date-stamped filename can derive from the
   * payload's metadata if needed.
   */
  readonly filename: string | ((payload: { format: ExportFormat }) => string);
}

/**
 * Decorator factory.
 *
 * Apply alongside `@RequireCapability(...)` (the export-cap gate)
 * and `@ResourceFieldGate(...)` (kept for parity with read paths
 * — JSON consumers of the same controller method continue to use
 * it). Single-resource convention: a route returns one
 * `StructuredExport` shape; mix-resource expansion is encoded in
 * `inherits`, not in multiple `@ExportGate` calls.
 *
 * D5.6A registers the decorator + interceptor; no controller
 * applies it yet. D5.6B is the first chunk to actually wire it.
 */
export function ExportGate(options: ExportGateOptions): MethodDecorator {
  return SetMetadata(EXPORT_GATE_KEY, options);
}
