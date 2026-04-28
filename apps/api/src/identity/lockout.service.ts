import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Account lockout policy:
 *   - Each failed login increments `users.failed_login_count`.
 *   - When the counter hits MAX_ATTEMPTS, set `locked_until = now + LOCK_MINUTES`
 *     and reset the counter (so the next round of attempts after expiry
 *     starts fresh).
 *   - A successful login resets the counter and clears `locked_until`.
 *
 * The counter does NOT decay on a sliding window; it accumulates across
 * attempts until either a success or a lockout. This is the simplest
 * shape that satisfies the brute-force guard without auxiliary storage,
 * and is sufficient for Sprint 1.
 */
@Injectable()
export class LockoutService {
  static readonly MAX_ATTEMPTS = 5;
  static readonly LOCK_MINUTES = 15;

  constructor(private readonly prisma: PrismaService) {}

  /** True when the user is currently locked. */
  isLocked(user: { lockedUntil: Date | null }): boolean {
    return user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
  }

  /**
   * Record a failed attempt. Returns the updated counters so callers can
   * check whether the latest attempt tipped the user into a locked state.
   */
  async recordFailure(
    tenantId: string,
    userId: string,
  ): Promise<{ failedLoginCount: number; lockedUntil: Date | null }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const current = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { failedLoginCount: true, lockedUntil: true },
      });
      const next = current.failedLoginCount + 1;
      if (next >= LockoutService.MAX_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LockoutService.LOCK_MINUTES * 60 * 1000);
        const updated = await tx.user.update({
          where: { id: userId },
          data: { failedLoginCount: 0, lockedUntil },
          select: { failedLoginCount: true, lockedUntil: true },
        });
        return updated;
      }
      const updated = await tx.user.update({
        where: { id: userId },
        data: { failedLoginCount: next },
        select: { failedLoginCount: true, lockedUntil: true },
      });
      return updated;
    });
  }

  /** Successful login: clear counter + lock + bump last_login_at. */
  async recordSuccess(tenantId: string, userId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
        },
      }),
    );
  }
}
