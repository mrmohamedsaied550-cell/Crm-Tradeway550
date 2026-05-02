/**
 * P3-02 — RealtimeService unit tests.
 *
 * No database, no Nest DI, no HTTP. Pure pub/sub semantics:
 *   - subscribe / emit per user fans out only to that user's sinks
 *   - subscribe / emit to a tenant fans out across users
 *   - unsubscribe prunes empty buckets so the map can't leak
 *   - emit is best-effort: a throwing sink never breaks the others
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RealtimeService } from './realtime.service';
import type { RealtimeEvent } from './realtime.types';

const TENANT_A = 't-a';
const TENANT_B = 't-b';
const USER_1 = 'u-1';
const USER_2 = 'u-2';

const sample: RealtimeEvent = {
  type: 'notification.created',
  notificationId: 'n-1',
  recipientUserId: USER_1,
  kind: 'sla.breach',
};

describe('RealtimeService (P3-02)', () => {
  it('emitToUser delivers only to the targeted user', () => {
    const svc = new RealtimeService();
    const got1: RealtimeEvent[] = [];
    const got2: RealtimeEvent[] = [];
    svc.subscribe(TENANT_A, USER_1, (e) => got1.push(e));
    svc.subscribe(TENANT_A, USER_2, (e) => got2.push(e));

    svc.emitToUser(TENANT_A, USER_1, sample);

    assert.equal(got1.length, 1);
    assert.equal(got2.length, 0);
  });

  it('emitToUser is tenant-scoped — a foreign tenant never hears it', () => {
    const svc = new RealtimeService();
    const got: RealtimeEvent[] = [];
    svc.subscribe(TENANT_B, USER_1, (e) => got.push(e));

    svc.emitToUser(TENANT_A, USER_1, sample);

    assert.equal(got.length, 0);
  });

  it('emitToTenant fans out to every user in that tenant only', () => {
    const svc = new RealtimeService();
    const a1: RealtimeEvent[] = [];
    const a2: RealtimeEvent[] = [];
    const b1: RealtimeEvent[] = [];
    svc.subscribe(TENANT_A, USER_1, (e) => a1.push(e));
    svc.subscribe(TENANT_A, USER_2, (e) => a2.push(e));
    svc.subscribe(TENANT_B, USER_1, (e) => b1.push(e));

    svc.emitToTenant(TENANT_A, sample);

    assert.equal(a1.length, 1);
    assert.equal(a2.length, 1);
    assert.equal(b1.length, 0);
  });

  it('a single user can have multiple connections that all receive', () => {
    const svc = new RealtimeService();
    let count = 0;
    const off1 = svc.subscribe(TENANT_A, USER_1, () => (count += 1));
    const off2 = svc.subscribe(TENANT_A, USER_1, () => (count += 1));

    svc.emitToUser(TENANT_A, USER_1, sample);

    assert.equal(count, 2);
    off1();
    off2();
  });

  it('unsubscribe prunes empty buckets so disconnects do not leak', () => {
    const svc = new RealtimeService();
    const off = svc.subscribe(TENANT_A, USER_1, () => {});
    assert.equal(svc.connectionCount(TENANT_A), 1);
    off();
    assert.equal(svc.connectionCount(TENANT_A), 0);
    // Total count too.
    assert.equal(svc.connectionCount(), 0);
  });

  it('a throwing sink never blocks delivery to peers', () => {
    const svc = new RealtimeService();
    let peer = 0;
    svc.subscribe(TENANT_A, USER_1, () => {
      throw new Error('boom');
    });
    svc.subscribe(TENANT_A, USER_1, () => {
      peer += 1;
    });

    svc.emitToUser(TENANT_A, USER_1, sample);

    assert.equal(peer, 1);
  });

  it('emit to no listeners is a silent no-op', () => {
    const svc = new RealtimeService();
    // Should not throw.
    svc.emitToUser('nobody', 'nobody', sample);
    svc.emitToTenant('nobody', sample);
    assert.equal(svc.connectionCount(), 0);
  });
});
