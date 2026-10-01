import { Miniflare, Log, LogLevel } from 'miniflare';
const mf = new Miniflare({
  modules: true, scriptPath: './dist/worker.js', compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'qv-itest' }, kvNamespaces: { KVU_KV: 'qv-itest-kv' },
  bindings: { ADMIN_PASSWORD: 'test-admin-password', API_SECRET_TOKEN: 'test-api-token', CUSTOM_DOMAIN: 'node.example.dev' },
  log: new Log(LogLevel.INFO),
});
const base = 'http://node.example.dev';
const A = { 'x-api-token': 'test-api-token' };
const r = await mf.dispatchFetch(base + '/health'); await r.text();
const mk = await mf.dispatchFetch(base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json', ...A }, body: JSON.stringify({ name: 'dbg-user', quota_gb: 5 }) });
const u = (await mk.json()).data.item.uuid;
const rowAfter = async (l) => { const r = await mf.dispatchFetch(base + '/api/users/' + u, { headers: A }); const j = await r.json(); console.log('    row@' + l, 'ks=' + j.data.item.killswitch, 'en=' + j.data.item.enabled); };
const sub = async () => (await mf.dispatchFetch(base + '/sub/' + u)).status;
console.log('>>> fresh', await sub()); await rowAfter('fresh');
const k1 = await mf.dispatchFetch(base + '/api/users/' + u, { method: 'PATCH', headers: { 'content-type': 'application/json', ...A }, body: JSON.stringify({ killswitch: 1 }) });
await rowAfter('kill');
console.log('>>> kill', k1.status, (await k1.clone().text()).slice(0, 200), '-> sub', await sub());
const k2 = await mf.dispatchFetch(base + '/api/users/' + u, { method: 'PATCH', headers: { 'content-type': 'application/json', ...A }, body: JSON.stringify({ killswitch: 0 }) });
console.log('>>> revive', k2.status, (await k2.clone().text()).slice(0, 200), '-> sub', await sub());
await mf.dispose();
