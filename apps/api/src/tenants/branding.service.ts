import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

import { requireTenantId } from './tenant-context';
import type { TenantBranding, UpdateTenantBrandingDto } from './branding.dto';

/**
 * Sprint 15 (D15) — TenantBranding service.
 *
 * Sits on top of the existing TenantSettings row: branding lives in the
 * same per-tenant 1:1 table rather than its own model, so the
 * "settings" surface stays in one place and there's only one upsert
 * to keep authoritative.
 *
 * Capability gates are enforced at the controller (`tenant.settings.read`
 * for GET, `tenant.settings.write` for PATCH). The service trusts that
 * the caller passed the controller's gate; it focuses on:
 *   • applying partial updates with null-vs-undefined semantics,
 *   • stamping `brandUpdatedAt + brandUpdatedById` for the audit trail,
 *   • emitting an audit event with the diff payload.
 */
@Injectable()
export class TenantBrandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getCurrent(): Promise<TenantBranding> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantSettings.findUnique({
        where: { tenantId },
        select: {
          tenantId: true,
          brandSystemName: true,
          brandWorkspaceName: true,
          brandLogoUrl: true,
          brandFaviconUrl: true,
          brandLoginImageUrl: true,
          brandPrimaryColor: true,
          brandAccentColor: true,
          brandSidebarBgColor: true,
          brandSidebarHoverColor: true,
          brandUpdatedAt: true,
          brandUpdatedById: true,
        },
      }),
    );
    if (!row) return emptyBranding(tenantId);
    return rowToBranding(row);
  }

  /**
   * Partial update. `undefined` skips the field, `null` clears it,
   * a non-null value writes it. The DTO type encodes the three-way
   * difference; Prisma's `update.data` natively accepts `null` for
   * nullable columns so we just pass the keys through.
   */
  async update(dto: UpdateTenantBrandingDto, actorUserId: string | null): Promise<TenantBranding> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.tenantSettings.findUnique({
        where: { tenantId },
        select: {
          brandSystemName: true,
          brandWorkspaceName: true,
          brandLogoUrl: true,
          brandFaviconUrl: true,
          brandLoginImageUrl: true,
          brandPrimaryColor: true,
          brandAccentColor: true,
          brandSidebarBgColor: true,
          brandSidebarHoverColor: true,
        },
      });

      const data: Prisma.TenantSettingsUpdateInput = {
        ...(dto.systemName !== undefined && { brandSystemName: dto.systemName }),
        ...(dto.workspaceName !== undefined && { brandWorkspaceName: dto.workspaceName }),
        ...(dto.logoUrl !== undefined && { brandLogoUrl: dto.logoUrl }),
        ...(dto.faviconUrl !== undefined && { brandFaviconUrl: dto.faviconUrl }),
        ...(dto.loginImageUrl !== undefined && { brandLoginImageUrl: dto.loginImageUrl }),
        ...(dto.primaryColor !== undefined && { brandPrimaryColor: dto.primaryColor }),
        ...(dto.accentColor !== undefined && { brandAccentColor: dto.accentColor }),
        ...(dto.sidebarBgColor !== undefined && { brandSidebarBgColor: dto.sidebarBgColor }),
        ...(dto.sidebarHoverColor !== undefined && {
          brandSidebarHoverColor: dto.sidebarHoverColor,
        }),
        brandUpdatedAt: new Date(),
        ...(actorUserId !== null && {
          brandUpdatedBy: { connect: { id: actorUserId } },
        }),
      };

      const updated = await tx.tenantSettings.upsert({
        where: { tenantId },
        update: data,
        create: {
          tenantId,
          brandSystemName: dto.systemName ?? null,
          brandWorkspaceName: dto.workspaceName ?? null,
          brandLogoUrl: dto.logoUrl ?? null,
          brandFaviconUrl: dto.faviconUrl ?? null,
          brandLoginImageUrl: dto.loginImageUrl ?? null,
          brandPrimaryColor: dto.primaryColor ?? null,
          brandAccentColor: dto.accentColor ?? null,
          brandSidebarBgColor: dto.sidebarBgColor ?? null,
          brandSidebarHoverColor: dto.sidebarHoverColor ?? null,
          brandUpdatedAt: new Date(),
          ...(actorUserId !== null && { brandUpdatedById: actorUserId }),
        },
      });

      const changedFields = (Object.keys(dto) as (keyof UpdateTenantBrandingDto)[]).filter(
        (key) => {
          const column = brandColumn(key);
          const beforeValue = before?.[column] ?? null;
          const afterValue = dto[key];
          // dto[key] is undefined when the caller skipped this field;
          // we already filter those out via Object.keys(dto) — every
          // key listed was explicitly set (to a value or to null).
          return beforeValue !== afterValue;
        },
      );

      await this.audit.writeInTx(tx, tenantId, {
        action: 'tenant.branding.updated',
        entityType: 'tenant_settings',
        entityId: tenantId,
        actorUserId,
        payload: { changedFields } as Prisma.InputJsonValue,
      });

      return rowToBranding({
        tenantId,
        brandSystemName: updated.brandSystemName,
        brandWorkspaceName: updated.brandWorkspaceName,
        brandLogoUrl: updated.brandLogoUrl,
        brandFaviconUrl: updated.brandFaviconUrl,
        brandLoginImageUrl: updated.brandLoginImageUrl,
        brandPrimaryColor: updated.brandPrimaryColor,
        brandAccentColor: updated.brandAccentColor,
        brandSidebarBgColor: updated.brandSidebarBgColor,
        brandSidebarHoverColor: updated.brandSidebarHoverColor,
        brandUpdatedAt: updated.brandUpdatedAt,
        brandUpdatedById: updated.brandUpdatedById,
      });
    });
  }
}

