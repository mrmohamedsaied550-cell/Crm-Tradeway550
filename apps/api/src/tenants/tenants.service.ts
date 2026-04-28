import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Lookups against the cross-tenant `tenants` registry.
 *
 * No tenant-scope filter is applied — `tenants` itself is read before tenant
 * context is established (see migration 0001_foundations comments).
 */
@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  findByCode(code: string) {
    return this.prisma.tenant.findUnique({ where: { code } });
  }

  findById(id: string) {
    return this.prisma.tenant.findUnique({ where: { id } });
  }
}
