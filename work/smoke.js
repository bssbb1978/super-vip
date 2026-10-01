#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * smoke.js — end-to-end acceptance test for the built worker
 *   node smoke.js dist/core-only.js        (or  node smoke.js ../worker.js)
 * Every check runs inside a real workerd isolate through miniflare with a real
 * D1 database, so this is the same code path Cloudflare will execute.
 * ═══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { Miniflare, Log, LogLevel } = require('miniflare');

const script = process.argv[2] || 'dist/core-only.js';
const ADMIN_PASSWORD = 'test-pass';
const API_TOKEN = 'test-api-token';
const TG_SECRET = 'test-tg-secret';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? ' — ' + String(detail).slice(0, 150) : ''));
};
const group = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 58 - t.length)));

(async () => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: script,
    compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'qv-test' },
    kvNamespaces: { KVU_KV: 'qv-kv' },
    bindings: {
      ADMIN_PASSWORD, API_SECRET_TOKEN: API_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET,
      CUSTOM_DOMAIN: 'localhost', HOSTS: 'localhost',
    },
    log: new Log(LogLevel.ERROR),
  });

  const base = 'http://localhost';
  const get = (p, init) => mf.dispatchFetch(base + p, init);
  const json = async (p, init) => { const r = await get(p, init); let j = null; try { j = await r.json(); } catch (e) {} return { r, j, data: j && j.data !== undefined ? j.data : j }; };
  const post = (p, body, headers = {}) => get(p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const patch = (p, body, headers = {}) => get(p, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const authed = (extra = {}) => ({ 'x-api-token': token, ...extra });

  let token = API_TOKEN;
  try {
    /* ═══════════════ boot & identity ═══════════════ */
    group('boot');
    const health = await json('/health');
    check('GET /health boots', health.r.status === 200 && health.j?.ok === true, 'v' + health.j?.version);
    check('bindings detected', health.j?.features?.d1 === true && health.j?.features?.kv === true, JSON.stringify(health.j?.features || {}).slice(0, 90));
    check('security headers present', !!health.r.headers.get('x-qv') && !!health.r.headers.get('server-timing'));

    const landing = await get('/');
    const landText = await landing.text();
    check('GET / is a neutral landing page', landing.status === 200 && /private service node/i.test(landText));
    check('landing reveals nothing (no vless/ss/host tokens)', !/vless|shadowsocks|uuid|proxy/i.test(landText));

    const unknown = await json('/this-path-does-not-exist');
    check('unknown path answers a decoy, not a 404 page', unknown.r.status === 200 && unknown.j?.ok !== false);

    /* ═══════════════ auth ladder ═══════════════ */
    group('auth');
    const badLogin = await post('/api/login', { password: 'wrong' });
    check('login rejects a bad password', badLogin.status === 401);
    const goodLogin = await get('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN_PASSWORD }) });
    const lj = await goodLogin.json();
    check('login accepts the admin password', goodLogin.status === 200 && !!lj.data?.token, 'cookie=' + !!goodLogin.headers.get('set-cookie'));
    const session = lj.data.token;
    check('session cookie is HttpOnly+Secure', /HttpOnly/i.test(goodLogin.headers.get('set-cookie') || '') && /Secure/i.test(goodLogin.headers.get('set-cookie') || ''));

    check('anonymous /api/stats is refused', (await get('/api/stats')).status === 401);
    const asToken = await json('/api/stats', { headers: { 'x-api-token': API_TOKEN } });
    check('api token grants admin', asToken.r.status === 200 && asToken.data.users_total >= 1, 'users=' + asToken.data?.users_total);
    const asSession = await json('/api/stats', { headers: { cookie: 'qv_sid=' + session } });
    check('session cookie grants admin', asSession.r.status === 200);
    const me = await json('/api/me', { headers: { 'x-api-token': API_TOKEN } });
    check('/api/me identifies the role', me.data?.role === 'admin', me.data?.via);

    /* ═══════════════ users, quota, cut-off ═══════════════ */
    group('users & quota');
    const created = await json('/api/users', { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ name: 'smoke-user', quota_gb: 10, days: 30 }) });
    const uuid = created.data?.item?.uuid;
    check('POST /api/users creates an account', created.r.status === 200 && !!uuid, 'uuid=' + String(uuid).slice(0, 8));
    check('quota stored as 10 GiB', created.data?.item?.quota_bytes === 10737418240, created.data?.item?.quota_bytes);

    const list = await json('/api/users', { headers: authed() });
    check('GET /api/users lists it', (list.data?.items || []).some(u => u.uuid === uuid));

    const sub = await get('/sub/' + uuid);
    const subBody = await sub.text();
    check('GET /sub/:uuid returns configs', sub.status === 200 && subBody.length > 100, subBody.length + ' bytes');
    const decoded = Buffer.from(subBody.replace(/\s/g, ''), 'base64').toString('utf8');
    check('subscription carries vless + shadowsocks nodes', decoded.includes('vless://') && decoded.includes('ss://'), decoded.split('\n').length + ' nodes');
    check('subscription carries 2022 SS with per-user key', decoded.includes('2022-blake3-chacha20-poly1305'));
    const clash = await get('/sub/' + uuid + '?target=clash');
    const clashText = await clash.text();
    check('Clash profile generated', clash.status === 200 && clashText.includes('proxies:') && clashText.includes('ws-opts'), clashText.split('\n').length + ' lines');
    const singbox = await get('/sub/' + uuid + '?target=singbox');
    const sbox = await singbox.text();
    let sboxJson = null; try { sboxJson = JSON.parse(sbox); } catch (e) {}
    check('sing-box profile is valid JSON with fragment hints', !!sboxJson && JSON.stringify(sboxJson).includes('fragment'));
    /* the header name is fixed; the *value* must carry the quota counters */
    const uiHeader = (await get('/sub/' + uuid)).headers.get('subscription-userinfo') || '';
    check('subscription header carries userinfo', /upload=\d+/.test(uiHeader) && /total=\d+/.test(uiHeader), uiHeader);

    await patch('/api/users/' + uuid, { killswitch: 1 }, authed({ 'content-type': 'application/json' }));
    const cut = await get('/sub/' + uuid);
    check('cut-off account gets no configs', cut.status === 403, 'status=' + cut.status);
    await patch('/api/users/' + uuid, { killswitch: 0 }, authed({ 'content-type': 'application/json' }));
    check('revived account gets configs again', (await get('/sub/' + uuid)).status === 200);

    const quota = await json('/api/users/' + uuid, { method: 'PATCH', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ quota_gb: 25 }) });
    check('quota can be raised per user', quota.data?.item?.quota_bytes === 25 * 1073741824, quota.data?.item?.quota_bytes);

    /* ═══════════════ QR + client aids ═══════════════ */
    group('client aids');
    const qr = await get('/qr?d=' + encodeURIComponent('vless://x@y:443') + '&s=4');
    const qrText = await qr.text();
    check('GET /qr renders an SVG', qr.status === 200 && qrText.startsWith('<svg') && qrText.length > 500, qrText.length + ' bytes');
    const frag = await json('/fragment', { headers: { 'cf-ipcountry': 'IR' } });
    check('GET /fragment returns a fragment profile', !!frag.data?.profile?.mode || !!frag.data?.profile?.payload, JSON.stringify(frag.data?.profile || {}).slice(0, 70));
    const ips = await json('/clean-ip');
    check('GET /clean-ip lists candidates', (ips.data?.ips || []).length >= 3, (ips.data?.ips || []).length + ' ips');

    /* ═══════════════ DNS: DoH, JSON, tunnel, NAT64 ═══════════════ */
    group('dns');
    const dj = await json('/dns/json?name=cloudflare.com&type=A');
    const answers = dj.data?.answers || [];
    check('GET /dns/json resolves A', dj.r.status === 200 && answers.length > 0, answers.map(a => a.value).join(',') || dj.j?.error);
    check('answer came through an upstream (not poison-guarded to a sink)', !/^(0\.0\.0\.0|127\.0\.0\.1)$/.test(answers[0]?.value || ''), dj.data?.source);

    const wireQuery = buildQuery('cloudflare.com', 1);
    const dohPost = await get('/dns-query', { method: 'POST', headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' }, body: wireQuery });
    const wireRes = new Uint8Array(await dohPost.arrayBuffer());
    check('POST /dns-query speaks RFC 8484', dohPost.status === 200 && wireRes.length > 12 && /dns-message/.test(dohPost.headers.get('content-type') || ''), wireRes.length + ' bytes, upstream=' + dohPost.headers.get('x-qv-upstream'));
    const dohGet = await get('/dns-query?dns=' + toB64url(wireQuery) + '&format=json');
    const dohGetJson = await dohGet.json().catch(() => null);
    check('GET /dns-query (base64url) answers', dohGet.status === 200 && (dohGetJson?.Answer || []).length > 0, (dohGetJson?.Answer || []).length + ' answers');

    const nat64Json = await json('/dns/json?name=ipv4only.arpa&type=AAAA&dns64=1');
    const aaaa = (nat64Json.data?.answers || []).filter(a => a.type === 'AAAA');
    check('DNS64 synthesises AAAA in 64:ff9b::/96', aaaa.length > 0 && aaaa[0].value.startsWith('64:ff9b::'), aaaa[0]?.value || JSON.stringify(nat64Json.data || {}).slice(0, 90));

    const framed = frameTcp(wireQuery);
    const tunnel = await get('/dns/tcp', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: framed });
    const tunnelBytes = new Uint8Array(await tunnel.arrayBuffer());
    check('POST /dns/tcp answers length-framed DNS', tunnel.status === 200 && tunnelBytes.length > 14 && ((tunnelBytes[0] << 8) | tunnelBytes[1]) === tunnelBytes.length - 2, tunnelBytes.length + ' bytes');
    const dnsStats = await json('/api/dns', { headers: authed() });
    check('GET /api/dns reports resolver state', (dnsStats.data?.upstreams || []).length >= 3 && dnsStats.data?.tcp53_available === false, (dnsStats.data?.upstreams || []).length + ' upstreams');

    /* ═══════════════ anti-DPI ═══════════════ */
    group('anti-dpi');
    const strategy = await json('/api/strategy', { headers: authed() });
    check('GET /api/strategy has a shape + fragment', !!strategy.data?.active_shape && !!strategy.data?.fragment, strategy.data?.active_shape);
    const before = strategy.data?.generation;
    const saved = await json('/api/strategy', { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ strict: true, fragment: { mode: 'fixed', size: 16, interval: 6 } }) });
    check('POST /api/strategy persists and bumps the generation', saved.data?.generation > before && saved.data?.strict === true, `${before} → ${saved.data?.generation}`);
    const sni = await json('/api/sni', { headers: authed() });
    check('GET /api/sni returns a seeded pool', (sni.data?.items || []).length >= 5, (sni.data?.items || []).length + ' SNI');
    const ipList = await json('/api/ips', { headers: authed() });
    check('GET /api/ips returns candidates', (ipList.data?.items || []).length >= 3, (ipList.data?.items || []).length + ' ips');
    const probe = await get('/ws');
    check('plain GET on a tunnel path is tarpitted, not answered truthfully', probe.status === 200 || probe.status === 404, 'status=' + probe.status);

    /* ═══════════════ AI ═══════════════ */
    group('ai');
    const ai = await json('/api/ai', { headers: authed() });
    check('GET /api/ai exposes a live model choice', !!ai.data?.active_model && (ai.data?.ranking || []).length > 3, ai.data?.active_model);

    /* ═══════════════ ops: cron, events, selftest, backup ═══════════════ */
    group('ops');
    const cron = await json('/api/cron', { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ only: 'session-gc' }) });
    check('POST /api/cron runs a scheduled task', cron.data?.ran === 1 && !!cron.data.results['session-gc'], JSON.stringify(cron.data?.results || {}).slice(0, 70));
    const events = await json('/api/events?limit=5', { headers: authed() });
    check('GET /api/events returns the audit trail', (events.data?.items || []).length > 0, (events.data?.items || []).length + ' events');
    const selftest = await json('/api/selftest?full=1', { headers: authed() });
    check('self-test suite passes in production', selftest.data?.ok === true, selftest.data?.summary + ' failed=' + JSON.stringify(selftest.data?.failed || []));
    const backup = await json('/api/backup', { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: '{}' });
    check('backup exports the database', !!backup.data?.tables && (backup.data.stats?.qv_users ?? -1) >= 1, JSON.stringify(backup.data?.stats || {}).slice(0, 90));
    const metrics = await json('/api/metrics', { headers: authed() });
    check('metrics snapshot is served', !!metrics.data);

    /* ═══════════════ panels ═══════════════ */
    group('panels');
    const admin = await get('/admin', { headers: { cookie: 'qv_sid=' + session } });
    const adminHtml = await admin.text();
    check('GET /admin renders the console', admin.status === 200 && adminHtml.includes('id="view"') && adminHtml.length > 8000, adminHtml.length + ' bytes');
    check('console ships no external assets', !/src="https?:|href="https?:/.test(adminHtml));
    const panel = await get('/me?uuid=' + uuid);
    const panelHtml = await panel.text();
    check('GET /me renders the user panel', panel.status === 200 && panelHtml.includes(uuid.slice(0, 8)), panelHtml.length + ' bytes');

    /* ═══════════════ telegram ═══════════════ */
    group('telegram');
    const tgBad = await get('/tg/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('/tg/webhook without a token is refused', tgBad.status === 503 || tgBad.status === 403, 'status=' + tgBad.status);
    const tgWrong = await get('/tg/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'nope', 'x-qv-test': '1' }, body: JSON.stringify({ update_id: 1, message: { chat: { id: 1 }, text: '/start' } }) });
    check('/tg/webhook rejects a wrong secret token', tgWrong.status === 403 || tgWrong.status === 503, 'status=' + tgWrong.status);

    /* ═══════════════ ws upgrade ═══════════════ */
    group('transports');
    const upgrade = await get('/ws', { headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
    check('WS upgrade on a tunnel path is accepted', upgrade.status === 101, 'status=' + upgrade.status);
    const ssPlain = await get('/ss');
    check('SS endpoint answers nothing useful to a plain GET', ssPlain.status === 200 || ssPlain.status === 404, 'status=' + ssPlain.status);

    /* ═══════════════ build surface ═══════════════ */
    group('bundle');
    const src = fs.readFileSync(path.resolve(script), 'utf8');
    check('default export carries fetch/scheduled/queue', /export default __QV_HANDLER/.test(src) && /async scheduled\(/.test(src) && /async queue\(/.test(src));
    check('Pages onRequest aliases exported', /export const onRequest\b/.test(src) && /export const onRequestGet/.test(src));
    check('no export named fetch (would shadow the global)', !/^export const fetch/m.test(src) && !/^export \{ fetch \}/m.test(src));
    check('Durable Object class exported', /export class QVRelay/.test(src));
    check('no forbidden naming in user-visible strings', !/quantum[- ]?veil[^\n]*\b(vpn|proxy)\b/i.test(src));

    await mf.dispose();
  } catch (e) {
    check('unexpected failure — ' + (e && e.message), false, (e && e.stack || '').split('\n')[1]);
    try { await mf.dispose(); } catch (err) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n' + (failed.length ? '❌' : '✅') + ` ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('failed: ' + failed.map(f => f.name).join(' | ')); process.exitCode = 1; }
})();

/* ── tiny DNS helpers so the test does not depend on core internals ─────── */
function buildQuery(name, type = 1) {
  const parts = [name.split('.').map(l => [l.length, l])];
  const labels = name.split('.').flatMap(l => [l.length, ...Buffer.from(l)]);
  const buf = Buffer.alloc(12 + labels.length + 1 + 4);
  buf.writeUInt16BE(0x4242, 0); buf.writeUInt16BE(0x0100, 2); buf.writeUInt16BE(1, 4);
  let off = 12;
  for (const b of labels) buf[off++] = b;
  buf[off++] = 0;
  buf.writeUInt16BE(type, off); off += 2;
  buf.writeUInt16BE(1, off);
  void parts;
  return new Uint8Array(buf);
}
function frameTcp(wire) { const out = new Uint8Array(wire.length + 2); out[0] = wire.length >> 8; out[1] = wire.length & 0xff; out.set(wire, 2); return out; }
function toB64url(u8) { return Buffer.from(u8).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