function brandColumn(key: keyof UpdateTenantBrandingDto): keyof BrandColumns {
  // Translate DTO key (camelCase, no "brand" prefix) into the Prisma
  // column name (`brandXxx`). Kept as a switch so future field
  // additions trigger a TS error if the mapping is missed.
  switch (key) {
    case 'systemName':
      return 'brandSystemName';
    case 'workspaceName':
      return 'brandWorkspaceName';
    case 'logoUrl':
      return 'brandLogoUrl';
    case 'faviconUrl':
      return 'brandFaviconUrl';
    case 'loginImageUrl':
      return 'brandLoginImageUrl';
    case 'primaryColor':
      return 'brandPrimaryColor';
    case 'accentColor':
      return 'brandAccentColor';
    case 'sidebarBgColor':
      return 'brandSidebarBgColor';
    case 'sidebarHoverColor':
      return 'brandSidebarHoverColor';
  }
}

interface BrandColumns {
  brandSystemName: string | null;
  brandWorkspaceName: string | null;
  brandLogoUrl: string | null;
  brandFaviconUrl: string | null;
  brandLoginImageUrl: string | null;
  brandPrimaryColor: string | null;
  brandAccentColor: string | null;
  brandSidebarBgColor: string | null;
  brandSidebarHoverColor: string | null;
}

function rowToBranding(row: {
  tenantId: string;
  brandSystemName: string | null;
  brandWorkspaceName: string | null;
  brandLogoUrl: string | null;
  brandFaviconUrl: string | null;
  brandLoginImageUrl: string | null;
  brandPrimaryColor: string | null;
  brandAccentColor: string | null;
  brandSidebarBgColor: string | null;
  brandSidebarHoverColor: string | null;
  brandUpdatedAt: Date | null;
  brandUpdatedById: string | null;
}): TenantBranding {
  return {
    tenantId: row.tenantId,
    systemName: row.brandSystemName,
    workspaceName: row.brandWorkspaceName,
    logoUrl: row.brandLogoUrl,
    faviconUrl: row.brandFaviconUrl,
    loginImageUrl: row.brandLoginImageUrl,
    primaryColor: row.brandPrimaryColor,
    accentColor: row.brandAccentColor,
    sidebarBgColor: row.brandSidebarBgColor,
    sidebarHoverColor: row.brandSidebarHoverColor,
    updatedAt: row.brandUpdatedAt?.toISOString() ?? null,
    updatedById: row.brandUpdatedById,
  };
}

function emptyBranding(tenantId: string): TenantBranding {
  return {
    tenantId,
    systemName: null,
    workspaceName: null,
    logoUrl: null,
    faviconUrl: null,
    loginImageUrl: null,
    primaryColor: null,
    accentColor: null,
    sidebarBgColor: null,
    sidebarHoverColor: null,
    updatedAt: null,
    updatedById: null,
  };
}
