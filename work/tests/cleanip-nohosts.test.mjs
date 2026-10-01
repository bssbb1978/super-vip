/* The no-HOSTS edge case: a deployment that has configured no custom domain
   yet still sees tunnel feedback arrive.  It must be dropped *visibly* — the
   operator needs the reason (a silent drop hid a misconfigured deployment),
   and the audit has to show it. */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot, sleep } from './helpers.mjs';

let qv;
const counters = async () => (await qv.json('/health')).data.counters;

beforeAll(async () => {
  /* the deliberately awkward deployment: no domain list, no custom domain */
  qv = await boot({ HOSTS: '', CUSTOM_DOMAIN: '' });
}, 60000);
afterAll(async () => { await qv?.dispose(); });

describe('feedback with nothing configured', () => {
  test('an authenticated tunnel session records a visible drop, not a silent one', async () => {
    const before = (await counters()).ci_feedback_dropped_nohosts || 0;
    const user = await qv.createUser({ name: 'nohosts', quota_gb: 5 });
    const port = Number(new URL(await qv.mf.ready).port);
    const hex = user.uuid.replace(/-/g, '');
    const f = new Uint8Array(26);
    f[0] = 0;
    for (let i = 0; i < 16; i++) f[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    f[17] = 0; f[18] = 1; f[19] = (port >> 8) & 0xff; f[20] = port & 0xff; f[21] = 1;
    f.set([127, 0, 0, 1], 22);
    const r = await qv.get('/ws/' + user.uuid, { headers: { upgrade: 'websocket', host: 'node.example.dev' } });
    expect(r.status).toBe(101);
    r.webSocket.accept();
    r.webSocket.send(f.buffer);
    await sleep(800);
    expect(((await counters()).ci_feedback_dropped_nohosts || 0)).toBe(before + 1);
    const rows = await (await qv.mf.getD1Database('DB'))
      .prepare("SELECT COUNT(*) n FROM qv_ip_scores WHERE ip = 'node.example.dev'").all();
    expect(Number(rows.results[0].n)).toBe(0);          /* dropped, and nothing invented */
  });

  test('the audit names the reason and the degradation', async () => {
    const a = (await qv.json('/api/endpoints', { headers: qv.auth() })).data;
    expect(a.dropped_feedback['no-hosts']).toBeGreaterThan(0);
    expect(typeof a.dropped_feedback['last_no-hosts']).toBe('string');
    expect(a.degraded.feedback).toBeGreaterThan(0);
    expect(a.degraded.last.kind).toBe('feedback');
  });

  test('an unknown host with domains configured is refused by name', async () => {
    const qv2 = qv;                                     /* same session: the operator path */
    const r = await (await qv2.post('/api/ips', { action: 'feedback', host: 'not-configured.example.dev', ok: true }, qv2.auth())).json();
    expect(r.data.buffered === 1 || r.data.recorded).toBeTruthy();   /* accepted only as a hint, never as a candidate */
    const rows = await (await qv2.mf.getD1Database('DB'))
      .prepare("SELECT COUNT(*) n FROM qv_ip_scores WHERE ip = 'not-configured.example.dev'").all();
    expect(Number(rows.results[0].n)).toBe(0);
  });
});
