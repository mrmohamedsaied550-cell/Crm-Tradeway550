import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import {
  PartnerCredentialsCryptoService,
  PartnerCredentialsKeyMissingError,
  PartnerCredentialsInvalidShapeError,
} from './partner-credentials-crypto.service';
import {
  type CreatePartnerSourceDto,
  type ListPartnerSourcesDto,
  type PartnerCredentials,
  type PartnerScheduleKind,
  type PartnerTabMode,
  type TabDiscoveryRule,
  type UpdatePartnerSourceDto,
} from './partner-source.dto';

/**
 * Phase D4 — D4.2: PartnerSource admin CRUD.
 *
 * Configuration only. No sync engine, no Google Sheets calls, no
 * snapshots. The service writes to `partner_sources` and never
 * returns raw credentials — DTO mapping in `toPublicDto` strips
 * `encryptedCredentials` before responding.
 *
 * Behaviour summary:
 *   • Create / Update mirror the same field set; cross-field
 *     invariants from the Zod schema (cron requires cronSpec,
 *     fixed requires fixedTabName, new_per_period requires
 *     tabDiscoveryRule) are re-checked here after merging with
 *     the persisted row so a partial PATCH can't violate them.
 *   • When `credentials` is provided, encrypt + persist + flip
 *     `hasCredentials = true`, set `connectionStatus = 'untested'`
 *     and `lastTestedAt = null`. Audit row
 *     `partner.source.credentials_rotated`.
 *   • When `credentials = null`, clear the envelope + flip
 *     `hasCredentials = false`. Audit row same as above.
 *   • When `credentials` is omitted, the envelope is untouched.
 *   • Soft-delete via `DELETE` — flips `isActive = false` and
 *     audits `partner.source.disabled`. Hard delete is
 *     intentionally not exposed: snapshots cascade via the FK
 *     and we don't want a single click to lose audit history.
 *   • `testConnection` is a stub — returns
 *     `{ status: 'stubbed', ... }` and DOES NOT update
 *     `lastTestedAt` / `connectionStatus`. Real probe lands in
 *     D4.3.
 *
 * Visibility:
 *   • RLS does the tenant fence. The service additionally narrows
 *     by `companyId` / `countryId` from the caller's scope when
 *     filters arrive. Cross-scope reads return 404 — defence in
 *     depth on top of the FORCE RLS policy.
 */
@Injectable()
export class PartnerSourcesService {
  private readonly logger = new Logger(PartnerSourcesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: PartnerCredentialsCryptoService,
  ) {}

