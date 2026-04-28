import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global PrismaModule — every other module can inject PrismaService without
 * needing to import this module explicitly.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
