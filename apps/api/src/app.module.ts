import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenantsModule } from './tenants/tenants.module';
import { TenantContextMiddleware } from './tenants/tenant-context.middleware';
import { RbacModule } from './rbac/rbac.module';
import { UsersModule } from './users/users.module';
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
    PrismaModule,
    TenantsModule,
    RbacModule,
    UsersModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Order matters:
    //   1. RequestIdMiddleware  — request id is on every log line.
    //   2. TenantContextMiddleware — resolves X-Tenant header (dev) or JWT
    //      claim (from C9) into AsyncLocalStorage; downstream code uses it.
    consumer.apply(RequestIdMiddleware, TenantContextMiddleware).forRoutes('*');
  }
}
