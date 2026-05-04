import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { ConversationsController } from './conversations.controller';
import { WhatsAppAccountsController } from './whatsapp-accounts.controller';
import { WhatsAppTemplatesController } from './whatsapp-templates.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppAccountsService } from './whatsapp-accounts.service';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { MetaCloudProvider } from './meta-cloud.provider';

/**
 * WhatsApp module (C21 + C22 + C24A + P2-12 + C10B-3).
 *
 * P2-12 added:
 *   - WhatsAppTemplatesService + Controller for the template CRUD.
 *   - sendTemplate / sendMedia paths on WhatsAppService.
 *   - Conversation 24h customer-service window enforcement on
 *     sendText / sendMedia.
 *
 * C10B-3 added:
 *   - WhatsAppInboundService — orchestrator that owns the inbound
 *     webhook flow (contact match-or-create → captain check →
 *     routing extension → auto-create-or-link lead → ownership
 *     denormalisation onto the conversation → audit + notification).
 */
@Module({
  controllers: [
    WhatsAppController,
    ConversationsController,
    WhatsAppAccountsController,
    WhatsAppTemplatesController,
  ],
  providers: [
    WhatsAppService,
    WhatsAppAccountsService,
    WhatsAppTemplatesService,
    WhatsAppInboundService,
    MetaCloudProvider,
  ],
  exports: [
    WhatsAppService,
    WhatsAppAccountsService,
    WhatsAppTemplatesService,
    WhatsAppInboundService,
  ],
})
export class WhatsAppModule {}
