import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenantsModule } from './tenants/tenants.module';
import { TenantContextMiddleware } from './tenants/tenant-context.middleware';
import { RbacModule } from './rbac/rbac.module';
import { UsersModule } from './users/users.module';
import { IdentityModule } from './identity/identity.module';
import { CrmModule } from './crm/crm.module';
import { OrgModule } from './org/org.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { buildLoggerConfig } from './common/logger';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    LoggerModule.forRootAsync({
      useFactory: () => buildLoggerConfig(process.env),
    }),
    // Default throttler: 60 requests per minute per IP. Auth endpoints opt
    // into tighter per-route limits via @Throttle().
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    PrismaModule,
    // IdentityModule must be imported before TenantsModule because the
    // tenant-context middleware injects TokensService (provided by Identity).
    IdentityModule,
    TenantsModule,
    RbacModule,
    UsersModule,
    CrmModule,
    OrgModule,
    HealthModule,
  ],
  providers: [
    // Apply ThrottlerGuard globally; @Throttle decorators on routes refine it.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Order matters:
    //   1. RequestIdMiddleware     — request id is on every log line.
    //   2. TenantContextMiddleware — resolves JWT claim or X-Tenant header
    //      into AsyncLocalStorage; downstream code uses it.
    consumer.apply(RequestIdMiddleware, TenantContextMiddleware).forRoutes('*');
  }
}
