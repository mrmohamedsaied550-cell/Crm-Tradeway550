import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { decryptSecret, encryptSecret } from '../common/crypto';
import { isProduction } from '../common/env';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import type { CreateWhatsAppAccountDto, UpdateWhatsAppAccountDto } from './whatsapp.dto';
import type { ConnectionTestResult } from './whatsapp.provider';

/**
 * Public projection of a WhatsAppAccount row — the shape returned by
 * every admin endpoint. Sensitive columns (`accessToken`, `appSecret`)
 * are NEVER included.
 *
 * `hasAppSecret` is the only signal the UI needs about the secret: a
 * boolean lets the admin check whether HMAC verification is enabled
 * without ever transmitting the value back to the browser.
 */
export interface WhatsAppAccountView {
  id: string;
  tenantId: string;
  displayName: string;
  phoneNumber: string;
  phoneNumberId: string;
  provider: string;
  /** Webhook GET-handshake token. Not strictly secret on its own (it's
   *  paired with the appSecret HMAC for real protection), and the admin
   *  needs to copy it into the Meta App configuration. */
  verifyToken: string;
  hasAppSecret: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Prisma `select` mask used everywhere — drives the no-secret guarantee. */
const ACCOUNT_PUBLIC_SELECT = {
  id: true,
  tenantId: true,
  displayName: true,
  phoneNumber: true,
  phoneNumberId: true,
  provider: true,
  verifyToken: true,
  appSecret: true, // pulled but mapped to a boolean before leaving the service
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

type RawAccountRow = {
  id: string;
  tenantId: string;
  displayName: string;
  phoneNumber: string;
  phoneNumberId: string;
  provider: string;
  verifyToken: string;
  appSecret: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toView(row: RawAccountRow): WhatsAppAccountView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    displayName: row.displayName,
    phoneNumber: row.phoneNumber,
    phoneNumberId: row.phoneNumberId,
    provider: row.provider,
    verifyToken: row.verifyToken,
    hasAppSecret: row.appSecret !== null && row.appSecret.length > 0,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * WhatsAppAccountsService — admin-level CRUD on per-tenant provider
 * configurations.
 *
 * Security guarantees enforced here:
 *   - Every read goes through `ACCOUNT_PUBLIC_SELECT` and is run through
 *     `toView()` before leaving the service, so the access token is
 *     never returned by any code path. The app secret is reduced to a
 *     `hasAppSecret` boolean.
 *   - The token + secret are pulled from the DB only inside `runTest()`,
 *     where they're handed straight to the provider and discarded. They
 *     never touch the controller layer.
 *   - Errors thrown from the service carry stable `code` strings
 *     (`whatsapp.duplicate_phone`, `whatsapp.duplicate_phone_number_id`,
 *     `whatsapp.duplicate_verify_token`) so the UI can branch without
 *     parsing English prose.
 *   - All operations are tenant-scoped via `prisma.withTenant(...)` —
 *     the FORCE'd RLS policy on `whatsapp_accounts` is the canonical
 *     guard against cross-tenant reads.
 */
@Injectable()
export class WhatsAppAccountsService {
  private readonly logger = new Logger(WhatsAppAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
  ) {}

  // ───────── reads ─────────

  async list(tenantId: string): Promise<WhatsAppAccountView[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppAccount.findMany({
        select: ACCOUNT_PUBLIC_SELECT,
        orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }],
      }),
    );
    return rows.map(toView);
  }

