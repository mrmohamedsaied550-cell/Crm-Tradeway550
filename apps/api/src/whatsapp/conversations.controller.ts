import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CurrentUser } from '../identity/current-user.decorator';
import type { AccessTokenClaims } from '../identity/jwt.types';

import { WhatsAppService } from './whatsapp.service';
import {
  ListConversationMessagesQuerySchema,
  ListConversationsQuerySchema,
  SendConversationMessageSchema,
} from './whatsapp.dto';

class ListConversationsQueryDto extends createZodDto(ListConversationsQuerySchema) {}
class ListConversationMessagesQueryDto extends createZodDto(ListConversationMessagesQuerySchema) {}
class SendConversationMessageDto extends createZodDto(SendConversationMessageSchema) {}

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

  /**
   * Send a plain-text outbound message into the conversation. The
   * conversation row already carries `accountId` + `phone`, so the body
   * only needs the text. The service threads the new message into the
   * same conversation and bumps `lastMessageAt + lastMessageText`.
   */
  @Post(':id/messages')
  @ApiOperation({ summary: 'Send a text message in this conversation' })
  async send(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendConversationMessageDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const conversation = await this.whatsapp.findConversationById(user.tid, id);
    if (!conversation) {
      throw new NotFoundException({
        code: 'whatsapp.conversation_not_found',
        message: `Conversation ${id} not found in active tenant`,
      });
    }
    const result = await this.whatsapp.sendText({
      tenantId: user.tid,
      accountId: conversation.accountId,
      to: conversation.phone,
      text: body.text,
    });
    return {
      messageId: result.messageId,
      providerMessageId: result.providerMessageId,
      conversationId: result.conversationId,
    };
  }
}
