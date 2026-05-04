import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

import { ContactsService } from './contacts.service';

/**
 * Cleaned-data update DTO — the only fields a normal agent can edit.
 * The schema is `.passthrough()` so accidental raw-field submissions
 * don't 400 the request — instead, the service silently strips them
 * and emits `field_write_denied` audit (locked safety decision).
 */
const UpdateContactSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    language: z.string().trim().max(16).nullable().optional(),
  })
  .passthrough();
class UpdateContactDto extends createZodDto(UpdateContactSchema) {}

/**
 * Super-admin raw-override DTO — accepts every field including the
 * provider snapshot. The capability guard at the route layer is the
 * sole gate.
 */
const UpdateContactRawSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    language: z.string().trim().max(16).nullable().optional(),
    phone: z.string().trim().min(4).max(32).optional(),
    originalPhone: z.string().trim().min(4).max(32).optional(),
    originalDisplayName: z.string().trim().min(1).max(120).nullable().optional(),
    rawProfile: z.unknown().optional(),
  })
  .strict();
class UpdateContactRawDto extends createZodDto(UpdateContactRawSchema) {}

function claimsToScope(claims: AccessTokenClaims): ScopeUserClaims {
  return { userId: claims.sub, tenantId: claims.tid, roleId: claims.rid };
}

/**
 * /api/v1/contacts — Phase C — C10B-4 surface for the new Contact
 * model.
 *
 * Visibility piggy-backs on conversation scope: a contact is visible
 * iff at least one of its conversations is in scope. Read returns
 * a "safe" projection (no provider snapshot); raw fields are reachable
 * only via the dedicated PATCH /:id/raw endpoint gated on
 * `whatsapp.contact.write.raw` (super-admin only).
 */
@ApiTags('whatsapp')
@Controller('contacts')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get(':id')
  @RequireCapability('whatsapp.contact.read')
  @ApiOperation({
    summary: 'Get a contact (cleaned identity; raw provider snapshot is omitted)',
  })
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const row = await this.contacts.findByIdInScope(claimsToScope(user), id);
    if (!row) {
      throw new NotFoundException({
        code: 'whatsapp.contact.not_found',
        message: `Contact ${id} not found in active tenant`,
      });
    }
    return row;
  }

  @Patch(':id')
  @RequireCapability('whatsapp.contact.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Update Contact cleaned fields (displayName, language). Raw fields submitted are silent-stripped + audited.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateContactDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.contacts.update(claimsToScope(user), id, body);
  }

  @Patch(':id/raw')
  @RequireCapability('whatsapp.contact.write.raw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Override the immutable Contact provider snapshot (originalPhone, originalDisplayName, rawProfile, phone). Super-admin only.',
  })
  updateRaw(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateContactRawDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    // zod's `z.unknown()` carries `unknown` through the inferred type;
    // Prisma's InputJsonValue is more restrictive. Build the call
    // payload field-by-field so the cast is local to the rawProfile.
    const { rawProfile: _raw, ...rest } = body;
    return this.contacts.updateRaw(claimsToScope(user), id, {
      ...rest,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(_raw !== undefined && { rawProfile: _raw as any }),
    });
  }
}
