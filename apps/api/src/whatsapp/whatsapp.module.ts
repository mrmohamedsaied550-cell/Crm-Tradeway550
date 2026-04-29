import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { MetaCloudProvider } from './meta-cloud.provider';

/**
 * WhatsApp foundation module (C21).
 *
 * Self-contained: no link to Lead / Captain in this chunk. Wiring the
 * webhook into the CRM funnel (auto-creating leads, threading messages
 * to a lead's activity timeline, the inbox UI) lands in a later chunk.
 */
@Module({
  controllers: [WhatsAppController],
  providers: [WhatsAppService, MetaCloudProvider],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
