/**
 * Default pipeline stages — single shared funnel per tenant in MVP.
 *
 * Per-Company × Country pipelines (per the PRD) layer on later;
 * each tenant's seed currently produces this 5-stage catalogue.
 *
 * Order MUST be unique-per-tenant and starts at 10 (gaps make manual
 * insertion of intermediate stages later painless).
 */

export interface PipelineStageDef {
  readonly code: string;
  readonly name: string;
  readonly order: number;
  readonly isTerminal: boolean;
}

export const PIPELINE_STAGE_DEFINITIONS = [
  { code: 'new', name: 'New', order: 10, isTerminal: false },
  { code: 'contacted', name: 'Contacted', order: 20, isTerminal: false },
  { code: 'interested', name: 'Interested', order: 30, isTerminal: false },
  { code: 'converted', name: 'Converted', order: 40, isTerminal: true },
  { code: 'lost', name: 'Lost', order: 50, isTerminal: true },
] as const satisfies readonly PipelineStageDef[];

export type StageCode = (typeof PIPELINE_STAGE_DEFINITIONS)[number]['code'];

export const ALL_STAGE_CODES: readonly StageCode[] = PIPELINE_STAGE_DEFINITIONS.map((s) => s.code);

/** Shape used by Lead.create when a stage isn't explicitly chosen. */
export const DEFAULT_STAGE_CODE: StageCode = 'new';

export const CONVERTED_STAGE_CODE: StageCode = 'converted';

/** Allowed lead sources (extensible — kept in code for OpenAPI completeness). */
export const LEAD_SOURCES = ['manual', 'meta', 'tiktok', 'whatsapp', 'import'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/** Activity types written by the system or the agent. */
export const ACTIVITY_TYPES = ['note', 'call', 'stage_change', 'assignment', 'system'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
