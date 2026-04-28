import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HealthStatus {
  status: 'ok';
  db: 'ok' | 'fail' | 'n/a';
  redis: 'ok' | 'fail' | 'n/a';
  version: string;
}

@Injectable()
export class HealthService {
  private readonly version: string = HealthService.resolveVersion();

  /**
   * Returns the current operational status of the API.
   *
   * In C3 there is no Postgres or Redis client wired yet, so `db` and `redis`
   * are reported as `"n/a"`. They will move to live `"ok" | "fail"` checks in
   * C8 (Redis ping) and C12 (Postgres ping via Prisma).
   */
  status(): HealthStatus {
    return {
      status: 'ok',
      db: 'n/a',
      redis: 'n/a',
      version: this.version,
    };
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
