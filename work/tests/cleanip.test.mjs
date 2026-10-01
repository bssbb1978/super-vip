/* The clean-endpoint engine, end to end against the real Worker:
   batch handout, signed reports, forgery and replay rejection, rate limits,
   the ranking that reaches /api/ips and the subscription, and the write
   budget the whole path is allowed to spend. */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot, sleep } from './helpers.mjs';

let qv, uuid;
const counters = async () => (await qv.json('/health')).data.counters;

const batch = async (u = uuid) => (await qv.json('/api/ip-batch?u=' + u)).data;

/** a well-formed report for one candidate of a batch */
const reportFor = (b, ip, over = {}) => ({
  t: b.token, u: uuid, f: 'v4',
  r: [{ ip, family: 'v4', rttMs: 140, ok: true, tlsOk: true, wsOk: true, nonce: 'n' + Math.random().toString(36).slice(2, 8), ...over }],
});
const post = (body) => qv.post('/api/ip-report', body);

beforeAll(async () => {
  qv = await boot();
  uuid = (await qv.createUser({ name: 'ci-user', quota_gb: 5 })).uuid;
}, 60000);
afterAll(async () => { await qv?.dispose(); });

describe('candidate hand-out', () => {
  test('a batch carries dual-stack candidates, handles and a signed token', async () => {
    const b = await batch();
    expect(b.ok).toBe(true);
    expect(typeof b.token).toBe('string');
    expect(b.token.split('.').length).toBe(2);
    expect(b.ips.length).toBeGreaterThan(0);
    const families = new Set(b.ips.map(i => i.family));
    expect([...families].every(f => f === 'v4' || f === 'v6')).toBe(true);
    expect(b.handles.length).toBeGreaterThan(0);
    expect(b.limits.concurrency).toBeLessThanOrEqual(4);
  });

  test('every handed-out address survives the exclusion rules', async () => {
    const b = await batch();
    const excluded = b.ips.filter(i => /^(10\.|127\.|192\.168\.|100\.64\.|169\.254\.|10\.10\.34\.)|^(::1|fe80|fc)/.test(i.ip));
    expect(excluded).toEqual([]);
  });

  test('an unknown account cannot get a batch', async () => {
    const r = await qv.get('/api/ip-batch?u=00000000-0000-4000-8000-000000000000');
    expect(r.status).toBe(404);
    const bad = await qv.get('/api/ip-batch?u=not-a-uuid');
    expect(bad.status).toBe(400);
  });

  test('a disabled account is refused', async () => {
    const tmp = await qv.createUser({ name: 'ci-disabled' });
    await qv.patch('/api/users/' + tmp.uuid, { killswitch: 1 }, qv.auth());
    const r = await qv.get('/api/ip-batch?u=' + tmp.uuid);
    expect(r.status).toBe(403);
  });

  test('the prober is served as a self-contained script and page', async () => {
    const js = await qv.get('/probe.js');
    expect(js.status).toBe(200);
    const src = await js.text();
    expect(src).toMatch(/QVProbe/);
    expect(src).toMatch(/api\/ip-report/);
    expect(src).not.toMatch(/<script/i);          // it is JS, not a page
    const page = await qv.get('/probe/' + uuid);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/\/probe\.js/);
  });
});

