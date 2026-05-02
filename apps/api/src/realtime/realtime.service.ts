import { Injectable, Logger } from '@nestjs/common';

import type { RealtimeEvent } from './realtime.types';

/**
 * P3-02 — in-process pub/sub for SSE clients.
 *
 * One instance per API process. Subscribers register a callback keyed
 * by `(tenantId, userId)`; emitters push events into the right slot.
 * Tenant-broadcast events fan out to every connection in the tenant.
 *
 * Multi-pod note: when the API scales horizontally (Phase 4), swap
 * this in-process map for a Redis pub/sub adapter. The interface
 * (`subscribe`, `emitToUser`, `emitToTenant`) deliberately doesn't
 * leak the implementation detail so callers don't need to change.
 */
type EventSink = (event: RealtimeEvent) => void;

interface UserBucket {
  /**
   * Set of sinks for this user. A user can have multiple connections
   * (desktop browser + phone PWA) at the same time — every connection
   * gets a copy of every event.
   */
  sinks: Set<EventSink>;
}

interface TenantBucket {
  users: Map<string, UserBucket>;
}

@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly tenants = new Map<string, TenantBucket>();

  /**
   * Register a sink for `(tenantId, userId)`. Returns an unsubscribe
   * function that removes the sink and prunes empty buckets so the
   * map doesn't grow unbounded with disconnected clients.
   */
  subscribe(tenantId: string, userId: string, sink: EventSink): () => void {
    let tenant = this.tenants.get(tenantId);
    if (!tenant) {
      tenant = { users: new Map() };
      this.tenants.set(tenantId, tenant);
    }
    let user = tenant.users.get(userId);
    if (!user) {
      user = { sinks: new Set() };
      tenant.users.set(userId, user);
    }
    user.sinks.add(sink);
    return () => {
      user!.sinks.delete(sink);
      if (user!.sinks.size === 0) tenant!.users.delete(userId);
      if (tenant!.users.size === 0) this.tenants.delete(tenantId);
    };
  }

  /** Send an event to one user inside the tenant. No-op if nobody is listening. */
  emitToUser(tenantId: string, userId: string, event: RealtimeEvent): void {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return;
    const user = tenant.users.get(userId);
    if (!user) return;
    for (const sink of user.sinks) this.safeInvoke(sink, event);
  }

  /** Send an event to every connection in the tenant. */
  emitToTenant(tenantId: string, event: RealtimeEvent): void {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return;
    for (const user of tenant.users.values()) {
      for (const sink of user.sinks) this.safeInvoke(sink, event);
    }
  }

  /** Test/debug helper: count of currently-connected sinks. */
  connectionCount(tenantId?: string): number {
    if (tenantId) {
      const t = this.tenants.get(tenantId);
      if (!t) return 0;
      let n = 0;
      for (const u of t.users.values()) n += u.sinks.size;
      return n;
    }
    let n = 0;
    for (const t of this.tenants.values()) {
      for (const u of t.users.values()) n += u.sinks.size;
    }
    return n;
  }

  private safeInvoke(sink: EventSink, event: RealtimeEvent): void {
    try {
      sink(event);
    } catch (err) {
      // A failing sink (closed socket, throwing handler) must not
      // break delivery to peers. Log and move on; the controller's
      // close handler will clean it up shortly.
      this.logger.warn(`realtime sink threw: ${(err as Error).message}`);
    }
  }
}
