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

import { SendMediaMessageSchema, SendTemplateMessageSchema } from './whatsapp-templates.dto';
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
class SendTemplateMessageDto extends createZodDto(SendTemplateMessageSchema) {}
class SendMediaMessageDto extends createZodDto(SendMediaMessageSchema) {}
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

  /**
   * P2-12 — send a Meta-approved template by name + language. The
   * one outbound path that's allowed OUTSIDE the 24-hour
   * customer-service window; agents use this to (re-)open a
   * conversation. Variables are substituted by position into the
   * template's `{{1}}` / `{{2}}` placeholders.
   */
  @Post(':id/messages/template')
  @RequireCapability('whatsapp.message.send')
  @ApiOperation({ summary: 'Send a Meta-approved template message' })
  async sendTemplate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendTemplateMessageDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const conversation = await this.whatsapp.findConversationById(user.tid, id);
    if (!conversation) {
      throw new NotFoundException({
        code: 'whatsapp.conversation_not_found',
        message: `Conversation ${id} not found in active tenant`,
      });
    }
    const result = await this.whatsapp.sendTemplate({
      tenantId: user.tid,
      accountId: conversation.accountId,
      to: conversation.phone,
      templateName: body.templateName,
      language: body.language,
      variables: body.variables,
    });
    return {
      messageId: result.messageId,
      providerMessageId: result.providerMessageId,
      conversationId: result.conversationId,
    };
  }

  /**
   * P2-12 — send an image / document by URL. The operator hosts
   * the file (S3, signed-URL, etc); the CRM stores the URL +
   * optional caption as the message body. Gated by the 24-hour
   * customer-service window like sendText — operators must use
   * a template to re-open a thread before sending media.
   */
  @Post(':id/messages/media')
  @RequireCapability('whatsapp.media.send')
  @ApiOperation({ summary: 'Send an image / document message' })
  async sendMedia(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendMediaMessageDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const conversation = await this.whatsapp.findConversationById(user.tid, id);
    if (!conversation) {
      throw new NotFoundException({
        code: 'whatsapp.conversation_not_found',
        message: `Conversation ${id} not found in active tenant`,
      });
    }
    const result = await this.whatsapp.sendMedia({
      tenantId: user.tid,
      accountId: conversation.accountId,
      to: conversation.phone,
      kind: body.kind,
      mediaUrl: body.mediaUrl,
      mediaMimeType: body.mediaMimeType ?? null,
      ...(body.caption !== undefined && { caption: body.caption }),
    });
    return {
      messageId: result.messageId,
      providerMessageId: result.providerMessageId,
      conversationId: result.conversationId,
    };
  }
}