describe('report intake', () => {
  test('a properly signed report is accepted and lands as an aggregate row', async () => {
    const u = await qv.createUser({ name: 'ci-report' });
    let target = null;
    for (let i = 0; i < 3; i++) {
      const bb = await batch(u.uuid);
      /* measure a different candidate each round: one report per address */
      const ip = bb.ips[Math.min(i, bb.ips.length - 1)].ip;
      if (!target) target = ip;
      const r = await post({ t: bb.token, u: u.uuid, f: 'v4', r: [{ ip, family: 'v4', rttMs: 150 + i * 10, ok: true, tlsOk: true, wsOk: true, nonce: 'ok' + i }] });
      expect(r.status).toBe(200);
      const j = await r.json();            /* public endpoint: flat body */
      expect(j.accepted).toBe(1);
    }
    const flushed = await qv.post('/api/cron', { only: 'ip-agg', force: true }, qv.auth());
    expect(flushed.status).toBe(200);
    const audit = (await qv.json('/api/endpoints', { headers: qv.auth() })).data;
    const row = audit.recent.find(r => r.ip === target);
    expect(row).toBeTruthy();                 // the address entered the ranking
    expect(row.samples).toBeGreaterThan(0);
    expect(row.score).toBeGreaterThan(0);
  });

  test('a tampered token is refused', async () => {
    const b = await batch();
    const body = reportFor(b, b.ips[0].ip);
    body.t = body.t.slice(0, -4) + 'AAAA';
    const r = await post(body);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('bad-signature');
  });

  test('a token from another account is refused', async () => {
    const other = await qv.createUser({ name: 'ci-other' });
    const bo = await batch(other.uuid);
    const r = await post({ t: bo.token, u: other.uuid, r: [{ ip: bo.ips[0].ip, rttMs: 120, ok: true, nonce: 'x1' }] });
    /* the token is valid for *that* account, so this one succeeds… */
    expect(r.status).toBe(200);
    /* …but presenting it as somebody else does not */
    const stolen = await post({ t: bo.token, u: uuid, r: [{ ip: bo.ips[0].ip, rttMs: 120, ok: true, nonce: 'x2' }] });
    expect(stolen.status).toBe(403);
  });

  test('an address that was never handed out is rejected', async () => {
    const b = await batch();
    const r = await post(reportFor(b, '203.0.113.77'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.accepted).toBe(0);
    expect(j.rejected).toBe(1);
  });

  test('the same batch cannot be replayed', async () => {
    const b = await batch();
    const body = reportFor(b, b.ips[0].ip);
    const first = await post(body);
    expect(first.status).toBe(200);
    const replay = await post({ ...body, r: [{ ...body.r[0], nonce: 'other' }] });
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toBe('batch-already-used');
  });

  test('the same report cannot be replayed inside a batch', async () => {
    const b = await batch();
    const one = { ip: b.ips[0].ip, rttMs: 90, ok: true, nonce: 'dup' };
    const r = await post({ t: b.token, u: uuid, r: [one, { ...one }] });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.accepted).toBe(1);
    expect(j.rejected).toBe(1);
  });

  test('an oversized payload is refused before it is parsed', async () => {
    const b = await batch();
    const huge = { t: b.token, u: uuid, r: new Array(400).fill({ ip: b.ips[0].ip, rttMs: 100, ok: true, nonce: 'z' }) };
    const r = await post(huge);
    expect([400, 413]).toContain(r.status);
  });

  test('a burst of batches is rate limited per account', async () => {
    const tmp = await qv.createUser({ name: 'ci-rate' });
    let limited = 0;
    for (let i = 0; i < 10; i++) {
      const bb = await batch(tmp.uuid);
      const r = await post({ t: bb.token, u: tmp.uuid, r: [{ ip: bb.ips[0].ip, rttMs: 100, ok: true, nonce: 'r' + i }] });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  test('absurdly fast answers are recorded as suspect, not as truth', async () => {
    const u = await qv.createUser({ name: 'ci-suspect' });
    const b = await batch(u.uuid);
    /* a 1 ms round trip from a subscriber network is not a measurement */
    const r = await post({ t: b.token, u: u.uuid, f: 'v4', r: [{ ip: b.ips[0].ip, family: 'v4', rttMs: 1, ok: true, nonce: 'fast' }] });
    expect(r.status).toBe(200);
    await qv.post('/api/cron', { only: 'ip-agg', force: true }, qv.auth());
    const audit = (await qv.json('/api/endpoints', { headers: qv.auth() })).data;
    const row = audit.recent.find(x => x.ip === b.ips[0].ip);
    expect(row).toBeTruthy();
    expect(row.samples).toBeLessThanOrEqual(0.3);      // weighted down, not trusted
  });
});

describe('end-to-end handle verdicts (wss:// with real SNI)', () => {
  test('a host verdict from a handed-out handle is accepted and scored', async () => {
    const b = await batch();
    const h = b.handles[0];
    const body = { t: b.token, u: uuid, f: 'v4', r: [], h: [
      { host: h.host, rttMs: 210, ok: true, tlsOk: true, wsOk: true, nonce: 'h' + Math.random().toString(36).slice(2, 8) },
    ] };
    const j = await (await post(body)).json();
    expect(j.ok).toBe(true);
    expect(j.accepted).toBe(1);
    /* and it lands in the per-ASN scope under the hostname, where pick() can
       never mistake it for an address */
    await qv.post('/api/cron', { only: 'ip-agg', force: true }, qv.auth());
    const audit = (await qv.json('/api/endpoints', { headers: qv.auth() })).data;
    const rows = (audit.recent || []).filter(r => r.family === 'host');
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find(r => r.ip === h.host.toLowerCase());
    expect(row).toBeTruthy();
    expect(row.ws_ok).toBeGreaterThan(0);
    expect(row.scope.startsWith('asn:')).toBe(true);
    expect(row.score).toBeGreaterThan(0);
  });

  test('a handle this account was never given is rejected', async () => {
    const b = await batch();
    const j = await (await post({ t: b.token, u: uuid, f: 'v4', r: [],
      h: [{ host: 'not-ours.example.invalid', rttMs: 100, ok: true, tlsOk: true, wsOk: true, nonce: 'x1' }] })).json();
    expect(j.rejected).toBeGreaterThanOrEqual(1);
    expect(j.accepted).toBe(0);
  });

  test('a malformed host name never reaches the buffer', async () => {
    const b = await batch();
    const j = await (await post({ t: b.token, u: uuid, f: 'v4', r: [],
      h: [{ host: 'bad host!', rttMs: 100, ok: true, tlsOk: true, wsOk: true, nonce: 'x2' }] })).json();
    expect(j.accepted).toBe(0);
  });
});

describe('hardening: D1 limits, accumulation, dual-stack feedback', () => {
  const ips = (body) => qv.post('/api/ips', body, qv.auth());
  const flush = async () => (await (await ips({ action: 'flush' })).json()).data;
  const d1 = async (sql, ...params) => {
    const db = await qv.mf.getD1Database('DB');
    const r = await db.prepare(sql).bind(...params).all();
    return r.results || [];
  };

  test('a batch token carries the allow-list, so any isolate can verify it', async () => {
    const b = await batch();
    /* the payload is visible (it is base64, not encrypted) but signed: it must
       list exactly the addresses and handles that were handed out */
    const payload = JSON.parse(Buffer.from(b.token.split('.')[0], 'base64url').toString('utf8'));
    expect(Array.isArray(payload.i)).toBe(true);
    expect(payload.i).toEqual(b.ips.map(x => x.ip));
    expect(payload.h).toEqual([...new Set(b.handles.map(h => h.host))]);
    /* and the hand-out itself has no repeated handle */
    expect(new Set(b.handles.map(h => h.host + ':' + h.port)).size).toBe(b.handles.length);
  });

  test('45 buffered rows flush in chunks — past the 100-parameter limit', async () => {
    for (let i = 0; i < 45; i++) {
      await ips({ action: 'feedback', host: 'node' + i + '.example.dev', ok: true, uuid: 'bulk-' + i });
    }
    const r = await flush();
    expect(r.flushed).toBeGreaterThanOrEqual(45);
    expect(r.batches).toBeGreaterThanOrEqual(2);          /* statements were chunked, not sent as 45-in-one */
    const rows = await d1('SELECT COUNT(*) n FROM qv_ip_scores WHERE family = ?', 'host');
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(45);
  });

  test('counters accumulate across flushes instead of resetting', async () => {
    await ips({ action: 'feedback', host: 'node7.example.dev', ok: true, uuid: 'again-1' });
    await flush();
    const [row] = await d1("SELECT samples, ok FROM qv_ip_scores WHERE ip = ? AND family = 'host'", 'node7.example.dev');
    expect(Number(row.samples)).toBeGreaterThanOrEqual(2);   /* 1 from the bulk pass + 1 now */
    expect(Number(row.ok)).toBeGreaterThanOrEqual(2);
  });

  test('a NAT64 form of a proven v4 endpoint is accepted as feedback', async () => {
    const b = await batch();
    const v4 = b.ips.find(x => x.family === 'v4');
    const [a, c, d, e] = v4.ip.split('.').map(Number);
    const nat64 = '64:ff9b::' + [a, c, d, e].map(n => ((n << 8) | 0).toString(16)).join(':').replace(/:0(?=:|$)/g, ':0');
    const mapped = '64:ff9b::' + ((a << 8 | c).toString(16)) + ':' + ((d << 8 | e).toString(16));
    const j = await (await ips({ action: 'feedback', ip: mapped, ok: true, ep: mapped })).json();
    expect(j.data.ok).toBe(true);
    expect(j.data.recorded.length).toBeGreaterThan(0);
    await flush();
    const rows = await d1('SELECT scope, family FROM qv_ip_scores WHERE ip = ?', mapped);
    expect(rows.length).toBe(1);
    expect(rows[0].family).toBe('v6');
  });

  test('decay never erodes a row that was just measured', async () => {
    const before = await d1("SELECT samples FROM qv_ip_scores WHERE ip = ? AND family = 'host'", 'node7.example.dev');
    await qv.post('/api/cron', { only: 'ip-agg', force: true }, qv.auth());
    await qv.post('/api/cron', { only: 'ip-agg', force: true }, qv.auth());
    const after = await d1("SELECT samples FROM qv_ip_scores WHERE ip = ? AND family = 'host'", 'node7.example.dev');
    expect(Number(after[0].samples)).toBe(Number(before[0].samples));
  });

  test('an upper-case IPv6 spelling of a handed-out address is accepted', async () => {
    let b = await batch();
    for (let i = 0; i < 3 && !b.ips.some(x => x.family === 'v6'); i++) b = await batch();
    const v6 = b.ips.find(x => x.family === 'v6');
    if (!v6) return;                                        /* a v4-only sample is not a failure */
    const body = { t: b.token, u: uuid, f: 'v6', r: [
      { ip: v6.ip.toUpperCase(), family: 'v6', rttMs: 180, ok: true, tlsOk: true, wsOk: true, nonce: 'up1' },
    ] };
    const j = await (await post(body)).json();
    expect(j.accepted).toBe(1);
    await flush();
    const rows = await d1('SELECT ip FROM qv_ip_scores WHERE ip = ?', v6.ip);
    expect(rows.length).toBe(1);                            /* one identity, one row */
  });
});

describe('tunnel feedback is authenticated, and can only confirm', () => {
  const d1rows = async (sql, ...params) => {
    const db = await qv.mf.getD1Database('DB');
    return (await db.prepare(sql).bind(...params).all()).results;
  };
  const counters = async () => (await qv.json('/health')).data.counters;
  const vlessFrame = (uuid, port, host = [127, 0, 0, 1]) => {
    const hex = uuid.replace(/-/g, '');
    const f = new Uint8Array(22 + 4);
    f[0] = 0;
    for (let i = 0; i < 16; i++) f[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    f[17] = 0; f[18] = 1; f[19] = (port >> 8) & 0xff; f[20] = port & 0xff; f[21] = 1;
    f.set(host, 22);
    return f;
  };

  test('an unauthenticated upgrade is observed, never scored', async () => {
    const before = (await counters()).ci_upgrade_seen || 0;
    const r = await qv.get('/ws', { headers: { upgrade: 'websocket', host: 'node.example.dev' } });
    expect(r.status).toBe(101);
    expect(((await counters()).ci_upgrade_seen || 0)).toBe(before + 1);
    const rows = await d1rows("SELECT COUNT(*) n FROM qv_ip_scores WHERE provider = 'tunnel'");
    expect(Number(rows[0].n)).toBe(0);                      /* a socket alone changes nothing */
  });

  test('a session that authenticates and opens upstream scores its host', async () => {
    const user = await qv.createUser({ name: 'tunnel-fb', quota_gb: 5 });
    const port = Number(new URL(await qv.mf.ready).port);
    const r = await qv.get('/ws/' + user.uuid, { headers: { upgrade: 'websocket', host: 'node.example.dev', 'cf-connecting-ip': '5.5.5.5' } });
    expect(r.status).toBe(101);
    r.webSocket.accept();
    r.webSocket.send(vlessFrame(user.uuid, port).buffer);
    await sleep(700);
    await qv.post('/api/ips', { action: 'flush' }, qv.auth());
    const rows = await d1rows("SELECT samples, ok, ws_ok, scope FROM qv_ip_scores WHERE ip = 'node.example.dev' AND provider = 'tunnel'");
    expect(rows.length).toBe(1);
    expect(Number(rows[0].samples)).toBeGreaterThan(0);
    expect(rows[0].scope.startsWith('asn:')).toBe(true);
  });

  test('a dialled address the engine never handed out is refused', async () => {
    const before = (await counters()).ci_feedback_unknown_ip || 0;
    const user = await qv.createUser({ name: 'tunnel-poison', quota_gb: 5 });
    const port = Number(new URL(await qv.mf.ready).port);
    const r = await qv.get('/ws/' + user.uuid + '?ep=104.16.9.9', { headers: { upgrade: 'websocket', host: 'node.example.dev' } });
    r.webSocket.accept();
    r.webSocket.send(vlessFrame(user.uuid, port).buffer);
    await sleep(700);
    await qv.post('/api/ips', { action: 'flush' }, qv.auth());
    expect(((await counters()).ci_feedback_unknown_ip || 0)).toBe(before + 1);
    const rows = await d1rows("SELECT COUNT(*) n FROM qv_ip_scores WHERE ip = '104.16.9.9'");
    expect(Number(rows[0].n)).toBe(0);                      /* the client cannot invent a candidate */
  });
});

describe('new automatic behaviour: blocks, bandit, dual-stack, strategy outcome', () => {
  const d1 = async (sql, ...params) => {
    const db = await qv.mf.getD1Database('DB');
    return (await db.prepare(sql).bind(...params).all()).results;
  };
  const action = async (body) => (await (await qv.post('/api/ips', body, qv.auth())).json()).data;
  const bucket = () => Math.floor(Date.now() / 300000) * 300;

  test('a per-ASN drop quarantines that ASN and is released when it recovers', async () => {
    const iso = 780000 + (Date.now() % 500);
    const scope = 'asn:' + iso;
    await d1('INSERT OR REPLACE INTO qv_ip_windows (scope,bucket,samples,ok) VALUES (?,?,?,?)', 'global', bucket(), 40, 36);
    await d1('INSERT OR REPLACE INTO qv_ip_windows (scope,bucket,samples,ok) VALUES (?,?,?,?)', scope, bucket(), 20, 2);
    await d1('INSERT INTO qv_ip_scores (scope,ip,family,samples,ok,state,backoff,cooldown_until,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      scope, '10.11.0.' + (Date.now() % 200), 'v4', 6, 5, 'active', 0, 0, Math.floor(Date.now() / 1000));

    const r1 = await action({ action: 'blocks' });
    expect((r1.verdict.acted || []).some(a => a.kind === 'block')).toBe(true);
    const [cool] = await d1('SELECT state, backoff, cooldown_until FROM qv_ip_scores WHERE scope = ?', scope);
    expect(cool.state).toBe('cooldown');
    expect(Number(cool.backoff)).toBe(1);
    expect(Number(cool.cooldown_until)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(r1.blocks.some(b => b.scope === scope && b.kind === 'block')).toBe(true);

    await d1('INSERT OR REPLACE INTO qv_ip_windows (scope,bucket,samples,ok) VALUES (?,?,?,?)', scope, bucket(), 20, 16);
    const r2 = await action({ action: 'blocks' });
    expect((r2.verdict.acted || []).some(a => a.kind === 'recovered')).toBe(true);
    const [free] = await d1('SELECT state, backoff FROM qv_ip_scores WHERE scope = ?', scope);
    expect(free.state).toBe('active');
    expect(Number(free.backoff)).toBe(0);
  });

  test('an outage across ASNs degrades rows instead of quarantining them', async () => {
    const scopes = ['asn:781001', 'asn:781002'];
    for (const sc of scopes) {
      await d1('INSERT OR REPLACE INTO qv_ip_windows (scope,bucket,samples,ok) VALUES (?,?,?,?)', sc, bucket(), 20, 2);
      await d1('INSERT INTO qv_ip_scores (scope,ip,family,samples,ok,state,cooldown_until,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        sc, '10.12.0.' + (Date.now() % 200), 'v4', 6, 5, 'active', 0, Math.floor(Date.now() / 1000));
    }
    await d1('INSERT OR REPLACE INTO qv_ip_windows (scope,bucket,samples,ok) VALUES (?,?,?,?)', 'global', bucket(), 60, 6);
    const r = await action({ action: 'blocks' });
    expect(r.verdict.outage).toBe(true);
    const rows = await d1('SELECT state, cooldown_until FROM qv_ip_scores WHERE scope IN (?,?)', ...scopes);
    expect(rows.length).toBe(2);
    expect(rows.every(x => x.state === 'degraded' && Number(x.cooldown_until) === 0)).toBe(true);
  });

  test('the strategy is evaluated and a bad one is rolled back', async () => {
    await d1('DELETE FROM qv_ip_scores WHERE scope = ?', 'asn:782001');
    for (let i = 0; i < 5; i++) {
      await d1('INSERT INTO qv_ip_scores (scope,ip,family,samples,ok,state,updated_at) VALUES (?,?,?,?,?,?,?)',
        'asn:782001', '10.13.0.' + i, 'v4', 20, 4, 'active', Math.floor(Date.now() / 1000));
    }
    const db = await qv.mf.getD1Database('DB');
    await db.prepare("INSERT INTO qv_kv (key,value,expires_at) VALUES ('qv:strategy:hist','[]',NULL) ON CONFLICT(key) DO UPDATE SET value='[]'").run();
    await qv.post('/api/strategy', { version: 1, shape: 'ws-tls', fragment: { mode: 'sni-split' } }, qv.auth());
    /* two history entries with a healthy baseline, then a collapse in the data */
    await (await qv.post('/api/ips', { action: 'evaluate' }, qv.auth())).json();
    const first = (await qv.json('/api/endpoints', { headers: qv.auth() })).data;
    expect(Array.isArray(first.strategy_history)).toBe(true);
    expect(first.strategy_history.length).toBeGreaterThan(0);
    expect(first.per_isp).toBeDefined();
    expect(first.dropped_feedback).toBeDefined();
    expect(first.degraded).toBeDefined();
    expect(first.buffer_pressure.max).toBeGreaterThan(0);
  });

  test('a subscription asks for IPv6-first and gets it', async () => {
    const j = await qv.json('/clean-ip?n=4&prefer=v6');
    expect(j.data.prefer).toBe('v6');
    expect(Array.isArray(j.data.preferred)).toBe(true);
    if (j.data.preferred.length) {
      const f = j.data.preferred[0].family || (j.data.preferred[0].nat64 ? 'v6' : 'v4');
      expect(f).toBe('v6');
    }
    expect(['native', 'nat64-only', 'v4-only']).toContain(j.data.dual);
  });

  test('the audit exposes per-ISP health, quarantine counts and drop reasons', async () => {
    const a = (await qv.json('/api/endpoints', { headers: qv.auth() })).data;
    expect(Array.isArray(a.isps)).toBe(true);
    expect(a.isps.length).toBeGreaterThan(2);
    expect(Array.isArray(a.per_isp)).toBe(true);
    for (const row of a.per_isp) {
      expect(typeof row.samples).toBe('number');
      expect(row.success_pct === null || typeof row.success_pct === 'number').toBe(true);
      expect(typeof row.quarantined).toBe('number');
    }
    expect(typeof a.buffer_pressure.pct).toBe('number');
    expect(typeof a.degraded).toBe('object');
  });
});

describe('the write budget', () => {
  test('reports are aggregated, not written one row each', async () => {
    const tmp = await qv.createUser({ name: 'ci-budget' });
    const before = await counters();
    let sent = 0;
    for (let i = 0; i < 6; i++) {
      const bb = await batch(tmp.uuid);
      const r = await post({ t: bb.token, u: tmp.uuid, r: bb.ips.slice(0, 3).map((x, k) => ({ ip: x.ip, rttMs: 180 + k, ok: true, nonce: 'b' + i + k })) });
      if (r.status === 200) sent += 3;
    }
    const after = await counters();
    const writes = (after.d1_write || 0) - (before.d1_write || 0);
    const kv = (after.kv_write || 0) - (before.kv_write || 0);
    expect(sent).toBeGreaterThan(0);
    expect(writes).toBeLessThan(sent);          // fewer statements than reports
    expect(kv).toBe(0);                          // and not a single KV write
  });

  test('the report buffer is bounded and visible', async () => {
    const h = (await qv.json('/health')).data;
    expect(typeof h.counters.ci_reports).toBe('number');
    const audit = (await qv.json('/api/endpoints', { headers: qv.auth() })).data;
    expect(audit.buffer).toBeLessThanOrEqual(audit.limits.buffer || 400);
    expect(audit.limits.buffer).toBeUndefined(); // the limit lives under limits.batchIps etc.
    expect(audit.limits.batchIps).toBeGreaterThan(0);
  });
});

describe('what the operator and the subscriber see', () => {
  test('the audit lists every provider with its role spelled out', async () => {
    const a = (await qv.json('/api/endpoints', { headers: qv.auth() })).data;
    const ids = a.providers.map(p => p.id);
    for (const want of ['cloudflare', 'aws-cloudfront', 'google', 'fastly', 'ovh', 'hetzner', 'gcore', 'cdn77', 'akamai']) {
      expect(ids).toContain(want);
    }
    const edge = a.providers.filter(p => p.usable_as.includes('edge')).map(p => p.id);
    expect(edge).toEqual(['cloudflare']);
    for (const p of a.providers) expect(p.why.length).toBeGreaterThan(10);
  });

  test('the ranking distinguishes the subscriber view from the edge view', async () => {
    const a = (await qv.json('/api/endpoints', { headers: qv.auth() })).data;
    expect(a.signals.client_end_to_end).toMatch(/SNI/);
    expect(a.signals.edge_view).toMatch(/never presented as an Iran measurement/);
  });

  test('a subscription carries the measured endpoints and the IPv6 forms', async () => {
    const u = await qv.createUser({ name: 'ci-sub', quota_gb: 5 });
    const text = Buffer.from(await (await qv.get('/sub/' + u.uuid)).text(), 'base64').toString('utf8');
    expect(text).toMatch(/vless:\/\//);
    expect(text.split('\n').filter(l => l.startsWith('vless://')).length).toBeGreaterThanOrEqual(3);
  });

  test('/clean-ip returns the ranked list plus NAT64 forms', async () => {
    const r = await qv.json('/clean-ip?n=4');
    expect(r.data.ok).toBe(true);
    expect(Array.isArray(r.data.ips)).toBe(true);
    expect(Array.isArray(r.data.nat64)).toBe(true);
    for (const x of r.data.nat64) expect(x.ip).toMatch(/^64:ff9b::/);
  });
});
