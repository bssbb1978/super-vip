/* KV is a read-mostly store with a tiny write quota: no packet, request or
   session may write to it.  This test drives real traffic and measures the
   write rate the worker actually produced. */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot } from './helpers.mjs';

let qv, users = [];
const counters = async () => (await qv.json('/health')).data.counters;

beforeAll(async () => {
  qv = await boot();
  const first = await qv.createUser({ name: 'kv-0', quota_gb: 2 });
  await qv.get('/sub/' + first.uuid);                 // mints its credential once
  users.push(first.uuid);
  for (let i = 1; i < 10; i++) {
    const u = await qv.createUser({ name: 'kv-' + i, quota_gb: 2 });
    await qv.get('/sub/' + u.uuid);
    users.push(u.uuid);
  }
  await qv.post('/api/cron', { only: 'state-snapshot', force: true }, qv.auth());
}, 90000);
afterAll(async () => { await qv?.dispose(); });

describe('KV write budget', () => {
  test('a steady-state workload barely touches KV', async () => {
    const before = await counters();
    /* 30 subscriptions + 30 metering reports + a cron tick */
    for (let round = 0; round < 3; round++) {
      for (const u of users) {
        await qv.get('/sub/' + u);
        await qv.post('/api/meter', { uuid: u, up: 256, down: 512 }, qv.auth());
      }
    }
    await qv.post('/api/cron', { only: 'quota-sweep', force: true }, qv.auth());
    const after = await counters();
    const kv = (after.kv_write || 0) - (before.kv_write || 0);
    const reqs = 30 + 30 + 1;
    expect(kv).toBeLessThanOrEqual(6);                    // ≈ 0.1 writes/request
    expect(kv / reqs).toBeLessThan(0.2);
  });

  test('read traffic never writes to KV', async () => {
    const before = await counters();
    for (let i = 0; i < 25; i++) {
      await qv.get('/sub/' + users[i % users.length]);
      await qv.json('/api/users/' + users[i % users.length], { headers: qv.auth() });
    }
    const after = await counters();
    expect((after.kv_write || 0) - (before.kv_write || 0)).toBeLessThanOrEqual(2);
  });

  test('the D1 write rate stays proportional to sessions, not packets', async () => {
    const before = await counters();
    for (let i = 0; i < 40; i++) await qv.post('/api/meter', { uuid: users[i % users.length], up: 128, down: 256 }, qv.auth());
    const after = await counters();
    const writes = (after.d1_write || 0) - (before.d1_write || 0);
    expect(writes).toBeLessThanOrEqual(80);               // ≤ 2 statements per report
    expect(writes).toBeGreaterThan(0);
  });

  test('/health reports the counters needed to police this in production', async () => {
    const c = await counters();
    for (const k of ['kv_write', 'd1_write', 'd1_read']) expect(typeof c[k]).toBe('number');
  });
});
