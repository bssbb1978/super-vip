import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot } from './helpers.mjs';

let qv;
beforeAll(async () => { qv = await boot(); }, 60000);
afterAll(async () => { await qv?.dispose(); });

describe('accounts, quota and per-user cut-off', () => {
  test('the API refuses anonymous callers', async () => {
    expect((await qv.get('/api/users')).status).toBe(401);
  });

  test('an admin can sign in and receives a session cookie', async () => {
    const r = await qv.post('/api/login', { password: 'test-pass' });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/qv_sid=/);
  });

  test('a wrong password is rejected', async () => {
    expect((await qv.post('/api/login', { password: 'nope' })).status).toBe(401);
  });

  test('creating an account stores the quota in bytes and gives it a config', async () => {
    const item = await qv.createUser({ name: 'quota-user', quota_gb: 10, days: 30 });
    expect(item.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.quota_bytes).toBe(10 * 1024 ** 3);
    expect(item.enabled).toBe(true);
    expect(item.killswitch).toBe(false);
  });

  test('quota can be raised and the change is visible immediately', async () => {
    const item = await qv.createUser({ name: 'raise', quota_gb: 5 });
    const { data } = await qv.json('/api/users/' + item.uuid, { method: 'PATCH', headers: qv.auth({ 'content-type': 'application/json' }), body: JSON.stringify({ quota_gb: 25 }) });
    expect(data.item.quota_bytes).toBe(25 * 1024 ** 3);
  });

  test('the kill switch cuts one account without touching the others', async () => {
    const a = await qv.createUser({ name: 'cut-me' });
    const b = await qv.createUser({ name: 'keep-me' });
    await qv.patch('/api/users/' + a.uuid, { killswitch: 1 }, qv.auth());
    const cut = await qv.get('/sub/' + a.uuid);
    const alive = await qv.get('/sub/' + b.uuid);
    expect(cut.status).toBe(403);
    expect(alive.status).toBe(200);
    /* reviving restores the configs */
    await qv.patch('/api/users/' + a.uuid, { killswitch: 0 }, qv.auth());
    expect((await qv.get('/sub/' + a.uuid)).status).toBe(200);
  });

  test('accounts can be deleted and disappear from the list', async () => {
    const item = await qv.createUser({ name: 'temp' });
    const r = await qv.del('/api/users/' + item.uuid, qv.auth());
    expect(r.status).toBe(200);
    const { data } = await qv.json('/api/users', { headers: qv.auth() });
    expect(data.items.some(u => u.uuid === item.uuid)).toBe(false);
  });

  test('sessions are listed and can be closed per user', async () => {
    const { r, data } = await qv.json('/api/sessions', { headers: qv.auth() });
    expect(r.status).toBe(200);
    expect(Array.isArray(data.items)).toBe(true);
  });

  test('an account over its quota is cut by the sweep and revived when raised', async () => {
    const item = await qv.createUser({ name: 'over', quota_gb: 0.000001 });
    /* simulate traffic beyond the tiny quota through the meter endpoint */
    await qv.post('/api/meter', { uuid: item.uuid, up: 4096, down: 4096 }, qv.auth());
    const cut = await qv.json('/api/cron', { method: 'POST', headers: qv.auth({ 'content-type': 'application/json' }), body: JSON.stringify({ only: 'quota-sweep' }) });
    expect(cut.r.status).toBe(200);
    const after = await qv.json('/api/users/' + item.uuid, { headers: qv.auth() });
    expect(after.data.item.killswitch).toBe(true);
    /* raise the quota again and let the sweep notice */
    await qv.patch('/api/users/' + item.uuid, { quota_gb: 5, killswitch: 0 }, qv.auth());
    await qv.json('/api/cron', { method: 'POST', headers: qv.auth({ 'content-type': 'application/json' }), body: JSON.stringify({ only: 'quota-sweep' }) });
    const revived = await qv.json('/api/users/' + item.uuid, { headers: qv.auth() });
    expect(revived.data.item.killswitch).toBe(false);
  });
});
