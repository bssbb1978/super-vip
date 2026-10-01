/* Verification of the second hardening pass, against the built artifact. */
import { boot } from './tests/helpers.mjs';

const out = [];
const say = (k, v) => { out.push(k + ': ' + v); console.log(k + ': ' + v); };

/* ── 1. open issue 3a: no domain configured at all → drop is *visible* ────── */
{
  const qv = await boot({ HOSTS: '', CUSTOM_DOMAIN: '' });
  const A = qv.auth();
  const u = (await qv.createUser({ name: 'nohosts', quota_gb: 2 })).uuid;
  const r = await (await qv.post('/api/ips', { action: 'feedback', host: 'unconfigured.example.dev', ok: true }, A)).json();
  const c = (await qv.json('/health')).data.counters;
  say('no-hosts drop', JSON.stringify(r.data) + ' counter=' + (c.ci_feedback_dropped_nohosts || 0));
  const audit = (await qv.json('/api/endpoints', { headers: A })).data;
  say('audit drop reasons', JSON.stringify(audit.dropped_feedback).slice(0, 160));
  await qv.dispose();
}

/* ── 2. open issue 3b: CUSTOM_DOMAIN set → the request's own Host is accepted ─ */
{
  const qv = await boot({ HOSTS: '', CUSTOM_DOMAIN: 'node.example.dev' });
  const A = qv.auth();
  const u = (await qv.createUser({ name: 'owndom', quota_gb: 2 })).uuid;
  const port = Number(new URL(await qv.mf.ready).port);
  const hex = u.replace(/-/g, '');
  const f = new Uint8Array(26);
  f[0] = 0;
  for (let i = 0; i < 16; i++) f[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  f[17] = 0; f[18] = 1; f[19] = (port >> 8) & 0xff; f[20] = port & 0xff; f[21] = 1;
  f.set([127, 0, 0, 1], 22);
  const res = await qv.get('/ws/' + u, { headers: { upgrade: 'websocket', host: 'node.example.dev', 'cf-connecting-ip': '5.5.5.5' } });
  res.webSocket.accept();
  res.webSocket.send(f.buffer);
  await new Promise(r => setTimeout(r, 800));
  await qv.post('/api/ips', { action: 'flush' }, A);
  const db = await qv.mf.getD1Database('DB');
  const rows = (await db.prepare("SELECT ip, provider, samples FROM qv_ip_scores WHERE provider = 'tunnel'").all()).results;
  say('own-host accepted', JSON.stringify(rows));
  await qv.dispose();
}

/* ── 3. per-ISP view, dual-stack preference, audit observability ──────────── */
{
  const qv = await boot();
  const A = qv.auth();
  const u = (await qv.createUser({ name: 'v2', quota_gb: 3 })).uuid;
  const b = (await qv.json('/api/ip-batch?u=' + u)).data;
  const rep = { t: b.token, u, f: b.ips[0].family, r: b.ips.slice(0, 4).map((x, i) =>
    ({ ip: x.ip, family: x.family, rttMs: 150 + i * 10, ok: i !== 3, tlsOk: i !== 3, wsOk: i !== 3, nonce: 'v2-' + i })) };
  await qv.post('/api/ip-report', rep);
  await qv.post('/api/ips', { action: 'flush' }, A);
  const audit = (await qv.json('/api/endpoints', { headers: A })).data;
  say('per-ISP rows', JSON.stringify(audit.per_isp.slice(0, 3)));
  say('quarantine counts', JSON.stringify(audit.scopes));
  say('buffer pressure', JSON.stringify(audit.buffer_pressure) + ' blocks=' + audit.blocks.length + ' degraded=' + JSON.stringify(audit.degraded).slice(0, 90));
  const v6 = (await qv.json('/clean-ip?n=4&prefer=v6')).data;
  const v4 = (await qv.json('/clean-ip?n=4&prefer=v4')).data;
  say('prefer=v6 first', JSON.stringify(v6.preferred.slice(0, 1)) + ' dual=' + v6.dual);
  say('prefer=v4 first', JSON.stringify(v4.preferred.slice(0, 1)) + ' dual=' + v4.dual);
  const fl = await (await qv.post('/api/ips', { action: 'flush' }, A)).json();
  say('flush shape', JSON.stringify(fl.data));
  const win = (await (await qv.mf.getD1Database('DB')).prepare('SELECT COUNT(*) n, SUM(samples) s FROM qv_ip_windows').all()).results;
  say('windows table', JSON.stringify(win));
  const strat = await (await qv.post('/api/ips', { action: 'evaluate' }, A)).json();
  say('strategy evaluate', JSON.stringify(strat.data));
  await qv.dispose();
}
