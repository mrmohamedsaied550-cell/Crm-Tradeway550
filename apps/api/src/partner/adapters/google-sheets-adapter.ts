import { Injectable, Logger } from '@nestjs/common';

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
 * Phase D4 — D4.3: Google Sheets adapter — SEAM ONLY.
 *
 * The Google Sheets v4 client is intentionally NOT wired in D4.3.
 * Wiring it requires either:
 *   1. A new dependency (`googleapis` ~ 90 MB on disk) or a slim
 *      hand-rolled JWT-signed REST client, AND
 *   2. Live operator credentials in a working tenant to validate
 *      the integration end-to-end.
 *
 * Both of those are deployment / operator concerns rather than D4
 * engine concerns. D4.3 ships the SEAM:
 *   - the adapter interface is implemented,
 *   - the sync engine routes Google Sheets sources here,
 *   - every method returns a typed `AdapterError` with code
 *     `partner.adapter.not_wired` so the snapshot lands as
 *     `failed` with a clear, operator-readable error name —
 *     NOT as a fake success.
 *
 * Wiring landing in a follow-up:
 *   1. Implement JWT(RS256) signing using node:crypto.
 *   2. Exchange JWT for OAuth2 access token at
 *      https://oauth2.googleapis.com/token.
 *   3. Call https://sheets.googleapis.com/v4/spreadsheets/{sheetId}
 *      and /values/{range} for tab discovery + row fetch.
 *   4. Map the typed Sheets API errors (401 → auth_failed; 404 →
 *      sheet_not_found; 403 → auth_failed; other → fetch_failed).
 *
 * The `Injectable` decoration keeps DI consistent with the manual
 * adapter so the sync engine can resolve adapters by code without
 * a special case for the seam.
 */
@Injectable()
export class GoogleSheetsAdapter implements PartnerSheetAdapter {
  readonly adapterCode = 'google_sheets';
  private readonly logger = new Logger(GoogleSheetsAdapter.name);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async testConnection(ctx: AdapterContext): Promise<AdapterTestConnectionResult> {
    this.logger.warn(
      `Google Sheets adapter is not wired for tenant source ${ctx.partnerSourceId}; testConnection returned not_wired.`,
    );
    return {
      status: 'not_wired',
      message:
        'Google Sheets adapter is not wired in this build. Configuration is validated; data fetch is unavailable until the adapter ships.',
      tabs: [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async listTabs(_ctx: AdapterContext): Promise<TabInfo[]> {
    throw new AdapterError(
      'partner.adapter.not_wired',
      'Google Sheets adapter is not wired in this build.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetchRows(_ctx: AdapterContext, _opts: AdapterFetchOptions): Promise<RawPartnerRow[]> {
    throw new AdapterError(
      'partner.adapter.not_wired',
      'Google Sheets adapter is not wired in this build. Use the manual upload flow until the adapter ships.',
    );
  }
}
