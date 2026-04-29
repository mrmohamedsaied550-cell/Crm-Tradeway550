import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CurrentUser } from '../identity/current-user.decorator';
import type { AccessTokenClaims } from '../identity/jwt.types';

import { WhatsAppService } from './whatsapp.service';
import { ListConversationMessagesQuerySchema, ListConversationsQuerySchema } from './whatsapp.dto';

class ListConversationsQueryDto extends createZodDto(ListConversationsQuerySchema) {}
class ListConversationMessagesQueryDto extends createZodDto(ListConversationMessagesQuerySchema) {}

/**
 * /api/v1/conversations — read-only WhatsApp conversation admin surface.
 *
 * All routes go through JwtAuthGuard; the JWT carries the `tid` claim
 * which the tenant-context middleware feeds into `prisma.withTenant(...)`
 * inside the service. Cross-tenant ids surface as 404 because RLS hides
 * them from the read.
 */
@ApiTags('whatsapp')
@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  @Get()
  @ApiOperation({
    summary: 'List WhatsApp conversations in the active tenant (newest activity first)',
  })
  list(@Query() query: ListConversationsQueryDto, @CurrentUser() user: AccessTokenClaims) {
    return this.whatsapp.listConversations(user.tid, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a conversation by id' })
  async getOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const row = await this.whatsapp.findConversationById(user.tid, id);
    if (!row) {
      throw new NotFoundException({
        code: 'whatsapp.conversation_not_found',
        message: `Conversation ${id} not found in active tenant`,
      });
    }
    return row;
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'List messages in a conversation, oldest first' })
  async messages(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListConversationMessagesQueryDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const rows = await this.whatsapp.listConversationMessages(user.tid, id, {
      limit: query.limit,
    });
    if (rows === null) {
      throw new NotFoundException({
        code: 'whatsapp.conversation_not_found',
        message: `Conversation ${id} not found in active tenant`,
      });
    }
    return rows;
  }
}
