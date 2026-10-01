const { Miniflare, Log, LogLevel } = require('miniflare');
(async () => {
  const mf = new Miniflare({ modules: true, scriptPath: 'dist/core-only.js', compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'd' }, kvNamespaces: { KV: 'k' }, bindings: { ADMIN_PASSWORD: 'p', DOMAIN: 'e.example' }, log: new Log(LogLevel.ERROR) });
  const t = (await (await mf.dispatchFetch('http://x/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'p' }) })).json()).token;
  const H = { 'x-api-token': t, 'content-type': 'application/json' };
  for (const [m, p, b] of [['GET', '/api/stats'], ['POST', '/api/users', JSON.stringify({ uuid: 'u1', quotaGb: 5 })], ['GET', '/api/users'], ['GET', '/admin']]) {
    const r = await mf.dispatchFetch('http://x' + p, { method: m, headers: H, body: b });
    const body = (await r.text()).slice(0, 400);
    console.log('\n===', m, p, '→', r.status, '\n', body.replace(/\n/g, ' ').slice(0, 380));
  }
  await mf.dispose();
})();
