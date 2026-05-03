/**
 * Phase A — A4: helpers for building the `Lead.attribution` JSONB
 * payload from the various create paths (manual, CSV import, Meta
 * webhook, WhatsApp ingest).
 *
 * Two invariants every caller must honor:
 *   1. `attribution.source` ALWAYS equals the lead's flat `source`
 *      column. Distribution rules + reports continue to read either
 *      one and see the same value.
 *   2. Empty / missing nested objects are dropped before persist so
 *      we don't store `{ campaign: {} }` noise. Helpers below do
 *      this; callers that build payloads by hand should use them.
 */

import type { LeadSource } from './pipeline.registry';

export interface AttributionRef {
  id?: string;
  name?: string;
}

export interface AttributionUtm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

export interface AttributionPayload {
  /** Mirrors `Lead.source`; never set independently. */
  source: LeadSource;
  subSource?: string;
  campaign?: AttributionRef;
  adSet?: AttributionRef;
  ad?: AttributionRef;
  utm?: AttributionUtm;
  referrer?: string;
  custom?: Record<string, unknown>;
}

/** Inputs from the create DTO's `attribution` field — same shape minus `source`. */
export type AttributionInput = Omit<AttributionPayload, 'source'>;

/**
 * Build the persisted `attribution` JSONB from the lead's flat
 * `source` and an optional rich input payload. Strips empty nested
 * objects so the stored shape stays clean.
 */
export function buildAttribution(
  source: LeadSource,
  input?: AttributionInput | null,
): AttributionPayload {
  const out: AttributionPayload = { source };
  if (!input) return out;

  if (input.subSource && input.subSource.trim().length > 0) {
    out.subSource = input.subSource.trim();
  }
  const campaign = compactRef(input.campaign);
  if (campaign) out.campaign = campaign;
  const adSet = compactRef(input.adSet);
  if (adSet) out.adSet = adSet;
  const ad = compactRef(input.ad);
  if (ad) out.ad = ad;
  const utm = compactUtm(input.utm);
  if (utm) out.utm = utm;
  if (input.referrer && input.referrer.trim().length > 0) {
    out.referrer = input.referrer.trim();
  }
  if (input.custom && Object.keys(input.custom).length > 0) {
    out.custom = input.custom;
  }
  return out;
}

function compactRef(ref: AttributionRef | undefined): AttributionRef | undefined {
  if (!ref) return undefined;
  const id = ref.id?.trim();
  const name = ref.name?.trim();
  if (!id && !name) return undefined;
  const out: AttributionRef = {};
  if (id) out.id = id;
  if (name) out.name = name;
  return out;
}

function compactUtm(utm: AttributionUtm | undefined): AttributionUtm | undefined {
  if (!utm) return undefined;
  const fields: (keyof AttributionUtm)[] = ['source', 'medium', 'campaign', 'term', 'content'];
  const out: AttributionUtm = {};
  let any = false;
  for (const k of fields) {
    const v = utm[k]?.trim();
    if (v && v.length > 0) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}
