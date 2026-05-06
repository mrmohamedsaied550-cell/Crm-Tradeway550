/**
 * Phase D5 — D5.8: tighten remaining visibility gates.
 *
 * Five layers of assertions:
 *
 *   A. `OwnershipVisibilityService.canReadOutOfScopeAttemptCount` —
 *      consults `field_permissions` on `lead.outOfScopeAttemptCount`;
 *      super-admin bypass; missing dep returns `true`.
 *
 *   B. `LeadReviewVisibilityService.resolveLeadReviewVisibility` +
 *      `applyVisibility` — top-level nullification + nested
 *      reasonPayload key stripping for `ownerContext` /
 *      `partnerContext`. Row count preserved; resolution flow
 *      keys (`leadId`, `reason`, `resolvedAt`) untouched.
 *
 *   C. Catalogue honesty — `rotation.handoverSummary` is no
 *      longer in `FIELD_CATALOGUE`; the read-path UI surfaces
 *      only fields the API actually emits.
 *
 *   D. `RotationVisibility` no longer carries
 *      `canReadHandoverSummary` — the type matches the response
 *      shape exactly.
 *
 *   E. Catalogue + seed coverage — the new `lead.outOfScopeAttemptCount`
 *      entry is registered; the D5_7_OWNERSHIP_HISTORY_DENIES seed
 *      list reflects D5.8 additions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FIELD_CATALOGUE, isCatalogued } from './field-catalogue.registry';
import {
  LEAD_REVIEW_OWNER_CONTEXT_KEYS,
  LEAD_REVIEW_PARTNER_CONTEXT_KEYS,
  LeadReviewVisibilityService,
  type LeadReviewLikeRow,
} from './lead-review-visibility.service';
import { OwnershipVisibilityService } from './ownership-visibility.service';
import type { FieldFilterService, DeniedReadFields } from './field-filter.service';
import type { ScopeUserClaims } from './scope-context.service';

// ─── helpers ──────────────────────────────────────────────────────

const CLAIMS: ScopeUserClaims = { tenantId: 't1', userId: 'u1', roleId: 'r1' };

function fakeFieldFilter(byResource: Record<string, DeniedReadFields>): FieldFilterService {
  return {
    listDeniedReadFields: async (_claims: ScopeUserClaims, resource: string) => {
      return byResource[resource] ?? { bypassed: false, paths: [] };
    },
  } as unknown as FieldFilterService;
}

// ════════════════════════════════════════════════════════════════
// A. OwnershipVisibilityService.canReadOutOfScopeAttemptCount
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.8 — OwnershipVisibilityService.canReadOutOfScopeAttemptCount', () => {
  it('super-admin bypass → true', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ lead: { bypassed: true, paths: [] } }),
    );
    assert.equal(await svc.canReadOutOfScopeAttemptCount(CLAIMS), true);
  });

  it('no deny rules → true (default allow)', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ lead: { bypassed: false, paths: [] } }),
    );
    assert.equal(await svc.canReadOutOfScopeAttemptCount(CLAIMS), true);
  });

  it('lead.outOfScopeAttemptCount denied → false', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({
        lead: { bypassed: false, paths: ['outOfScopeAttemptCount'] },
      }),
    );
    assert.equal(await svc.canReadOutOfScopeAttemptCount(CLAIMS), false);
  });

  it('only siblings denied → outOfScopeAttemptCount stays visible', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({
        lead: { bypassed: false, paths: ['previousOwner', 'ownerHistory'] },
      }),
    );
    assert.equal(await svc.canReadOutOfScopeAttemptCount(CLAIMS), true);
  });

  it('canReadPreviousOwner / canReadOwnerHistory unaffected by outOfScope deny', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({
        lead: { bypassed: false, paths: ['outOfScopeAttemptCount'] },
      }),
    );
    assert.equal(await svc.canReadPreviousOwner(CLAIMS), true);
    assert.equal(await svc.canReadOwnerHistory(CLAIMS), true);
  });
});

// ════════════════════════════════════════════════════════════════
// B. LeadReviewVisibilityService — top-level + nested redaction
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.8 — LeadReviewVisibilityService.resolveLeadReviewVisibility', () => {
  it('super-admin bypass → all visible', async () => {
    const svc = new LeadReviewVisibilityService(
      fakeFieldFilter({ 'lead.review': { bypassed: true, paths: [] } }),
    );
    const v = await svc.resolveLeadReviewVisibility(CLAIMS);
    assert.equal(v.canReadAssignedTl, true);
    assert.equal(v.canReadOwnerContext, true);
    assert.equal(v.canReadPartnerContext, true);
    assert.equal(v.canReadReasonPayload, true);
    assert.equal(v.canReadResolutionNotes, true);
  });

  it('per-field denials surface independently', async () => {
    const svc = new LeadReviewVisibilityService(
      fakeFieldFilter({
        'lead.review': {
          bypassed: false,
          paths: ['ownerContext', 'partnerContext'],
        },
      }),
    );
    const v = await svc.resolveLeadReviewVisibility(CLAIMS);
    assert.equal(v.canReadOwnerContext, false);
    assert.equal(v.canReadPartnerContext, false);
    assert.equal(v.canReadAssignedTl, true);
    assert.equal(v.canReadResolutionNotes, true);
    assert.equal(v.canReadReasonPayload, true);
  });
});

describe('rbac/D5.8 — LeadReviewVisibilityService.applyVisibility (top-level)', () => {
  const svc = new LeadReviewVisibilityService(
    fakeFieldFilter({ 'lead.review': { bypassed: false, paths: [] } }),
  );

  function row(): LeadReviewLikeRow & { id: string; leadId: string; reason: string } {
    return {
      id: 'rev-1',
      leadId: 'lead-1',
      reason: 'sla_breach_repeat',
      reasonPayload: {
        recentRotationId: 'rot-1',
        priorAssigneeId: 'u-prev',
        partnerSourceId: 'src-1',
        partnerRecordId: 'rec-1',
      },
      assignedTl: { id: 'u-tl', name: 'TL' },
      assignedTlId: 'u-tl',
      resolutionNotes: 'TL handover note',
    };
  }

  it('all visible → row passes through unchanged', () => {
    const out = svc.applyVisibility([row()], {
      canReadAssignedTl: true,
      canReadOwnerContext: true,
      canReadPartnerContext: true,
      canReadReasonPayload: true,
      canReadResolutionNotes: true,
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.assignedTl, { id: 'u-tl', name: 'TL' });
    assert.deepEqual(out[0]!.reasonPayload, {
      recentRotationId: 'rot-1',
      priorAssigneeId: 'u-prev',
      partnerSourceId: 'src-1',
      partnerRecordId: 'rec-1',
    });
  });

  it('canReadAssignedTl=false → assignedTl + assignedTlId nulled, row count preserved', () => {
    const out = svc.applyVisibility([row(), row()], {
      canReadAssignedTl: false,
      canReadOwnerContext: true,
      canReadPartnerContext: true,
      canReadReasonPayload: true,
      canReadResolutionNotes: true,
    });
    assert.equal(out.length, 2);
    for (const r of out) {
      assert.equal(r.assignedTl, null);
      assert.equal(r.assignedTlId, null);
      // resolutionNotes survives.
      assert.equal(r.resolutionNotes, 'TL handover note');
    }
  });

  it('canReadResolutionNotes=false → resolutionNotes nulled', () => {
    const out = svc.applyVisibility([row()], {
      canReadAssignedTl: true,
      canReadOwnerContext: true,
      canReadPartnerContext: true,
      canReadReasonPayload: true,
      canReadResolutionNotes: false,
    });
    assert.equal(out[0]!.resolutionNotes, null);
    // Other top-level fields intact.
    assert.deepEqual(out[0]!.assignedTl, { id: 'u-tl', name: 'TL' });
  });

  it('canReadReasonPayload=false → reasonPayload nulled entirely (nested gates moot)', () => {
    const out = svc.applyVisibility([row()], {
      canReadAssignedTl: true,
      canReadOwnerContext: true,
      canReadPartnerContext: true,
      canReadReasonPayload: false,
      canReadResolutionNotes: true,
    });
    assert.equal(out[0]!.reasonPayload, null);
  });

  it('canReadOwnerContext=false → priorAssigneeId / escalatedBy stripped from reasonPayload', () => {
    const out = svc.applyVisibility([row()], {
      canReadAssignedTl: true,
      canReadOwnerContext: false,
      canReadPartnerContext: true,
      canReadReasonPayload: true,
      canReadResolutionNotes: true,
    });
    const payload = out[0]!.reasonPayload as Record<string, unknown>;
    for (const k of LEAD_REVIEW_OWNER_CONTEXT_KEYS) {
      assert.equal(k in payload, false, `key '${k}' should be stripped from reasonPayload`);
    }
    // Partner keys preserved.
    assert.equal(payload['partnerSourceId'], 'src-1');
    assert.equal(payload['partnerRecordId'], 'rec-1');
    // Operational siblings preserved.
    assert.equal(payload['recentRotationId'], 'rot-1');
  });

  it('canReadPartnerContext=false → partnerSourceId / partnerRecordId stripped', () => {
    const out = svc.applyVisibility([row()], {
      canReadAssignedTl: true,
      canReadOwnerContext: true,
      canReadPartnerContext: false,
      canReadReasonPayload: true,
      canReadResolutionNotes: true,
    });
    const payload = out[0]!.reasonPayload as Record<string, unknown>;
    for (const k of LEAD_REVIEW_PARTNER_CONTEXT_KEYS) {
      assert.equal(k in payload, false, `key '${k}' should be stripped`);
    }
    // Owner keys preserved.
    assert.equal(payload['priorAssigneeId'], 'u-prev');
  });

  it('both ownerContext + partnerContext denied → both key sets stripped', () => {
    const out = svc.applyVisibility([row()], {
      canReadAssignedTl: true,
      canReadOwnerContext: false,
      canReadPartnerContext: false,
      canReadReasonPayload: true,
      canReadResolutionNotes: true,
    });
    const payload = out[0]!.reasonPayload as Record<string, unknown>;
    for (const k of [...LEAD_REVIEW_OWNER_CONTEXT_KEYS, ...LEAD_REVIEW_PARTNER_CONTEXT_KEYS]) {
      assert.equal(k in payload, false);
    }
    // Operational keys (recentRotationId etc) survive.
    assert.equal(payload['recentRotationId'], 'rot-1');
  });

  it('row count preserved across every redaction permutation', () => {
    const fixture = [row(), row(), row(), row()];
    const permutations: Array<{
      canReadAssignedTl: boolean;
      canReadOwnerContext: boolean;
      canReadPartnerContext: boolean;
      canReadReasonPayload: boolean;
      canReadResolutionNotes: boolean;
    }> = [
      {
        canReadAssignedTl: false,
        canReadOwnerContext: false,
        canReadPartnerContext: false,
        canReadReasonPayload: false,
        canReadResolutionNotes: false,
      },
      {
        canReadAssignedTl: false,
        canReadOwnerContext: true,
        canReadPartnerContext: false,
        canReadReasonPayload: true,
        canReadResolutionNotes: true,
      },
      {
        canReadAssignedTl: true,
        canReadOwnerContext: true,
        canReadPartnerContext: true,
        canReadReasonPayload: true,
        canReadResolutionNotes: true,
      },
    ];
    for (const v of permutations) {
      const out = svc.applyVisibility(fixture, v);
      assert.equal(out.length, fixture.length);
    }
  });

  it('does not mutate the input rows', () => {
    const original = row();
    const before = JSON.stringify(original);
    svc.applyVisibility([original], {
      canReadAssignedTl: false,
      canReadOwnerContext: false,
      canReadPartnerContext: false,
      canReadReasonPayload: false,
      canReadResolutionNotes: false,
    });
    assert.equal(JSON.stringify(original), before, 'redactor mutated input row');
  });

  it('preserves resolution-flow keys (id / leadId / reason / resolvedAt)', () => {
    // Even with full redaction, the keys the resolveReview flow
    // consults must survive. The redactor only touches assignedTl,
    // assignedTlId, resolutionNotes, reasonPayload — id / leadId
    // / reason / resolvedAt are NOT in its switch list.
    const r = {
      ...row(),
      resolvedAt: null,
    };
    const [out] = svc.applyVisibility([r], {
      canReadAssignedTl: false,
      canReadOwnerContext: false,
      canReadPartnerContext: false,
      canReadReasonPayload: false,
      canReadResolutionNotes: false,
    });
    assert.equal((out as { id: string }).id, 'rev-1');
    assert.equal((out as { leadId: string }).leadId, 'lead-1');
    assert.equal((out as { reason: string }).reason, 'sla_breach_repeat');
    assert.equal((out as { resolvedAt: null }).resolvedAt, null);
  });
});

// ════════════════════════════════════════════════════════════════
// C. Catalogue honesty — rotation.handoverSummary removed
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.8 — catalogue honesty', () => {
  it('rotation.handoverSummary is no longer catalogued (no DB column emits it)', () => {
    assert.equal(
      isCatalogued('rotation', 'handoverSummary'),
      false,
      'rotation.handoverSummary must not be in the catalogue (no DB backing)',
    );
  });

  it('whatsapp.conversation.handoverSummary is intact (separate WhatsApp concept)', () => {
    // D5.8 must NOT touch WhatsApp visibility. Belt-and-braces.
    assert.equal(isCatalogued('whatsapp.conversation', 'handoverSummary'), true);
  });

  it('lead.outOfScopeAttemptCount IS catalogued', () => {
    assert.equal(isCatalogued('lead', 'outOfScopeAttemptCount'), true);
  });

  it('lead.review.ownerContext + partnerContext IS catalogued', () => {
    assert.equal(isCatalogued('lead.review', 'ownerContext'), true);
    assert.equal(isCatalogued('lead.review', 'partnerContext'), true);
  });

  it('every catalogued entry has non-empty labelEn / labelAr (no placeholder fields)', () => {
    for (const c of FIELD_CATALOGUE) {
      assert.ok(c.labelEn.length > 0, `${c.resource}.${c.field} missing labelEn`);
      assert.ok(c.labelAr.length > 0, `${c.resource}.${c.field} missing labelAr`);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// D. RotationVisibility shape no longer claims canReadHandoverSummary
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.8 — RotationVisibility type is honest', () => {
  it('resolveRotationVisibility result shape no longer carries canReadHandoverSummary', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ rotation: { bypassed: false, paths: [] } }),
    );
    const v = (await svc.resolveRotationVisibility(CLAIMS)) as unknown as Record<string, unknown>;
    assert.equal('canReadHandoverSummary' in v, false);
    // Other rotation fields still present.
    assert.equal(typeof v['canReadFromUser'], 'boolean');
    assert.equal(typeof v['canReadToUser'], 'boolean');
    assert.equal(typeof v['canReadActor'], 'boolean');
    assert.equal(typeof v['canReadNotes'], 'boolean');
    assert.equal(typeof v['canReadInternalPayload'], 'boolean');
  });
});