  async list(
    filters: ListPartnerSourcesDto,
  ): Promise<{ items: PartnerSourceDto[]; total: number }> {
    const tenantId = requireTenantId();
    const where: Prisma.PartnerSourceWhereInput = {
      tenantId,
      ...(filters.companyId !== undefined && { companyId: filters.companyId }),
      ...(filters.countryId !== undefined && { countryId: filters.countryId }),
      ...(filters.partnerCode !== undefined && { partnerCode: filters.partnerCode }),
      ...(filters.isActive !== undefined && { isActive: filters.isActive }),
    };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.partnerSource.findMany({
          where,
          orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }],
          take: filters.limit,
          skip: filters.offset,
        }),
        tx.partnerSource.count({ where }),
      ]);
      return { items: items.map((row) => this.toPublicDto(row)), total };
    });
  }

  async findById(id: string): Promise<PartnerSourceDto> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerSource.findFirst({ where: { id, tenantId } }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'partner.source.not_found',
        message: `Partner source not found: ${id}`,
      });
    }
    return this.toPublicDto(row);
  }

  async create(dto: CreatePartnerSourceDto, actorUserId: string | null): Promise<PartnerSourceDto> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Encrypt up-front (outside Prisma create) so an invalid env
      // doesn't leave a half-written row.
      let encryptedCredentials: string | null = null;
      let hasCredentials = false;
      if (dto.credentials !== undefined && dto.credentials !== null) {
        encryptedCredentials = this.encryptOrThrow(dto.credentials);
        hasCredentials = true;
      }
      const row = await tx.partnerSource.create({
        data: {
          tenantId,
          partnerCode: dto.partnerCode,
          displayName: dto.displayName,
          adapter: dto.adapter,
          ...(dto.companyId !== undefined && { companyId: dto.companyId }),
          ...(dto.countryId !== undefined && { countryId: dto.countryId }),
          scheduleKind: dto.scheduleKind,
          ...(dto.cronSpec !== undefined && { cronSpec: dto.cronSpec }),
          tabMode: dto.tabMode,
          ...(dto.fixedTabName !== undefined && { fixedTabName: dto.fixedTabName }),
          ...(dto.tabDiscoveryRule !== undefined && {
            tabDiscoveryRule: dto.tabDiscoveryRule as unknown as Prisma.InputJsonValue,
          }),
          ...(encryptedCredentials !== null && { encryptedCredentials }),
          hasCredentials,
          // Always 'untested' on initial create; D4.3's real probe
          // will flip to 'ok' / 'auth_failed' / 'sheet_not_found'.
          connectionStatus: hasCredentials ? 'untested' : null,
          isActive: dto.isActive,
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'partner.source.created',
        entityType: 'partner_source',
        entityId: row.id,
        actorUserId,
        payload: {
          partnerCode: row.partnerCode,
          displayName: row.displayName,
          adapter: row.adapter,
          companyId: row.companyId,
          countryId: row.countryId,
          hasCredentials: row.hasCredentials,
        } as Prisma.InputJsonValue,
      });
      if (hasCredentials) {
        await this.audit.writeInTx(tx, tenantId, {
          action: 'partner.source.credentials_rotated',
          entityType: 'partner_source',
          entityId: row.id,
          actorUserId,
          payload: { hasCredentials: true } as Prisma.InputJsonValue,
        });
      }
      return this.toPublicDto(row);
    });
  }

  async update(
    id: string,
    dto: UpdatePartnerSourceDto,
    actorUserId: string | null,
  ): Promise<PartnerSourceDto> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.partnerSource.findFirst({ where: { id, tenantId } });
      if (!before) {
        throw new NotFoundException({
          code: 'partner.source.not_found',
          message: `Partner source not found: ${id}`,
        });
      }
      // Effective post-merge values for the cross-field check.
      const effective = {
        scheduleKind: (dto.scheduleKind ?? before.scheduleKind) as PartnerScheduleKind,
        cronSpec: dto.cronSpec === undefined ? before.cronSpec : dto.cronSpec,
        tabMode: (dto.tabMode ?? before.tabMode) as PartnerTabMode,
        fixedTabName: dto.fixedTabName === undefined ? before.fixedTabName : dto.fixedTabName,
        tabDiscoveryRule:
          dto.tabDiscoveryRule === undefined
            ? (before.tabDiscoveryRule as unknown as TabDiscoveryRule | null)
            : dto.tabDiscoveryRule,
      };
      this.assertScheduleAndTabInvariants(effective);

      // Credentials handling: undefined = leave alone, null = clear,
      // object = re-encrypt + rotate.
      let credentialsTouched = false;
      const credentialUpdate: Prisma.PartnerSourceUncheckedUpdateInput = {};
      if (dto.credentials !== undefined) {
        credentialsTouched = true;
        if (dto.credentials === null) {
          credentialUpdate.encryptedCredentials = null;
          credentialUpdate.hasCredentials = false;
          credentialUpdate.connectionStatus = null;
          credentialUpdate.lastTestedAt = null;
        } else {
          credentialUpdate.encryptedCredentials = this.encryptOrThrow(dto.credentials);
          credentialUpdate.hasCredentials = true;
          credentialUpdate.connectionStatus = 'untested';
          credentialUpdate.lastTestedAt = null;
        }
      }

      const updateData: Prisma.PartnerSourceUncheckedUpdateInput = {
        ...(dto.partnerCode !== undefined && { partnerCode: dto.partnerCode }),
        ...(dto.displayName !== undefined && { displayName: dto.displayName }),
        ...(dto.adapter !== undefined && { adapter: dto.adapter }),
        ...(dto.companyId !== undefined && { companyId: dto.companyId }),
        ...(dto.countryId !== undefined && { countryId: dto.countryId }),
        ...(dto.scheduleKind !== undefined && { scheduleKind: dto.scheduleKind }),
        ...(dto.cronSpec !== undefined && { cronSpec: dto.cronSpec }),
        ...(dto.tabMode !== undefined && { tabMode: dto.tabMode }),
        ...(dto.fixedTabName !== undefined && { fixedTabName: dto.fixedTabName }),
        ...(dto.tabDiscoveryRule !== undefined && {
          tabDiscoveryRule:
            dto.tabDiscoveryRule === null
              ? Prisma.JsonNull
              : (dto.tabDiscoveryRule as unknown as Prisma.InputJsonValue),
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...credentialUpdate,
      };
      const updated = await tx.partnerSource.update({
        where: { id },
        data: updateData,
      });

      const changedFields = (Object.keys(dto) as (keyof UpdatePartnerSourceDto)[]).filter((k) => {
        if (k === 'credentials') return credentialsTouched;
        return (
          JSON.stringify((before as unknown as Record<string, unknown>)[k]) !==
          JSON.stringify((updated as unknown as Record<string, unknown>)[k])
        );
      });

      await this.audit.writeInTx(tx, tenantId, {
        action: 'partner.source.updated',
        entityType: 'partner_source',
        entityId: updated.id,
        actorUserId,
        payload: {
          changedFields,
          hasCredentials: updated.hasCredentials,
        } as Prisma.InputJsonValue,
      });
      if (credentialsTouched) {
        await this.audit.writeInTx(tx, tenantId, {
          action: 'partner.source.credentials_rotated',
          entityType: 'partner_source',
          entityId: updated.id,
          actorUserId,
          payload: { hasCredentials: updated.hasCredentials } as Prisma.InputJsonValue,
        });
      }

      return this.toPublicDto(updated);
    });
  }

  async softDisable(id: string, actorUserId: string | null): Promise<PartnerSourceDto> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.partnerSource.findFirst({ where: { id, tenantId } });
      if (!before) {
        throw new NotFoundException({
          code: 'partner.source.not_found',
          message: `Partner source not found: ${id}`,
        });
      }
      if (!before.isActive) {
        // Idempotent: already disabled; no audit row, no error.
        return this.toPublicDto(before);
      }
      const updated = await tx.partnerSource.update({
        where: { id },
        data: { isActive: false },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'partner.source.disabled',
        entityType: 'partner_source',
        entityId: updated.id,
        actorUserId,
        payload: { partnerCode: updated.partnerCode } as Prisma.InputJsonValue,
      });
      return this.toPublicDto(updated);
    });
  }

  /**
   * D4.2 stub. Validates the persisted config shape without
   * touching the partner. D4.3 replaces the body with a real
   * adapter probe that flips `lastTestedAt` and `connectionStatus`.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async testConnectionStub(id: string, _actorUserId: string | null): Promise<TestConnectionResult> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerSource.findFirst({ where: { id, tenantId } }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'partner.source.not_found',
        message: `Partner source not found: ${id}`,
      });
    }
    const issues: string[] = [];
    if (row.scheduleKind === 'cron' && !row.cronSpec) {
      issues.push('cronSpec is required when scheduleKind is "cron".');
    }
    if (row.tabMode === 'fixed' && !row.fixedTabName) {
      issues.push('fixedTabName is required when tabMode is "fixed".');
    }
    if (row.tabMode === 'new_per_period' && !row.tabDiscoveryRule) {
      issues.push('tabDiscoveryRule is required when tabMode is "new_per_period".');
    }
    if (row.adapter === 'google_sheets' && !row.hasCredentials) {
      issues.push('Google Sheets adapter requires credentials.');
    }
    return {
      status: 'stubbed',
      message:
        'Connection test will be available when sync is enabled in D4.3. Configuration shape validated only.',
      configIssues: issues,
    };
  }

  // ─── helpers ──────────────────────────────────────────────────────

  private encryptOrThrow(payload: PartnerCredentials): string {
    try {
      return this.crypto.encrypt(payload);
    } catch (err) {
      if (err instanceof PartnerCredentialsKeyMissingError) {
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      if (err instanceof PartnerCredentialsInvalidShapeError) {
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      this.logger.error(`partner credentials encrypt failed: ${(err as Error).name}`);
      throw new BadRequestException({
        code: 'partner.source.invalid_credentials_shape',
        message: 'Failed to encrypt credentials.',
      });
    }
  }

  private assertScheduleAndTabInvariants(eff: {
    scheduleKind: PartnerScheduleKind;
    cronSpec: string | null;
    tabMode: PartnerTabMode;
    fixedTabName: string | null;
    tabDiscoveryRule: TabDiscoveryRule | null;
  }): void {
    if (eff.scheduleKind === 'cron' && (!eff.cronSpec || eff.cronSpec.trim().length === 0)) {
      throw new BadRequestException({
        code: 'partner.source.cron_spec_required',
        message: 'cronSpec is required when scheduleKind is "cron".',
      });
    }
    if (eff.tabMode === 'fixed' && (!eff.fixedTabName || eff.fixedTabName.trim().length === 0)) {
      throw new BadRequestException({
        code: 'partner.source.fixed_tab_name_required',
        message: 'fixedTabName is required when tabMode is "fixed".',
      });
    }
    if (eff.tabMode === 'new_per_period' && !eff.tabDiscoveryRule) {
      throw new BadRequestException({
        code: 'partner.source.tab_discovery_rule_required',
        message: 'tabDiscoveryRule is required when tabMode is "new_per_period".',
      });
    }
  }

  /**
   * Public DTO mapper. STRIPS `encryptedCredentials`. Surfaces only
   * the safe metadata downstream (`hasCredentials`,
   * `lastTestedAt`, `connectionStatus`, `credentialUpdatedAt`).
   */
  private toPublicDto(
    row: Prisma.PartnerSourceGetPayload<Record<string, never>>,
  ): PartnerSourceDto {
    return {
      id: row.id,
      partnerCode: row.partnerCode,
      displayName: row.displayName,
      adapter: row.adapter,
      companyId: row.companyId,
      countryId: row.countryId,
      scheduleKind: row.scheduleKind,
      cronSpec: row.cronSpec,
      tabMode: row.tabMode,
      fixedTabName: row.fixedTabName,
      tabDiscoveryRule: row.tabDiscoveryRule as unknown as TabDiscoveryRule | null,
      hasCredentials: row.hasCredentials,
      lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
      connectionStatus: row.connectionStatus,
      lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
      lastSyncStatus: row.lastSyncStatus,
      credentialUpdatedAt: row.updatedAt.toISOString(),
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export interface PartnerSourceDto {
  id: string;
  partnerCode: string;
  displayName: string;
  adapter: string;
  companyId: string | null;
  countryId: string | null;
  scheduleKind: string;
  cronSpec: string | null;
  tabMode: string;
  fixedTabName: string | null;
  tabDiscoveryRule: TabDiscoveryRule | null;
  hasCredentials: boolean;
  lastTestedAt: string | null;
  connectionStatus: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  /** Approximate "credentials last updated" surface — uses the
   *  source's `updatedAt` since rotation always touches the row. */
  credentialUpdatedAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TestConnectionResult {
  status: 'stubbed';
  message: string;
  configIssues: string[];
}
