import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';

import { WhatsAppService } from './whatsapp.service';
import {
  HandoverConversationSchema,
  LinkConversationLeadSchema,
  ListConversationMessagesQuerySchema,
  ListConversationsQuerySchema,
  SendConversationMessageSchema,
} from './whatsapp.dto';

class ListConversationsQueryDto extends createZodDto(ListConversationsQuerySchema) {}
class ListConversationMessagesQueryDto extends createZodDto(ListConversationMessagesQuerySchema) {}
class SendConversationMessageDto extends createZodDto(SendConversationMessageSchema) {}
class LinkConversationLeadDto extends createZodDto(LinkConversationLeadSchema) {}
class HandoverConversationDto extends createZodDto(HandoverConversationSchema) {}

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
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class ConversationsController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  @Get()
  @RequireCapability('whatsapp.conversation.read')
  @ApiOperation({
    summary: 'List WhatsApp conversations in the active tenant (newest activity first)',
  })
  list(@Query() query: ListConversationsQueryDto, @CurrentUser() user: AccessTokenClaims) {
    return this.whatsapp.listConversations(user.tid, query);
  }

  @Get(':id')
  @RequireCapability('whatsapp.conversation.read')
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
  @RequireCapability('whatsapp.conversation.read')
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
   * C25 — attach a conversation to a lead in the same tenant. Idempotent:
   * relinking to a different lead overwrites the previous link (latest
   * wins). Cross-tenant ids surface as 404 because RLS hides them from
   * the lookup.
   */
  @Post(':id/link-lead')
  @RequireCapability('whatsapp.link.lead')
  @ApiOperation({ summary: 'Link a conversation to a lead (idempotent)' })
  link(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: LinkConversationLeadDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.whatsapp.linkConversationToLead(user.tid, id, body.leadId);
  }

  /**
   * C35 — handover the conversation (and the linked lead) to another
   * agent. Modes: full | clean | summary. The audit row lands on the
   * lead's activity timeline as `type=assignment`.
   *
   * Permission gating is intentionally deferred — the MVP is "any
   * authenticated user with tenant scope can hand over." A capability
   * guard (admin = anyone, tl_sales = own team, sales_agent = self)
   * lands when the wider RBAC policy framework arrives.
   */
  @Post(':id/handover')
  @RequireCapability('whatsapp.handover')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hand a conversation off to another agent' })
  handover(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: HandoverConversationDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.whatsapp.handoverConversation(user.tid, id, {
      newAssigneeId: body.newAssigneeId,
      mode: body.mode,
      summary: body.summary,
      notify: body.notify,
      actorUserId: user.sub,
    });
  }

  /**
   * Send a plain-text outbound message into the conversation. The
   * conversation row already carries `accountId` + `phone`, so the body
   * only needs the text. The service threads the new message into the
   * same conversation and bumps `lastMessageAt + lastMessageText`.
   */
  @Post(':id/messages')
  @RequireCapability('whatsapp.message.send')
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
