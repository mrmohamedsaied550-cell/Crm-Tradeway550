import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { ConversationsController } from './conversations.controller';
import { WhatsAppAccountsController } from './whatsapp-accounts.controller';
import { WhatsAppTemplatesController } from './whatsapp-templates.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppAccountsService } from './whatsapp-accounts.service';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';
import { MetaCloudProvider } from './meta-cloud.provider';

/**
 * WhatsApp module (C21 + C22 + C24A + P2-12).
 *
 * P2-12 added:
 *   - WhatsAppTemplatesService + Controller for the template CRUD.
 *   - sendTemplate / sendMedia paths on WhatsAppService.
 *   - Conversation 24h customer-service window enforcement on
 *     sendText / sendMedia.
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
    MetaCloudProvider,
  ],
  exports: [WhatsAppService, WhatsAppAccountsService, WhatsAppTemplatesService],
})
export class WhatsAppModule {}
