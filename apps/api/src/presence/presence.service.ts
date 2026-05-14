import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Sprint 10 (D10) — derived presence labels.
 *
 *   online  — lastSeenAt within ONLINE_THRESHOLD_MS (default 2 min)
 *             OR busyUntil > now() (busy overrides nothing-detected
 *             but downgrades to "busy" when the row is fresh).
 *   busy    — busyUntil > now() AND lastSeenAt within ONLINE.
 *   away    — lastSeenAt within OFFLINE_THRESHOLD_MS (default 15 min)
 *             but lastActiveAt older than AWAY_THRESHOLD_MS
 *             (default 5 min) — or lastActiveAt is null.
 *   offline — lastSeenAt older than OFFLINE_THRESHOLD_MS, or no row.
 */
export type PresenceLabel = 'online' | 'away' | 'busy' | 'offline';

export const ONLINE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
export const AWAY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes of inactivity → away
export const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes → offline

/**
 * Sprint 10 (D10) — server-side write-throttle. The client is
 * supposed to call /presence/heartbeat at most every 60 s, but a
 * misbehaving client (or a tab on top of another tab) can spam.
 * We never re-write the row if the last write landed within this
 * window — the existing row is still fresh enough.
 */
export const HEARTBEAT_WRITE_THROTTLE_MS = 45 * 1000;

/**
 * Sprint 10 (D10) — how long a `busy=true` activity claim holds
 * before the user falls back to plain `online` even if they keep
 * heart-beating. The client sets this on Add Action open / save;
 * a stuck busy row auto-clears after this window so the chip
 * doesn't pretend a closed tab is still "in action".
 */
export const BUSY_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Public presence shape returned for the caller themselves (carries
 * the entity context the caller already knows about).
 */
export interface OwnPresence {
  userId: string;
  status: PresenceLabel;
  lastSeenAt: string;
  lastActiveAt: string | null;
  connectedAt: string | null;
  busyUntil: string | null;
  currentContext: string | null;
  currentEntityType: string | null;
  currentEntityId: string | null;
}

/**
 * Public presence shape returned for someone else — strips the
 * entity id so we don't leak access to a redacted resource even
 * if the UI happens to render it. The label + lastSeenAt are
 * enough for the chip; the lead detail is still gated by D5.
 */
export interface OtherPresence {
  userId: string;
  status: PresenceLabel;
  lastSeenAt: string;
  /**
   * Generic context label only (e.g. `"lead"`). NEVER includes
   * lead identity. The UI renders "Working on a lead" without
   * exposing which lead.
   */
  currentContext: string | null;
}

