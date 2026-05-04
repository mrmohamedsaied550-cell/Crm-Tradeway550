import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Phase C — C10B-4: Contact read + cleaned-data update.
 *
 * Visibility model: a contact is visible iff at least one of its
 * conversations is visible under the actor's scope. This intentionally
 * piggy-backs on the conversation scope rather than introducing a new
 * RoleScope resource (locked decision §4-style — keep the catalogue
 * lean).
 *
 * Update model: split into two surfaces.
 *   - `update` — agents with `whatsapp.contact.write` can edit
 *     `displayName` and `language`. Any payload that includes immutable
 *     fields (originalPhone, originalDisplayName, rawProfile, phone)
 *     is silent-stripped + audit'd `field_write_denied` (mirrors C5's
 *     pattern for lead writes). Locked safety decision.
 *   - `updateRaw` — super-admin-only override that accepts the
 *     immutable fields. Gated by `whatsapp.contact.write.raw`.
 *
 * Read shape: `findByIdInScope` returns a "safe" projection (no
 * raw provider snapshot). `findByIdInScopeRaw` returns the full row
 * for users with `whatsapp.contact.write.raw`. The controller picks
 * which to call based on the actor's capabilities.
 */

const CLEANED_FIELDS: ReadonlyArray<keyof ContactUpdateInput> = [
  'displayName',
  'language',
] as const;
const RAW_ONLY_FIELDS = ['phone', 'originalPhone', 'originalDisplayName', 'rawProfile'] as const;

export interface ContactUpdateInput {
  displayName?: string | null;
  language?: string | null;
}

export interface ContactRawUpdateInput extends ContactUpdateInput {
  phone?: string;
  originalPhone?: string;
  originalDisplayName?: string | null;
  rawProfile?: Prisma.InputJsonValue | null;
}

/** Safe projection — no raw provider snapshot. */
const SAFE_SELECT = {
  id: true,
  tenantId: true,
  phone: true,
  displayName: true,
  language: true,
  firstSeenAt: true,
  lastSeenAt: true,
  isCaptain: true,
  hasOpenLead: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ContactSelect;

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeContext: ScopeContextService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Public-safe read. Used by callers without
   * `whatsapp.contact.write.raw` — strips the immutable provider
   * snapshot fields before returning.
   */
  async findByIdInScope(claims: ScopeUserClaims, id: string) {
    const tenantId = requireTenantId();
    const { where: convoScope } = await this.scopeContext.resolveConversationScope(claims);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.ContactWhereInput = {
        id,
        ...(convoScope && { conversations: { some: convoScope } }),
      };
      return tx.contact.findFirst({ where, select: SAFE_SELECT });
    });
  }

  /**
   * Raw read — includes `originalPhone`, `originalDisplayName`,
   * `rawProfile`. The controller calls this only when the actor
   * carries `whatsapp.contact.write.raw`.
   */
  async findByIdInScopeRaw(claims: ScopeUserClaims, id: string) {
    const tenantId = requireTenantId();
    const { where: convoScope } = await this.scopeContext.resolveConversationScope(claims);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.ContactWhereInput = {
        id,
        ...(convoScope && { conversations: { some: convoScope } }),
      };
      return tx.contact.findFirst({ where });
    });
  }

  /**
   * Cleaned-data update. Silently strips any immutable raw fields
   * the caller might have included; emits `field_write_denied` audit
   * when stripping happened (consistent with C5's lead-write
   * denials).
   */
  async update(claims: ScopeUserClaims, id: string, input: ContactRawUpdateInput) {
    const tenantId = requireTenantId();
    const denied = RAW_ONLY_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(input, f));
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Visibility check — re-read under conversation scope.
      const { where: convoScope } = await this.scopeContext.resolveConversationScope(claims);
      const existing = await tx.contact.findFirst({
        where: { id, ...(convoScope && { conversations: { some: convoScope } }) },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException({
          code: 'whatsapp.contact.not_found',
          message: `Contact ${id} not found in active tenant`,
        });
      }
      const data: Prisma.ContactUncheckedUpdateInput = {};
      for (const f of CLEANED_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(input, f)) {
          (data as Record<string, unknown>)[f] = input[f] ?? null;
        }
      }
      if (Object.keys(data).length === 0 && denied.length === 0) {
        throw new BadRequestException({
          code: 'whatsapp.contact.empty_update',
          message: 'No editable fields supplied',
        });
      }
      // Audit silent strips. Mirrors C5's `field_write_denied`
      // semantic — payload carries field names, never values.
      if (denied.length > 0) {
        await this.audit.writeInTx(tx, tenantId, {
          action: 'field_write_denied',
          entityType: 'whatsapp.contact',
          entityId: id,
          actorUserId: claims.userId,
          payload: {
            resource: 'whatsapp.contact',
            operation: 'update',
            deniedFields: denied,
          } as unknown as Prisma.InputJsonValue,
        });
      }
      const updated = await tx.contact.update({
        where: { id },
        data,
        select: SAFE_SELECT,
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'whatsapp.contact.updated',
        entityType: 'whatsapp.contact',
        entityId: id,
        actorUserId: claims.userId,
        payload: {
          fields: Object.keys(data),
        } as unknown as Prisma.InputJsonValue,
      });
      return updated;
    });
  }

  /**
   * Raw override — super-admin path. Allows mutating
   * `originalPhone` / `originalDisplayName` / `rawProfile` / `phone`.
   * The controller's `whatsapp.contact.write.raw` capability is the
   * sole gate; service does NOT re-check the capability (keeps the
   * service decoupled from the capability layer; the test suite
   * exercises both layers).
   */
  async updateRaw(claims: ScopeUserClaims, id: string, input: ContactRawUpdateInput) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const { where: convoScope } = await this.scopeContext.resolveConversationScope(claims);
      const existing = await tx.contact.findFirst({
        where: { id, ...(convoScope && { conversations: { some: convoScope } }) },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException({
          code: 'whatsapp.contact.not_found',
          message: `Contact ${id} not found in active tenant`,
        });
      }
      const data: Prisma.ContactUncheckedUpdateInput = {};
      for (const f of CLEANED_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(input, f)) {
          (data as Record<string, unknown>)[f] = input[f] ?? null;
        }
      }
      // Raw fields — write through verbatim. `phone` change
      // additionally checks the unique constraint at the DB level.
      if (input.phone !== undefined) data.phone = input.phone;
      if (input.originalPhone !== undefined) data.originalPhone = input.originalPhone;
      if (input.originalDisplayName !== undefined) {
        data.originalDisplayName = input.originalDisplayName ?? null;
      }
      if (input.rawProfile !== undefined) {
        data.rawProfile = input.rawProfile as Prisma.InputJsonValue | typeof Prisma.JsonNull;
      }
      if (Object.keys(data).length === 0) {
        throw new BadRequestException({
          code: 'whatsapp.contact.empty_update',
          message: 'No fields supplied',
        });
      }
      try {
        const updated = await tx.contact.update({
          where: { id },
          data,
          select: SAFE_SELECT,
        });
        await this.audit.writeInTx(tx, tenantId, {
          action: 'whatsapp.contact.raw_updated',
          entityType: 'whatsapp.contact',
          entityId: id,
          actorUserId: claims.userId,
          payload: {
            fields: Object.keys(data),
          } as unknown as Prisma.InputJsonValue,
        });
        return updated;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BadRequestException({
            code: 'whatsapp.contact.duplicate_phone',
            message: `Another contact already has phone ${input.phone}`,
          });
        }
        throw err;
      }
    });
  }
}
