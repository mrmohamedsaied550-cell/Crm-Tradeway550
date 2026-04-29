import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CurrentUser } from '../identity/current-user.decorator';
import type { AccessTokenClaims } from '../identity/jwt.types';

import { WhatsAppAccountsService } from './whatsapp-accounts.service';
import { CreateWhatsAppAccountSchema, UpdateWhatsAppAccountSchema } from './whatsapp.dto';

class CreateWhatsAppAccountDto extends createZodDto(CreateWhatsAppAccountSchema) {}
class UpdateWhatsAppAccountDto extends createZodDto(UpdateWhatsAppAccountSchema) {}

/**
 * /api/v1/whatsapp/accounts (C24A) — admin surface for managing WhatsApp
 * provider connections.
 *
 * All routes are tenant-scoped via the JWT `tid` claim. Responses NEVER
 * include the access token or app secret — the service masks both via
 * the SafeUser-style projection. The "test" endpoint hits the provider
 * with the stored credentials and returns a friendly status string.
 */
@ApiTags('whatsapp')
@Controller('whatsapp/accounts')
@UseGuards(JwtAuthGuard)
export class WhatsAppAccountsController {
  constructor(private readonly accounts: WhatsAppAccountsService) {}

  @Get()
  @ApiOperation({ summary: 'List WhatsApp accounts in the active tenant' })
  list(@CurrentUser() user: AccessTokenClaims) {
    return this.accounts.list(user.tid);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one WhatsApp account by id' })
  get(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.accounts.findByIdOrThrow(user.tid, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a WhatsApp account (provider config)' })
  create(@Body() body: CreateWhatsAppAccountDto, @CurrentUser() user: AccessTokenClaims) {
    return this.accounts.create(user.tid, body);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update fields on a WhatsApp account. Pass `accessToken` / `appSecret` only when rotating.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateWhatsAppAccountDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.accounts.update(user.tid, id, body);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable the account (status → active). Idempotent.' })
  enable(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.accounts.enable(user.tid, id);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable the account (status → inactive). Idempotent.' })
  disable(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.accounts.disable(user.tid, id);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Test the provider connection for this account. Returns { ok, message, displayPhoneNumber?, verifiedName? }.',
  })
  test(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.accounts.runTest(user.tid, id);
  }
}