  async findById(tenantId: string, id: string): Promise<WhatsAppAccountView | null> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppAccount.findUnique({
        where: { id },
        select: ACCOUNT_PUBLIC_SELECT,
      }),
    );
    return row ? toView(row) : null;
  }

  async findByIdOrThrow(tenantId: string, id: string): Promise<WhatsAppAccountView> {
    const row = await this.findById(tenantId, id);
    if (!row) {
      throw new NotFoundException({
        code: 'whatsapp.account_not_found',
        message: `WhatsApp account ${id} not found in active tenant`,
      });
    }
    return row;
  }

  // ───────── writes ─────────

  async create(tenantId: string, dto: CreateWhatsAppAccountDto): Promise<WhatsAppAccountView> {
    await this.assertUnique(tenantId, {
      phoneNumber: dto.phoneNumber,
      phoneNumberId: dto.phoneNumberId,
    });
    try {
      const row = await this.prisma.withTenant(tenantId, (tx) =>
        tx.whatsAppAccount.create({
          data: {
            tenantId,
            displayName: dto.displayName,
            phoneNumber: dto.phoneNumber,
            phoneNumberId: dto.phoneNumberId,
            provider: dto.provider,
            // P2-05 — `access_token` is encrypted at rest. `app_secret`
            // intentionally stays plaintext: it has to be readable
            // cross-tenant by the public webhook (via the
            // `whatsapp_routes` mirror) without a key handshake. The
            // RLS policy on `whatsapp_accounts` already prevents
            // exfiltration through the admin path.
            accessToken: encryptSecret(dto.accessToken),
            appSecret: dto.appSecret ?? null,
            verifyToken: dto.verifyToken,
            isActive: dto.isActive ?? true,
          },
          select: ACCOUNT_PUBLIC_SELECT,
        }),
      );
      return toView(row);
    } catch (err) {
      throw mapUniqueViolation(err);
    }
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateWhatsAppAccountDto,
  ): Promise<WhatsAppAccountView> {
    await this.findByIdOrThrow(tenantId, id); // 404 cross-tenant
    await this.assertUnique(
      tenantId,
      {
        phoneNumber: dto.phoneNumber,
        phoneNumberId: dto.phoneNumberId,
      },
      id,
    );
    try {
      const row = await this.prisma.withTenant(tenantId, (tx) =>
        tx.whatsAppAccount.update({
          where: { id },
          data: {
            ...(dto.displayName !== undefined && { displayName: dto.displayName }),
            ...(dto.phoneNumber !== undefined && { phoneNumber: dto.phoneNumber }),
            ...(dto.phoneNumberId !== undefined && { phoneNumberId: dto.phoneNumberId }),
            // P2-05 — encrypt the rotated token before persisting.
            ...(dto.accessToken !== undefined && {
              accessToken: encryptSecret(dto.accessToken),
            }),
            // appSecret: undefined → unchanged; null → clear; string → rotate
            ...(dto.appSecret !== undefined && { appSecret: dto.appSecret }),
            ...(dto.verifyToken !== undefined && { verifyToken: dto.verifyToken }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          },
          select: ACCOUNT_PUBLIC_SELECT,
        }),
      );
      return toView(row);
    } catch (err) {
      throw mapUniqueViolation(err);
    }
  }

  enable(tenantId: string, id: string): Promise<WhatsAppAccountView> {
    return this.setActive(tenantId, id, true);
  }
  disable(tenantId: string, id: string): Promise<WhatsAppAccountView> {
    return this.setActive(tenantId, id, false);
  }

  private async setActive(
    tenantId: string,
    id: string,
    isActive: boolean,
  ): Promise<WhatsAppAccountView> {
    const current = await this.findByIdOrThrow(tenantId, id);
    // C27 — refuse to enable an account in production without an
    // appSecret. The webhook controller would reject every inbound
    // payload anyway (signature can't be verified), so this is a
    // friendlier failure mode than silently routing nothing.
    if (isActive && !current.hasAppSecret && isProduction()) {
      throw new BadRequestException({
        code: 'whatsapp.app_secret_required_in_production',
        message:
          'WhatsApp account cannot be enabled in production without an appSecret — set it via PATCH first',
      });
    }
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppAccount.update({
        where: { id },
        data: { isActive },
        select: ACCOUNT_PUBLIC_SELECT,
      }),
    );
    return toView(row);
  }

  /**
   * Pre-check uniqueness so we can surface typed conflict codes. Prisma
   * 5.22 returns `meta.target = null` on P2002 from compound unique
   * indexes, so the post-mortem `mapUniqueViolation` heuristic can't tell
   * which constraint hit. We probe the DB up-front and emit the right
   * code; `mapUniqueViolation` stays in place as a belt-and-braces guard
   * for race conditions between the probe and the insert.
   */
  private async assertUnique(
    tenantId: string,
    fields: { phoneNumber?: string; phoneNumberId?: string },
    excludeId?: string,
  ): Promise<void> {
    if (fields.phoneNumberId) {
      // phone_number_id is GLOBALLY unique → bypass RLS via raw SQL with
      // the GUC reset, otherwise we'd only see our own tenant's row.
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM whatsapp_accounts
        WHERE phone_number_id = ${fields.phoneNumberId}
        ${excludeId ? Prisma.sql`AND id <> ${excludeId}::uuid` : Prisma.empty}
        LIMIT 1
      `;
      if (rows.length > 0) {
        throw new ConflictException({
          code: 'whatsapp.duplicate_phone_number_id',
          message: 'A WhatsApp account with this phone-number-id already exists',
        });
      }
    }
    if (fields.phoneNumber) {
      const existing = await this.prisma.withTenant(tenantId, (tx) =>
        tx.whatsAppAccount.findFirst({
          where: {
            phoneNumber: fields.phoneNumber,
            ...(excludeId ? { NOT: { id: excludeId } } : {}),
          },
          select: { id: true },
        }),
      );
      if (existing) {
        throw new ConflictException({
          code: 'whatsapp.duplicate_phone',
          message: 'A WhatsApp account with this phone number already exists in this tenant',
        });
      }
    }
  }

  /**
   * Run a provider-side liveness check. Reads the access token + app
   * secret inside the service, hands them to the provider, returns only
   * the public test result. Never logs the secrets.
   *
   * Transaction discipline (C28): the credential read is its own short
   * `withTenant` transaction; `provider.testConnection` runs OUTSIDE
   * any DB transaction so the Meta round-trip never holds a Postgres
   * connection. See `WhatsAppService.sendText` for the same pattern.
   */
  async runTest(tenantId: string, id: string): Promise<ConnectionTestResult> {
    // Pull the sensitive columns ONLY inside this method.
    const account = await this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppAccount.findUnique({
        where: { id },
        select: {
          provider: true,
          phoneNumberId: true,
          accessToken: true,
          appSecret: true,
          verifyToken: true,
        },
      }),
    );
    if (!account) {
      throw new NotFoundException({
        code: 'whatsapp.account_not_found',
        message: `WhatsApp account ${id} not found in active tenant`,
      });
    }

    const provider = this.whatsapp.providerFor(account.provider);
    try {
      return await provider.testConnection({
        config: {
          // P2-05 — decrypt at the point of use; the plaintext lives
          // in this stack frame just long enough to be handed to the
          // provider. Decryption is a no-op for legacy plaintext rows
          // so a deploy that hasn't yet run the bulk re-encrypt
          // script keeps working.
          accessToken: decryptSecret(account.accessToken),
          phoneNumberId: account.phoneNumberId,
          appSecret: account.appSecret,
          verifyToken: account.verifyToken,
        },
      });
    } catch (err) {
      // Provider's testConnection should report errors via ok:false; if
      // it threw anyway, surface the failure without echoing the
      // (potentially token-bearing) error message.
      this.logger.warn(`runTest: provider threw ${(err as Error).name}`);
      return { ok: false, message: 'Connection test failed' };
    }
  }
}

function mapUniqueViolation(err: unknown): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = (err.meta && (err.meta['target'] as string[] | string)) ?? '';
    const targetStr = Array.isArray(target) ? target.join(',') : String(target);
    // Compound `(tenant_id, phone_number)` reported as field array → join
    // contains "phone_number" but NOT the standalone "phone_number_id"
    // column. Check the per-tenant phone constraint FIRST so a substring
    // accident on "phone_number" inside "phone_number_id" can't fire.
    const fields = Array.isArray(target) ? target : targetStr.split(',');
    const hasPhoneNumber = fields.includes('phone_number');
    const hasPhoneNumberId = fields.includes('phone_number_id') || targetStr === 'phone_number_id';
    if (hasPhoneNumber) {
      return new ConflictException({
        code: 'whatsapp.duplicate_phone',
        message: 'A WhatsApp account with this phone number already exists in this tenant',
      });
    }
    if (hasPhoneNumberId) {
      return new ConflictException({
        code: 'whatsapp.duplicate_phone_number_id',
        message: 'A WhatsApp account with this phone-number-id already exists',
      });
    }
    return new ConflictException({
      code: 'whatsapp.duplicate',
      message: 'A WhatsApp account with these credentials already exists',
    });
  }
  return err;
}
