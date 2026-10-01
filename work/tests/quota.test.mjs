/* Per-user isolation: the account's own limit lives in D1, and the moment it
   is exhausted that one account loses its configs — nobody else's. */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot } from './helpers.mjs';

let qv;
beforeAll(async () => { qv = await boot(); }, 60000);
afterAll(async () => { await qv?.dispose(); });

const user = (uuid) => qv.json('/api/users/' + uuid, { headers: qv.auth() }).then(r => r.data.item);
const sub = (uuid) => qv.get('/sub/' + uuid);

describe('per-user quota, cut-off and revival', () => {
  test('a fresh account gets its own subscription', async () => {
    const u = await qv.createUser({ name: 'quota-a', quota_bytes: 4000, days: 5 });
    const r = await sub(u.uuid);
    expect(r.status).toBe(200);
    const text = Buffer.from(await r.text(), 'base64').toString('utf8');
    expect(text).toMatch(/vless:\/\//);
  });

  test('usage is metered against the account, both directions', async () => {
    const u = await qv.createUser({ name: 'quota-b', quota_bytes: 100000, days: 5 });
    const r = await qv.post('/api/meter', { uuid: u.uuid, up: 1024, down: 2048 }, qv.auth());
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.data.added).toBe(3072);
    const row = await user(u.uuid);
    expect(row.used_bytes).toBe(3072);
    expect(row.up_bytes).toBe(1024);
    expect(row.down_bytes).toBe(2048);
    expect(j.data.cut).toBe(false);
  });

  test('the account that crosses its limit is cut, the others are untouched', async () => {
    const small = await qv.createUser({ name: 'quota-small', quota_bytes: 3000, days: 5 });
    const big = await qv.createUser({ name: 'quota-big', quota_bytes: 900000, days: 5 });

    const r = await qv.post('/api/meter', { uuid: small.uuid, up: 2500, down: 2500 }, qv.auth());
    const j = await r.json();
    expect(j.data.cut).toBe(true);

    /* the cut is real: this profile stops being served… */
    const blocked = await sub(small.uuid);
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).not.toMatch(/vless:\/\//);

    /* …while the neighbour with room to spare keeps working */
    const okSub = await sub(big.uuid);
    expect(okSub.status).toBe(200);
    const text = Buffer.from(await okSub.text(), 'base64').toString('utf8');
    expect(text).toMatch(/vless:\/\//);

    const cut = await user(small.uuid);
    expect(cut.killswitch === 1 || cut.killswitch === true).toBe(true);
  });

  test('the operator can revive the account, and the cut is not sticky', async () => {
    const u = await qv.createUser({ name: 'quota-revive', quota_bytes: 2000, days: 5 });
    await qv.post('/api/meter', { uuid: u.uuid, up: 5000, down: 0 }, qv.auth());
    expect((await sub(u.uuid)).status).toBe(403);
    await qv.patch('/api/users/' + u.uuid, { killswitch: 0, enabled: 1, used_bytes: 0 }, qv.auth());
    const after = await sub(u.uuid);
    expect(after.status).toBe(200);
    expect(Buffer.from(await after.text(), 'base64').toString('utf8')).toMatch(/vless:\/\//);
  });

  test('the scheduled sweep cuts what the meter missed', async () => {
    const u = await qv.createUser({ name: 'quota-sweep-user', quota_bytes: 1000, days: 5 });
    await qv.patch('/api/users/' + u.uuid, { used_bytes: 5000 }, qv.auth());   // as if reported elsewhere
    const run = await qv.post('/api/cron', { only: 'quota-sweep' }, qv.auth());
    expect(run.status).toBe(200);
    const row = await user(u.uuid);
    /* D1 stores 0/1, the API hands out booleans — either spelling means cut */
    expect(row.killswitch === 1 || row.killswitch === true || row.enabled === 0 || row.enabled === false).toBe(true);
    expect((await sub(u.uuid)).status).toBe(403);
  });

  test('the same limits are visible to the user in the panel API', async () => {
    const u = await qv.createUser({ name: 'quota-self', quota_bytes: 777000, days: 5 });
    const { data } = await qv.json('/api/users/' + u.uuid, { headers: qv.auth() });
    expect(data.item.total_bytes).toBe(777000);
    expect(data.item.used_bytes).toBeGreaterThanOrEqual(0);
  });
});

describe('quota boundaries and the deferred meter', () => {
  test('the boundary itself: used == quota is cut, one byte under is not', async () => {
    const at = await qv.createUser({ name: 'edge-at', quota_bytes: 5000, days: 5 });
    const under = await qv.createUser({ name: 'edge-under', quota_bytes: 5000, days: 5 });

    const r1 = await qv.post('/api/meter', { uuid: at.uuid, up: 5000, down: 0 }, qv.auth());
    expect((await r1.json()).data.cut).toBe(true);            // exactly at the limit
    expect((await qv.get('/sub/' + at.uuid)).status).toBe(403);

    const r2 = await qv.post('/api/meter', { uuid: under.uuid, up: 4999, down: 0 }, qv.auth());
    expect((await r2.json()).data.cut).toBe(false);
    expect((await qv.get('/sub/' + under.uuid)).status).toBe(200);

    const r3 = await qv.post('/api/meter', { uuid: under.uuid, up: 0, down: 1 }, qv.auth());
    expect((await r3.json()).data.cut).toBe(true);            // the last byte tips it
  });

  test('the deleted account cannot be metered into existence', async () => {
    const r = await qv.post('/api/meter', { uuid: '00000000-0000-4000-8000-000000000000', up: 10, down: 10 }, qv.auth());
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.data.item).toBeFalsy();
  });

  test('the queues and caches the metering path uses are bounded and visible', async () => {
    const h = (await qv.json('/health')).data;
    expect(typeof h.meter_queue).toBe('number');
    expect(h.meter_queue).toBeLessThanOrEqual(2000);
    const guard = h.caches.find(c => c.name === 'meterGuard');
    if (guard) expect(guard.size).toBeLessThanOrEqual(guard.max);
  });
});
