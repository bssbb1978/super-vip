const { Miniflare, Log, LogLevel } = require('miniflare');
(async () => {
  const mf = new Miniflare({ modules: true, scriptPath: 'dist/core-only.js', compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'd' }, kvNamespaces: { KVU_KV: 'k' },
    bindings: { ADMIN_PASSWORD: 'p', API_SECRET_TOKEN: 't0k', CUSTOM_DOMAIN: 'localhost' }, log: new Log(LogLevel.WARN) });
  const show = async (p, init) => { const r = await mf.dispatchFetch('http://localhost' + p, init); const t = await r.text(); console.log('---', p, r.status, '|', t.slice(0, 220).replace(/\n/g, ' ')); };
  await show('/health');
  await show('/api/me', { headers: { 'x-api-token': 't0k' } });
  await show('/api/stats', { headers: { 'x-api-token': 't0k' } });
  await show('/qr?d=test');
  await show('/ws');
  await show('/tg/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await mf.dispose();
})();
