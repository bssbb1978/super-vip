/* Empirical verification of the hardening pass, against the built artifact. */
import { boot } from './tests/helpers.mjs';

const qv = await boot();
const A = qv.auth();
const u = (await qv.createUser({ name: 'fixcheck', quota_gb: 2 })).uuid;

/* ── 1. D1 bound-parameter limit (the bug that silently reset every counter) ── */
const db = await qv.mf.getD1Database('DB');
for (const pairs of [40, 50, 60]) {
  const where = Array.from({ length: pairs }, () => '(scope = ? AND ip = ?)').join(' OR ');
  const params = Array.from({ length: pairs }, (_, i) => ['global', '10.0.0.' + i]).flat();
  try {
    await db.prepare('SELECT 1 FROM qv_ip_scores WHERE ' + where).bind(...params).all();
    console.log('D1 params=' + params.length + ' (' + pairs + ' rows): OK');
  } catch (e) {
    console.log('D1 params=' + params.length + ' (' + pairs + ' rows): ERROR ' + String(e.message).slice(0, 70));
  }
}

/* ── 2. cold-isolate simulation: wipe every isolate cache, keep the token ── */
const b = (await qv.json('/api/ip-batch?u=' + u)).data;
const wipe = await qv.del('/api/cache', A);
console.log('cache wipe:', wipe.status, JSON.stringify((await wipe.json()).data || {}));
const foreign = '104.16.9.9';                      // a Cloudflare address we never handed out
const legal = b.ips[0].ip;                         // one we did hand out (now only in the signed token)
const r = await qv.post('/api/ip-report', {
  t: b.token, u, f: b.ips[0].family,
  r: [
    { ip: foreign, family: 'v4', rttMs: 120, ok: true, tlsOk: true, wsOk: true, nonce: 'fx1' },
    { ip: legal, family: b.ips[0].family, rttMs: 130, ok: true, tlsOk: true, wsOk: true, nonce: 'fx2' },
  ],
});
console.log('off-cache report:', r.status, JSON.stringify(await r.json()));

/* ── 3. accumulation: two flushes of the same key must add, not reset ─────── */
for (const id of ['a1', 'a2']) await qv.post('/api/ips', { action: 'feedback', host: 'acc.example.dev', ok: true, uuid: id }, A);
console.log('flush 1:', JSON.stringify((await (await qv.post('/api/ips', { action: 'flush' }, A)).json()).data));
const row1 = (await db.prepare("SELECT samples, ok, last_probe FROM qv_ip_scores WHERE ip = ? AND family = 'host'").bind('acc.example.dev').all()).results[0];
await qv.post('/api/ips', { action: 'feedback', host: 'acc.example.dev', ok: true, uuid: 'a3' }, A);
console.log('flush 2:', JSON.stringify((await (await qv.post('/api/ips', { action: 'flush' }, A)).json()).data));
const row2 = (await db.prepare("SELECT samples, ok FROM qv_ip_scores WHERE ip = ? AND family = 'host'").bind('acc.example.dev').all()).results[0];
console.log('accumulation:', JSON.stringify(row1), '→', JSON.stringify(row2));

/* ── 4. tunnel feedback wiring: a real upgrade feeds the host scope ───────── */
const up = await qv.get('/ws', { headers: { upgrade: 'websocket', host: 'node.example.dev', 'cf-connecting-ip': '5.5.5.5' } });
console.log('ws upgrade status:', up.status);
await qv.post('/api/ips', { action: 'flush' }, A);
const hostRows = (await db.prepare("SELECT ip, scope, provider, samples, ws_ok FROM qv_ip_scores WHERE ip LIKE 'node%example.dev'").all()).results;
console.log('tunnel-feedback rows:', JSON.stringify(hostRows));

await qv.dispose();
