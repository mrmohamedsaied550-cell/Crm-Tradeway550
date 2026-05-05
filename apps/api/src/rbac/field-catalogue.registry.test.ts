/**
 * Phase D5 — D5.2: field catalogue extension.
 *
 * Pure unit tests over the static catalogue. They lock in:
 *
 *   • every `(resource, field)` pair is unique,
 *   • every entry carries `labelEn` AND `labelAr`,
 *   • every entry has a `group`,
 *   • sensitive fields are explicitly marked,
 *   • `lead.id`, `captain.id`, `contact.id` are NOT redactable
 *     (UUIDs participate in URL routing),
 *   • no entry exposes raw partner credentials,
 *   • all 14 required resources exist,
 *   • `isCatalogued` and `isRedactable` work for known + unknown
 *     pairs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOGUE_RESOURCES,
  FIELD_CATALOGUE,
  isCatalogued,
  isRedactable,
  type CatalogueResource,
} from './field-catalogue.registry';

const REQUIRED_RESOURCES: ReadonlyArray<CatalogueResource> = [
  'lead',
  'lead.activity',
  'lead.review',
  'rotation',
  'followup',
  'captain',
  'contact',
  'partner_source',
  'partner.verification',
  'partner.evidence',
  'partner.reconciliation',
  'whatsapp.conversation',
  'report',
  'audit',
];

describe('rbac/field-catalogue.registry — D5.2', () => {
  it('every (resource, field) pair is unique', () => {
    const seen = new Set<string>();
    for (const e of FIELD_CATALOGUE) {
      const key = `${e.resource}::${e.field}`;
      assert.equal(seen.has(key), false, `duplicate catalogue entry: ${key}`);
      seen.add(key);
    }
  });

  it('every entry has non-empty labelEn and labelAr', () => {
    for (const e of FIELD_CATALOGUE) {
      assert.ok(
        typeof e.labelEn === 'string' && e.labelEn.length > 0,
        `${e.resource}.${e.field} missing labelEn`,
      );
      assert.ok(
        typeof e.labelAr === 'string' && e.labelAr.length > 0,
        `${e.resource}.${e.field} missing labelAr`,
      );
    }
  });

  it('every entry has a group', () => {
    for (const e of FIELD_CATALOGUE) {
      assert.ok(
        typeof e.group === 'string' && e.group.length > 0,
        `${e.resource}.${e.field} missing group`,
      );
    }
  });

  it('every entry has explicit sensitive / defaultRead / defaultWrite booleans', () => {
    for (const e of FIELD_CATALOGUE) {
      assert.equal(typeof e.sensitive, 'boolean', `${e.resource}.${e.field} sensitive not boolean`);
      assert.equal(typeof e.defaultRead, 'boolean');
      assert.equal(typeof e.defaultWrite, 'boolean');
    }
  });

  it('lead.id is not redactable (UUID participates in URL routing)', () => {
    const leadId = FIELD_CATALOGUE.find((e) => e.resource === 'lead' && e.field === 'id');
    assert.ok(leadId, 'lead.id catalogue entry present');
    assert.equal(leadId!.redactable, false);
    assert.equal(isRedactable('lead', 'id'), false);
  });

  it('captain.id and contact.id are not redactable', () => {
    const captainId = FIELD_CATALOGUE.find((e) => e.resource === 'captain' && e.field === 'id');
    const contactId = FIELD_CATALOGUE.find((e) => e.resource === 'contact' && e.field === 'id');
    assert.equal(captainId?.redactable, false);
    assert.equal(contactId?.redactable, false);
    assert.equal(isRedactable('captain', 'id'), false);
    assert.equal(isRedactable('contact', 'id'), false);
  });

  it('isRedactable returns true by default for catalogued entries without an explicit flag', () => {
    const phone = FIELD_CATALOGUE.find((e) => e.resource === 'lead' && e.field === 'phone');
    assert.ok(phone);
    assert.equal(phone!.redactable, undefined);
    assert.equal(isRedactable('lead', 'phone'), true);
  });

  it('isRedactable returns true for unknown (resource, field) pairs', () => {
    assert.equal(isRedactable('unknown_resource', 'whatever'), true);
  });

  it('no entry exposes raw partner credentials', () => {
    const leaks = FIELD_CATALOGUE.filter((e) => {
      const f = e.field.toLowerCase();
      // Any catalogue field that looks like a credential vector.
      return (
        f === 'credentials' ||
        f === 'credentialsplaintext' ||
        f === 'encryptedcredentials' ||
        f === 'privatekey' ||
        f === 'serviceaccountemail' ||
        f === 'sheetid' ||
        f.includes('credentialsciphertext')
      );
    });
    assert.deepEqual(
      leaks,
      [],
      `catalogue must not surface raw credentials; found: ${leaks.map((l) => `${l.resource}.${l.field}`).join(', ')}`,
    );
  });

  it('credentials metadata is catalogued as sensitive (admin-only intent)', () => {
    const meta = FIELD_CATALOGUE.find(
      (e) => e.resource === 'partner_source' && e.field === 'credentialsMetadata',
    );
    assert.ok(meta, 'partner_source.credentialsMetadata catalogue entry present');
    assert.equal(meta!.sensitive, true);
  });

  it('every required resource is present', () => {
    const present = new Set(FIELD_CATALOGUE.map((e) => e.resource));
    for (const r of REQUIRED_RESOURCES) {
      assert.equal(present.has(r), true, `required resource missing from catalogue: ${r}`);
    }
  });

  it('CATALOGUE_RESOURCES matches the set actually used', () => {
    const present = Array.from(new Set(FIELD_CATALOGUE.map((e) => e.resource))).sort();
    const declared = [...CATALOGUE_RESOURCES].sort();
    assert.deepEqual(declared, present);
  });

  it('isCatalogued: positive + negative cases', () => {
    assert.equal(isCatalogued('lead', 'phone'), true);
    assert.equal(isCatalogued('captain', 'commissionAmount'), true);
    assert.equal(isCatalogued('audit', 'payload'), true);
    assert.equal(isCatalogued('whatsapp.conversation', 'priorAgentMessages'), true);
    assert.equal(isCatalogued('lead', 'unknown_field_xyz'), false);
    assert.equal(isCatalogued('unknown_resource', 'whatever'), false);
  });

  it('sensitive fields cover the operationally critical set', () => {
    const sensitive = (resource: string, field: string) =>
      FIELD_CATALOGUE.find((e) => e.resource === resource && e.field === field)?.sensitive === true;

    // Ownership history (replaces hardcoded `userCanSeeOwnershipHistory` in D5.7).
    assert.equal(sensitive('lead', 'previousOwner'), true);
    assert.equal(sensitive('lead', 'ownerHistory'), true);

    // Attribution.
    assert.equal(sensitive('lead', 'campaignName'), true);
    assert.equal(sensitive('lead', 'attribution.campaign'), true);
    assert.equal(sensitive('lead', 'source'), true);

    // Audit payload.
    assert.equal(sensitive('audit', 'payload'), true);
    assert.equal(sensitive('audit', 'beforeAfter'), true);

    // WhatsApp history.
    assert.equal(sensitive('whatsapp.conversation', 'priorAgentMessages'), true);
    assert.equal(sensitive('whatsapp.conversation', 'handoverChain'), true);

    // Commission.
    assert.equal(sensitive('captain', 'commissionAmount'), true);
    assert.equal(sensitive('captain', 'commissionStatus'), true);

    // Raw payloads.
    assert.equal(sensitive('rotation', 'internalPayload'), true);
    assert.equal(sensitive('followup', 'internalPayload'), true);
    assert.equal(sensitive('whatsapp.conversation', 'internalMetadata'), true);
    assert.equal(sensitive('contact', 'rawMetadata'), true);
  });

  it('preserves the existing 23 lead entries (D5.2 is additive only for lead)', () => {
    const leadFields = new Set(
      FIELD_CATALOGUE.filter((e) => e.resource === 'lead').map((e) => e.field),
    );
    const required = [
      'id',
      'name',
      'phone',
      'email',
      'source',
      'attribution',
      'attribution.source',
      'attribution.subSource',
      'attribution.campaign',
      'attribution.adSet',
      'attribution.ad',
      'attribution.utm',
      'lifecycleState',
      'lostReasonId',
      'lostNote',
      'companyId',
      'countryId',
      'pipelineId',
      'assignedToId',
      'createdById',
      'slaStatus',
      'slaDueAt',
      'nextActionDueAt',
    ];
    for (const f of required) {
      assert.equal(leadFields.has(f), true, `missing pre-D5.2 lead field: ${f}`);
    }
  });

  it('defaultRead is true for every entry (D5.2 preserves allow-by-default contract)', () => {
    for (const e of FIELD_CATALOGUE) {
      assert.equal(
        e.defaultRead,
        true,
        `${e.resource}.${e.field} should default to readable in D5.2 (strict mode lands later)`,
      );
    }
  });
});
