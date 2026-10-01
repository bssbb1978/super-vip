/* The isolate has 128 MB for everything.  Every cache this worker owns is
   capped by entries *and* by bytes, and /health reports the footprint, so the
   bound is observable instead of a hope. */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot } from './helpers.mjs';

let qv;
beforeAll(async () => {
  qv = await boot();
  const users = [];
  for (let i = 0; i < 12; i++) users.push((await qv.createUser({ name: 'mem-' + i, quota_gb: 2 })).uuid);
  /* traffic across every hot path: subscriptions, lookups, dns, sessions */
  for (let round = 0; round < 3; round++) {
    for (const u of users) {
      await qv.get('/sub/' + u);
      await qv.json('/api/users/' + u, { headers: qv.auth() });
      await qv.post('/api/meter', { uuid: u, up: 512, down: 1024 }, qv.auth());
    }
    await qv.get('/dns-query?name=example.com&type=A');
  }
}, 90000);
afterAll(async () => { await qv?.dispose(); });

describe('memory hierarchy', () => {
  test('/health reports the cache fleet with hit ratios', async () => {
    const h = (await qv.json('/health')).data;
    expect(Array.isArray(h.caches)).toBe(true);
    expect(h.caches.length).toBeGreaterThan(2);
    for (const c of h.caches) {
      expect(typeof c.name).toBe('string');
      expect(c.hit_rate).toBeGreaterThanOrEqual(0);
      expect(c.max).toBeGreaterThan(0);
    }
    expect(h.memory.budget_bytes).toBe(128 * 1024 * 1024);
  });

  test('no cache exceeds its entry or byte cap', async () => {
    const h = (await qv.json('/health')).data;
    for (const c of h.caches) {
      expect(c.size).toBeLessThanOrEqual(c.max);
      expect(c.bytes).toBeLessThanOrEqual(c.max_bytes);
    }
  });

  test('the whole cache fleet stays far below the isolate budget', async () => {
    const h = (await qv.json('/health')).data;
    expect(h.memory.total_bytes).toBeLessThan(16 * 1024 * 1024);   // used
    expect(h.memory.pct_of_budget).toBeLessThan(12);              // of 128 MB
  });

  test('the hot path is served from RAM, not from storage', async () => {
    const before = (await qv.json('/health')).data.counters;
    /* repeat the exact same lookups: the second pass must hit isolate RAM */
    for (let i = 0; i < 20; i++) await qv.get('/sub/' + (await qv.json('/api/users?limit=1', { headers: qv.auth() })).data.items[0].uuid);
    const after = (await qv.json('/health')).data.counters;
    const reads = (after.d1_read || 0) - (before.d1_read || 0);
    expect(reads).toBeGreaterThan(0);            // user rows are still read…
    const caches = (await qv.json('/health')).data.caches;
    const state = caches.find(c => c.name === 'userState');
    expect(state).toBeTruthy();
    expect(state.hits).toBeGreaterThan(0);       // …but the state came from RAM
  });

  test('an operator can flush every cache at once', async () => {
    const r = await qv.get('/api/cache', { headers: qv.auth() });
    expect(r.status).toBe(200);
    const del = await qv.get('/api/cache', { method: 'DELETE', headers: qv.auth() });
    expect(del.status).toBe(200);
    const after = (await qv.json('/health')).data;
    expect(after.memory.caches_bytes).toBe(0);
  });
});
