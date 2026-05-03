import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

import type { CreateLostReasonDto, UpdateLostReasonDto } from './lost-reasons.dto';

/**
 * Phase A — A2: per-tenant rejection-reason catalogue.
 *
 * Reads + writes are wrapped in `withTenant` so the FORCE-RLS policy
 * is the gate. Two surfaces are exposed:
 *
 *   • `listActive()`     — agent-side dropdown (active reasons only,
 *                          ordered). Used by the lost-reason modal.
 *   • `listAll()`        — admin surface (includes inactive).
 *   • `create / update`  — admin only.
 *
 * Two invariants enforced beyond Zod:
 *   1. The seed-installed `'other'` reason is protected from
 *      deactivation — there must always be a fallback option.
 *   2. Deactivating a reason that's still referenced by leads is
 *      allowed (soft-retire); deleting one is not (`ON DELETE
 *      RESTRICT` at the FK; we reject earlier with a typed code).
 */

const PROTECTED_CODE = 'other';

@Injectable()
export class LostReasonsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active reasons in display order — for the lead-detail / lost-stage modal. */
  listActive() {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.lostReason.findMany({
        where: { isActive: true },
        orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
        select: this.publicSelect(),
      }),
    );
  }

  /** Every reason (admin surface — `/admin/lost-reasons`). */
  listAll() {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.lostReason.findMany({
        orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
        select: this.publicSelect(),
      }),
    );
  }

  async create(dto: CreateLostReasonDto) {
    const tenantId = requireTenantId();
    try {
      return await this.prisma.withTenant(tenantId, (tx) =>
        tx.lostReason.create({
          data: {
            tenantId,
            code: dto.code,
            labelEn: dto.labelEn,
            labelAr: dto.labelAr,
            isActive: dto.isActive,
            displayOrder: dto.displayOrder,
          },
          select: this.publicSelect(),
        }),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'lost_reason.code_already_exists',
          message: `A lost reason with code "${dto.code}" already exists in this tenant`,
        });
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateLostReasonDto) {
    const tenantId = requireTenantId();
    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.lostReason.findUnique({ where: { id }, select: { id: true, code: true } }),
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'lost_reason.not_found',
        message: `Lost reason ${id} not found in active tenant`,
      });
    }
    // Invariant: 'other' must always remain active so the system has
    // a fallback reason for ad-hoc rejections.
    if (existing.code === PROTECTED_CODE && dto.isActive === false) {
      throw new BadRequestException({
        code: 'lost_reason.protected_cannot_deactivate',
        message: `The "${PROTECTED_CODE}" reason is protected and cannot be deactivated`,
      });
    }

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.lostReason.update({
        where: { id },
        data: {
          ...(dto.labelEn !== undefined && { labelEn: dto.labelEn }),
          ...(dto.labelAr !== undefined && { labelAr: dto.labelAr }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.displayOrder !== undefined && { displayOrder: dto.displayOrder }),
        },
        select: this.publicSelect(),
      }),
    );
  }

  /**
   * Read-only existence check used by `LeadsService.moveStage` (A3)
   * to validate a `lostReasonId` payload BEFORE writing the lead
   * row. Returns `null` if the reason doesn't exist or is inactive
   * — both states reject a lost-stage move with the same typed code
   * so the agent isn't told "this reason exists but is hidden".
   */
  async findActiveByIdInTx(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{ id: string; code: string } | null> {
    return tx.lostReason.findFirst({
      where: { id, isActive: true },
      select: { id: true, code: true },
    });
  }

  private publicSelect(): Prisma.LostReasonSelect {
    return {
      id: true,
      code: true,
      labelEn: true,
      labelAr: true,
      isActive: true,
      displayOrder: true,
      createdAt: true,
      updatedAt: true,
    };
  }
}