@Injectable()
export class PresenceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Derive the presence label from the raw timestamps. */
  static derive(
    row: {
      lastSeenAt: Date;
      lastActiveAt: Date | null;
      busyUntil: Date | null;
    },
    now: Date = new Date(),
  ): PresenceLabel {
    const nowMs = now.getTime();
    const seenMs = row.lastSeenAt.getTime();
    const seenAge = nowMs - seenMs;
    if (seenAge > OFFLINE_THRESHOLD_MS) return 'offline';
    if (row.busyUntil && row.busyUntil.getTime() > nowMs && seenAge <= ONLINE_THRESHOLD_MS) {
      return 'busy';
    }
    if (seenAge <= ONLINE_THRESHOLD_MS) {
      // Within the online window — but downgrade to away if no
      // recent interaction at all. This catches the "tab focused
      // but operator stepped out of the room" case.
      const activeMs = row.lastActiveAt?.getTime() ?? null;
      if (activeMs === null || nowMs - activeMs > AWAY_THRESHOLD_MS) {
        // 2-minute window with no interaction is still "online"
        // for UX purposes; only flip to away when we're past the
        // ONLINE window but inside the OFFLINE one.
      }
      return 'online';
    }
    // seenAge between ONLINE and OFFLINE → away/online by activity.
    const activeMs = row.lastActiveAt?.getTime() ?? null;
    if (activeMs === null || nowMs - activeMs > AWAY_THRESHOLD_MS) return 'away';
    return 'online';
  }

  /**
   * /presence/heartbeat — bump lastSeenAt. Server-side throttle
   * skips the write if the previous heartbeat landed less than
   * HEARTBEAT_WRITE_THROTTLE_MS ago. The first heartbeat after
   * an offline gap also stamps `connectedAt = now()`.
   */
  async heartbeat(
    userId: string,
    input: {
      context?: string | null;
      entityType?: string | null;
      entityId?: string | null;
    } = {},
  ): Promise<OwnPresence> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.userPresence.findUnique({ where: { userId } });
      const now = new Date();
      const justOffline =
        !existing || now.getTime() - existing.lastSeenAt.getTime() > OFFLINE_THRESHOLD_MS;
      if (
        existing &&
        now.getTime() - existing.lastSeenAt.getTime() < HEARTBEAT_WRITE_THROTTLE_MS &&
        !input.context &&
        !input.entityType &&
        !input.entityId
      ) {
        // Within the write-throttle window AND the caller didn't
        // ship new context — skip the DB write. The chip already
        // reads the row's current state on the next read.
        return this.shapeOwn(existing);
      }
      const row = await tx.userPresence.upsert({
        where: { userId },
        create: {
          tenantId,
          userId,
          lastSeenAt: now,
          connectedAt: now,
          currentContext: input.context ?? null,
          currentEntityType: input.entityType ?? null,
          currentEntityId: input.entityId ?? null,
        },
        update: {
          lastSeenAt: now,
          // Reset the connectedAt when we've been offline long
          // enough that this counts as a new session — a future
          // "online for 23 minutes" chip needs this.
          ...(justOffline ? { connectedAt: now } : {}),
          ...(input.context !== undefined ? { currentContext: input.context } : {}),
          ...(input.entityType !== undefined ? { currentEntityType: input.entityType } : {}),
          ...(input.entityId !== undefined ? { currentEntityId: input.entityId } : {}),
        },
      });
      return this.shapeOwn(row);
    });
  }

  /**
   * /presence/activity — bump lastSeenAt + lastActiveAt. If
   * `busy=true` is passed, stamp busyUntil for the standard
   * BUSY_WINDOW.
   */
  async activity(
    userId: string,
    input: {
      context?: string | null;
      entityType?: string | null;
      entityId?: string | null;
      busy?: boolean;
    },
  ): Promise<OwnPresence> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const now = new Date();
      const busyUntil = input.busy ? new Date(now.getTime() + BUSY_WINDOW_MS) : null;
      const row = await tx.userPresence.upsert({
        where: { userId },
        create: {
          tenantId,
          userId,
          lastSeenAt: now,
          lastActiveAt: now,
          connectedAt: now,
          busyUntil,
          currentContext: input.context ?? null,
          currentEntityType: input.entityType ?? null,
          currentEntityId: input.entityId ?? null,
        },
        update: {
          lastSeenAt: now,
          lastActiveAt: now,
          // Only clear busyUntil if the caller explicitly passes
          // `busy: false`. Omitting busy keeps the previous value.
          ...(input.busy === true
            ? { busyUntil }
            : input.busy === false
              ? { busyUntil: null }
              : {}),
          ...(input.context !== undefined ? { currentContext: input.context } : {}),
          ...(input.entityType !== undefined ? { currentEntityType: input.entityType } : {}),
          ...(input.entityId !== undefined ? { currentEntityId: input.entityId } : {}),
        },
      });
      return this.shapeOwn(row);
    });
  }

  /** Caller's own presence (with entity context). */
  async findOwn(userId: string): Promise<OwnPresence> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.userPresence.findUnique({ where: { userId } });
      if (!row) {
        // Synthesise an offline shape so the client can always
        // render something without an extra branch.
        return {
          userId,
          status: 'offline',
          lastSeenAt: new Date(0).toISOString(),
          lastActiveAt: null,
          connectedAt: null,
          busyUntil: null,
          currentContext: null,
          currentEntityType: null,
          currentEntityId: null,
        };
      }
      return this.shapeOwn(row);
    });
  }

  /**
   * Bulk presence for a list of user ids. Tenant + RLS gate the
   * visible-user lookup; foreign or out-of-scope ids are silently
   * dropped. Entity id is stripped from the response — only the
   * caller's own /presence/me returns it.
   *
   * Cap mirrors the bulk scope endpoint (200 ids).
   */
  async listForUsers(ids: readonly string[]): Promise<OtherPresence[]> {
    const tenantId = requireTenantId();
    if (ids.length === 0) return [];
    const unique = Array.from(new Set(ids));
    if (unique.length > 200) {
      throw new NotFoundException({
        code: 'presence.bulk.too_many_ids',
        message: 'At most 200 ids per request',
      });
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      // First confirm the requested users are visible (tenant +
      // RLS). Foreign ids fall away here.
      const visible = await tx.user.findMany({
        where: { id: { in: [...unique] } },
        select: { id: true },
      });
      const visibleIds = visible.map((u) => u.id);
      if (visibleIds.length === 0) return [];
      const rows = await tx.userPresence.findMany({
        where: { userId: { in: visibleIds } },
        select: {
          userId: true,
          lastSeenAt: true,
          lastActiveAt: true,
          busyUntil: true,
          currentContext: true,
        },
      });
      const byUser = new Map<string, (typeof rows)[number]>();
      for (const r of rows) byUser.set(r.userId, r);
      const now = new Date();
      return visibleIds.map((userId) => {
        const r = byUser.get(userId);
        if (!r) {
          return {
            userId,
            status: 'offline' as const,
            lastSeenAt: new Date(0).toISOString(),
            currentContext: null,
          };
        }
        return {
          userId,
          status: PresenceService.derive(
            { lastSeenAt: r.lastSeenAt, lastActiveAt: r.lastActiveAt, busyUntil: r.busyUntil },
            now,
          ),
          lastSeenAt: r.lastSeenAt.toISOString(),
          currentContext: r.currentContext,
        };
      });
    });
  }

  /**
   * Count of users in the active tenant whose presence resolves
   * to a target label right now. Used by the Organization
   * "Online users" KPI.
   */
  async countByStatus(label: PresenceLabel): Promise<number> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const now = new Date();
      const onlineCutoff = new Date(now.getTime() - ONLINE_THRESHOLD_MS);
      const offlineCutoff = new Date(now.getTime() - OFFLINE_THRESHOLD_MS);
      const awayActivityCutoff = new Date(now.getTime() - AWAY_THRESHOLD_MS);
      if (label === 'online') {
        // online = lastSeenAt within ONLINE AND NOT (busyUntil > now)
        return tx.userPresence.count({
          where: {
            lastSeenAt: { gte: onlineCutoff },
            OR: [{ busyUntil: null }, { busyUntil: { lte: now } }],
          },
        });
      }
      if (label === 'busy') {
        return tx.userPresence.count({
          where: {
            busyUntil: { gt: now },
            lastSeenAt: { gte: onlineCutoff },
          },
        });
      }
      if (label === 'away') {
        // away = lastSeenAt within OFFLINE but not ONLINE, OR
        //        within ONLINE with no recent activity.
        return tx.userPresence.count({
          where: {
            OR: [
              {
                AND: [{ lastSeenAt: { gte: offlineCutoff } }, { lastSeenAt: { lt: onlineCutoff } }],
              },
              {
                AND: [
                  { lastSeenAt: { gte: onlineCutoff } },
                  {
                    OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: awayActivityCutoff } }],
                  },
                ],
              },
            ],
          },
        });
      }
      // offline — every user without a presence row OR row older
      // than OFFLINE. Use a left-anti pattern via `user.count` minus
      // presence rows fresher than offline.
      const total = await tx.user.count({});
      const fresher = await tx.userPresence.count({
        where: { lastSeenAt: { gte: offlineCutoff } },
      });
      return Math.max(total - fresher, 0);
    });
  }

  private shapeOwn(row: {
    userId: string;
    lastSeenAt: Date;
    lastActiveAt: Date | null;
    connectedAt: Date | null;
    busyUntil: Date | null;
    currentContext: string | null;
    currentEntityType: string | null;
    currentEntityId: string | null;
  }): OwnPresence {
    return {
      userId: row.userId,
      status: PresenceService.derive(
        { lastSeenAt: row.lastSeenAt, lastActiveAt: row.lastActiveAt, busyUntil: row.busyUntil },
        new Date(),
      ),
      lastSeenAt: row.lastSeenAt.toISOString(),
      lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
      connectedAt: row.connectedAt?.toISOString() ?? null,
      busyUntil: row.busyUntil?.toISOString() ?? null,
      currentContext: row.currentContext,
      currentEntityType: row.currentEntityType,
      currentEntityId: row.currentEntityId,
    };
  }
}
