import { Module } from '@nestjs/common';

import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

/**
 * Phase C — C10B-4: Contact module.
 *
 * Surfaces a tiny CRUD around the Contact identity model added in
 * C10B-1. Visibility piggy-backs on conversation scope (no new
 * RoleScope resource — locked decision §4).
 */
@Module({
  controllers: [ContactsController],
  providers: [ContactsService],
  exports: [ContactsService],
})
export class ContactModule {}
