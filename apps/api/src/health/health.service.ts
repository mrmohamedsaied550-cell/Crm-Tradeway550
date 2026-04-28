import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

export interface HealthStatus {
  status: 'ok';
  db: 'ok' | 'fail' | 'n/a';
  redis: 'ok' | 'fail' | 'n/a';
  version: string;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly version: string = HealthService.resolveVersion();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the current operational status of the API.
   *
   * C6 introduces a soft DB ping via Prisma. Failure is non-fatal — the
   * endpoint always returns 200 so platform health probes don't flap when
   * Postgres is briefly unavailable. Redis stays "n/a" until C8.
   */
  async status(): Promise<HealthStatus> {
    return {
      status: 'ok',
      db: await this.pingDatabase(),
      redis: 'n/a',
      version: this.version,
    };
  }

  private async pingDatabase(): Promise<'ok' | 'fail'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch (err) {
      this.logger.warn(`db ping failed: ${(err as Error).message}`);
      return 'fail';
    }
  }

  private static resolveVersion(): string {
    // Read the version from this app's package.json at boot. Avoid `require`
    // so it works under both CommonJS and bundled outputs.
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  }
}
