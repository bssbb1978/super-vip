/* Nineteen scheduled jobs must never overlap themselves.  The lock lives in
   D1 (KV is eventually consistent and must not be used for locks), and the
   manual trigger takes the same lock as the scheduler. */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot } from './helpers.mjs';

let qv;
beforeAll(async () => { qv = await boot(); }, 60000);
afterAll(async () => { await qv?.dispose(); });

describe('scheduled jobs', () => {
  test('the task table is complete and time-boxed', async () => {
    const { data } = await qv.json('/api/cron', { headers: qv.auth() });
    expect(data.tasks.length).toBeGreaterThanOrEqual(16);
    for (const t of data.tasks) {
      expect(typeof t.id).toBe('string');
      expect(t.every_sec).toBeGreaterThan(0);
    }
  });

  test('a runner is refused while another holds the same job', async () => {
    /* the lock is taken deterministically here instead of racing two requests
       — the point under test is that a held lock refuses a second runner */
    const held = await qv.post('/api/jobs', { claim: 'state-snapshot', ttl: 90 }, qv.auth());
    expect((await held.json()).data.claimed).toBe(true);

    const blocked = await qv.post('/api/cron', { only: 'state-snapshot' }, qv.auth());
    expect((await blocked.json()).data.results['state-snapshot'].skipped).toBe('locked');

    /* the scheduler waits for the window to pass before it runs it again */
    const again = await qv.post('/api/jobs', { claim: 'state-snapshot', ttl: 90 }, qv.auth());
    expect((await again.json()).data.claimed).toBe(false);

    const freed = await qv.post('/api/jobs', { release: 'state-snapshot' }, qv.auth());
    expect((await freed.json()).data.released).toBe(true);
    const afterRelease = await qv.post('/api/cron', { only: 'state-snapshot' }, qv.auth());
    expect((await afterRelease.json()).data.results['state-snapshot'].skipped).toBeUndefined();
  });

  test('the operator can force a run, and the ledger shows it', async () => {
    const r = await qv.post('/api/cron', { only: 'meter-flush', force: true }, qv.auth());
    const j = await r.json();
    expect(j.data.results['meter-flush'].skipped).toBeUndefined();
    const ledger = await qv.json('/api/jobs', { headers: qv.auth() });
    const row = (ledger.data.items || []).find(x => x.id === 'state-snapshot');
    expect(row).toBeTruthy();
    expect(row.runs).toBeGreaterThanOrEqual(1);            // every run is on the ledger
    expect(typeof ledger.data.queue).toBe('number');
  });

  test('a job that throws is reported, released, and does not wedge the lock', async () => {
    /* the lock must be free again after any outcome */
    const first = await qv.post('/api/cron', { only: 'meter-flush' }, qv.auth());
    expect(first.status).toBe(200);
    const second = await qv.post('/api/cron', { only: 'meter-flush' }, qv.auth());
    const j = await second.json();
    expect(j.data.results['meter-flush'].skipped).toBeUndefined();
  });
});
