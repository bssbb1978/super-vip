const { Miniflare, Log, LogLevel } = require('miniflare');
(async () => {
  const mf = new Miniflare({ modules: true, scriptPath: 'dist/core-only.js', compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'd' }, kvNamespaces: { KVU_KV: 'k' },
    bindings: { ADMIN_PASSWORD: 'p', API_SECRET_TOKEN: 't0k', TELEGRAM_BOT_TOKEN: '123:abc', ADMIN_TELEGRAM_ID: '9' }, log: new Log(LogLevel.ERROR) });
  const H = { 'x-api-token': 't0k', 'content-type': 'application/json' };
  const show = async (p, init) => { const r = await mf.dispatchFetch('http://localhost' + p, init); const t = await r.text(); console.log('---', (init&&init.method||'GET'), p, r.status, '|', t.slice(0, 300).replace(/\n/g,' ')); return t; };
  await show('/api/users', { method: 'POST', headers: H, body: JSON.stringify({ name: 'dbg', quota_gb: 5 }) });
  await show('/api/dns', { headers: H });
  await show('/api/strategy', { headers: H });
  await show('/api/strategy', { method: 'POST', headers: H, body: JSON.stringify({ strict: true }) });
  await show('/api/ai', { headers: H });
  await show('/api/selftest?full=1', { headers: H });
  await mf.dispose();
})();
