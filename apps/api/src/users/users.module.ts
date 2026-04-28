import { Global, Module } from '@nestjs/common';
import { UsersService } from './users.service';

/**
 * Global Users module. Exposes UsersService for any module that needs to
 * resolve a user, verify a password, or read role+capabilities. The
 * controllers (admin Users CRUD, /auth/me) land in C15/C9.
 */
@Global()
@Module({
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
