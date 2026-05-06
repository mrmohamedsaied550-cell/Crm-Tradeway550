import { Injectable } from '@nestjs/common';

import { FieldFilterService } from './field-filter.service';
import type { ScopeUserClaims } from './scope-context.service';

/**
 * Phase D5 — D5.7 / D5.8: ownership-history visibility resolver.
 *
 * Replaces the hardcoded `lead.write` capability check that
 * `RotationService.userCanSeeOwnershipHistory` and
 * `LeadsService.userCanSeePreviousOwner` previously used. The new
 * gate consults the `field_permissions` table directly so an admin
 * can grant "see owner history" to a role independently of edit
 * permissions, or revoke it from a role that holds `lead.write`.
 *
 * Surfaces:
 *
 *   • Rotation history (`GET /leads/:id/rotations`,
 *     `RotationService.listRotationsForLead`) — per-field deny
 *     rows under resource `'rotation'`. Each rotation log row
 *     carries `fromUser` / `toUser` / `actor` / `notes` /
 *     `internalPayload` columns; the visibility result drives a
 *     per-field nullification at the service layer.
 *
 *   • Previous-owner / owner-history (`GET /leads/:id/attempts`
 *     and lead-detail surfaces) — deny rows under resource
 *     `'lead'` on `previousOwner` / `ownerHistory` catalogue
 *     fields.
 *
 *   • D5.8 — out-of-scope attempt count
 *     (`GET /leads/:id/attempts.outOfScopeCount`) — deny row under
 *     `lead.outOfScopeAttemptCount`. Hides the numeric count of
 *     predecessors outside the caller's scope. When denied, the
 *     response carries `outOfScopeCount: null` so the UI can
 *     decide whether to render a generic "older attempts may
 *     exist" hint without disclosing the count.
 *
 * Bypass:
 *   - Super-admin always sees everything (mirrors
 *     FieldFilterService.listDeniedReadFields).
 *
 * Defaults — preserved by D5.7's migration 0040 + seed (rotation
 * + lead.previousOwner / ownerHistory) and D5.8's migration 0041
 * + seed (lead.outOfScopeAttemptCount + lead.review.ownerContext /
 * partnerContext) which install idempotent deny rows for
 * `sales_agent`, `activation_agent`, and `driving_agent`. TL+ /
 * Ops / AM / Super Admin keep visibility because no deny row is
 * written for them.
 */

export interface RotationVisibility {
  readonly canReadFromUser: boolean;
  readonly canReadToUser: boolean;
  readonly canReadActor: boolean;
  readonly canReadNotes: boolean;
  readonly canReadInternalPayload: boolean;
}

const ROTATION_FIELDS_ALL_VISIBLE: RotationVisibility = {
  canReadFromUser: true,
  canReadToUser: true,
  canReadActor: true,
  canReadNotes: true,
  canReadInternalPayload: true,
};

@Injectable()
export class OwnershipVisibilityService {
  constructor(private readonly fieldFilter: FieldFilterService) {}

  /**
   * Resolve which rotation-history fields the caller's role may
   * read. The service consults `field_permissions` for resource
   * `'rotation'` and inverts each catalogue field's deny status.
   *
   * Super-admin → all true (bypass).
   * Empty deny list → all true (catalogue's `defaultRead: true`).
   * Per-field deny row → that single field flips to false; siblings
   *                      remain true.
   */
  async resolveRotationVisibility(claims: ScopeUserClaims): Promise<RotationVisibility> {
    const { bypassed, paths } = await this.fieldFilter.listDeniedReadFields(claims, 'rotation');
    if (bypassed) return ROTATION_FIELDS_ALL_VISIBLE;
    const denied = new Set(paths);
    return {
      canReadFromUser: !denied.has('fromUser'),
      canReadToUser: !denied.has('toUser'),
      canReadActor: !denied.has('actor'),
      canReadNotes: !denied.has('notes'),
      canReadInternalPayload: !denied.has('internalPayload'),
    };
  }

  /**
   * Convenience accessor: `true` when the caller may see ANY of
   * `fromUser` / `toUser` / `actor` on a rotation row. Drives the
   * `canSeeOwners` UX hint on the rotation-history response — the
   * old hardcoded gate returned a single boolean; the new contract
   * returns the same boolean as a derived value of the per-field
   * checks so existing clients keep their UI label.
   */
  async canSeeOwners(claims: ScopeUserClaims): Promise<boolean> {
    const v = await this.resolveRotationVisibility(claims);
    return v.canReadFromUser && v.canReadToUser && v.canReadActor;
  }

  /**
   * `true` when the caller may see the predecessor lead's
   * `assignedTo` info on the attempts-history surface
   * (`GET /leads/:id/attempts`). Backed by a deny row under
   * `lead.previousOwner`.
   *
   * Super-admin always returns true.
   */
  async canReadPreviousOwner(claims: ScopeUserClaims): Promise<boolean> {
    const { bypassed, paths } = await this.fieldFilter.listDeniedReadFields(claims, 'lead');
    if (bypassed) return true;
    return !paths.includes('previousOwner');
  }

  /**
   * `true` when the caller may see the aggregated owner-history
   * payload on lead-detail surfaces. Backed by a deny row under
   * `lead.ownerHistory`. Distinct from `canReadPreviousOwner`
   * because owner-history is a summary projection (the entire
   * chain) while previous-owner is the immediately-preceding
   * attempt's assignee.
   */
  async canReadOwnerHistory(claims: ScopeUserClaims): Promise<boolean> {
    const { bypassed, paths } = await this.fieldFilter.listDeniedReadFields(claims, 'lead');
    if (bypassed) return true;
    return !paths.includes('ownerHistory');
  }

  /**
   * D5.8 — `true` when the caller may see the count of attempts
   * outside their scope. Backed by a deny row under
   * `lead.outOfScopeAttemptCount`. When false, the
   * `outOfScopeCount` field on the attempts response is set to
   * `null` so the existence of out-of-scope predecessors is no
   * longer disclosed.
   */
  async canReadOutOfScopeAttemptCount(claims: ScopeUserClaims): Promise<boolean> {
    const { bypassed, paths } = await this.fieldFilter.listDeniedReadFields(claims, 'lead');
    if (bypassed) return true;
    return !paths.includes('outOfScopeAttemptCount');
  }
}
