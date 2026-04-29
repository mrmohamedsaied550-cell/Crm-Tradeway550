import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { ConversationsController } from './conversations.controller';
import { WhatsAppAccountsController } from './whatsapp-accounts.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppAccountsService } from './whatsapp-accounts.service';
import { MetaCloudProvider } from './meta-cloud.provider';

/**
 * WhatsApp module (C21 + C22 + C24A).
 *
 * Self-contained: no link to Lead / Captain. C24A added the admin
 * accounts surface (CRUD + enable/disable + test connection) alongside
 * the C21 webhook + C22 conversations.
 */
@Module({
  controllers: [WhatsAppController, ConversationsController, WhatsAppAccountsController],
  providers: [WhatsAppService, WhatsAppAccountsService, MetaCloudProvider],
  exports: [WhatsAppService, WhatsAppAccountsService],
})
export class WhatsAppModule {}
