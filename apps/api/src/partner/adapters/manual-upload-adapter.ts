import { Injectable } from '@nestjs/common';

import { CsvParseError, parseCsv } from '../../ingestion/csv.util';
import {
  AdapterError,
  type AdapterContext,
  type AdapterFetchOptions,
  type AdapterTestConnectionResult,
  type PartnerSheetAdapter,
  type RawPartnerRow,
  type TabInfo,
} from './partner-sheet-adapter';

/**
 * Phase D4 — D4.3: manual-upload adapter.
 *
 * The "manual" partner adapter doesn't read from a remote system —
 * the operator uploads a CSV string per sync. The sync engine
 * receives the CSV body via the controller (see
 * `POST /partner-sources/:id/sync-upload`) and stores it on a
 * private per-call `manualRows` field on the `AdapterContext`
 * extension below.
 *
 * Implementation reuses the existing `parseCsv` helper from the
 * lead-import pipeline — same UTF-8 BOM stripping, same
 * CRLF / CR / LF normalisation, same duplicate-header rejection.
 *
 * `testConnection` always returns 'ok' — there is no remote
 * service to probe. Manual sources don't have tabs.
 */
@Injectable()
export class ManualUploadAdapter implements PartnerSheetAdapter {
  readonly adapterCode = 'manual_upload';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async testConnection(_ctx: AdapterContext): Promise<AdapterTestConnectionResult> {
    return {
      status: 'ok',
      message:
        'Manual upload sources have no remote connection. Trigger a sync from the source detail page to upload a CSV.',
      tabs: [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async listTabs(_ctx: AdapterContext): Promise<TabInfo[]> {
    return [];
  }

  async fetchRows(
    ctx: AdapterContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _opts: AdapterFetchOptions,
  ): Promise<RawPartnerRow[]> {
    const csv = (ctx as ManualUploadContext).manualCsv;
    if (typeof csv !== 'string' || csv.trim().length === 0) {
      throw new AdapterError(
        'partner.adapter.invalid_payload',
        'Manual upload requires a non-empty CSV payload on the sync request.',
      );
    }
    try {
      const parsed = parseCsv(csv);
      // The CSV utility returns `Record<string, string>` rows
      // already keyed by header name — that's exactly the shape
      // `RawPartnerRow` expects.
      return parsed.rows;
    } catch (err) {
      if (err instanceof CsvParseError) {
        throw new AdapterError(
          'partner.adapter.invalid_payload',
          `Invalid CSV payload at line ${err.line}: ${err.message}`,
        );
      }
      throw new AdapterError(
        'partner.adapter.fetch_failed',
        `Manual upload parse failed: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Extension shape: the sync engine attaches the uploaded CSV
 * payload to the AdapterContext via this property when running the
 * manual flow. Other adapters ignore it.
 */
export interface ManualUploadContext extends AdapterContext {
  manualCsv?: string;
}
