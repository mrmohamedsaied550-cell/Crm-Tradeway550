import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { ConversationsController } from './conversations.controller';
import { WhatsAppService } from './whatsapp.service';
import { MetaCloudProvider } from './meta-cloud.provider';

/**
 * WhatsApp module (C21 + C22).
 *
 * Self-contained: no link to Lead / Captain in this chunk. The C22
 * additions (conversation threading + admin reads) sit alongside the
 * C21 webhook surface.
 */
@Module({
  controllers: [WhatsAppController, ConversationsController],
  providers: [WhatsAppService, MetaCloudProvider],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
