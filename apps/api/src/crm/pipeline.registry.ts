/**
 * Well-known stage definitions — the canonical 5-stage funnel that
 * the seed installs into every new tenant's default pipeline.
 *
 * Phase 1B note: this file is NO LONGER an enum that constrains
 * what stage codes the system accepts. Custom pipelines (built via
 * the Pipeline Builder admin UI) may define any codes they want;
 * the API treats `stage.code` as an open string. The constants
 * below are kept for two narrow reasons:
 *
 *   1. SEED — `seed.ts` reads `PIPELINE_STAGE_DEFINITIONS` to
 *      install the default pipeline for new tenants. Existing
 *      tenants pre-Pipeline-Builder rely on these exact 5 codes
 *      and the seed keeps the contract.
 *
 *   2. SYSTEM CONTRACTS — two codes are referenced by name from
 *      lifecycle code:
 *        • `DEFAULT_STAGE_CODE  ('new')`       — entry point used
 *           by CSV import + Meta webhook ingest. Every pipeline
 *           MUST define a stage with this code, or those callers
 *           throw `pipeline.stage.not_found`.
 *        • `CONVERTED_STAGE_CODE ('converted')` — terminal stage
 *           used by `CaptainsService.convertFromLead`. Same
 *           contract: every pipeline must define this code if it
 *           wants leads on it to be convertible to captains.
 *      Pipeline Builder admins are free to add any other codes
 *      alongside these; the system only cares about these two.
 *
 * Order MUST be unique-per-pipeline and starts at 10 (gaps make
 * manual insertion of intermediate stages later painless).
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
export const ACTIVITY_TYPES = [
  'note',
  'call',
  'stage_change',
  'assignment',
  // C11: emitted by AssignmentService when round-robin picks an assignee.
  // Distinct from `assignment` so reports can separate manual vs auto.
  'auto_assignment',
  // C11: emitted by SlaService.runReassignmentForBreaches when a lead's
  // SLA expires before the assignee responds.
  'sla_breach',
  // Phase D3 — D3.2: emitted by SlaService.recomputeThreshold when the
  // ladder bucket changes (ok ↔ t75 ↔ t100 ↔ t150 ↔ t200). Distinct
  // from `sla_breach` because the legacy binary breach path is still
  // wired and we don't want to double-stamp the timeline. Inert when
  // `D3_ENGINE_V1` resolves false.
  'sla_threshold_crossed',
  'system',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * Activity types that count as an "agent response" — receiving any of
 * these resets the lead's response-SLA clock. Pure system events
 * (sla_breach, system) and reassignment events (auto_assignment) do
 * NOT reset, otherwise the breach scanner would never fire.
 */
export const SLA_RESETTING_ACTIVITY_TYPES = [
  'note',
  'call',
  'stage_change',
  'assignment',
] as const satisfies readonly ActivityType[];

export function isSlaResetting(type: ActivityType): boolean {
  return (SLA_RESETTING_ACTIVITY_TYPES as readonly string[]).includes(type);
}
