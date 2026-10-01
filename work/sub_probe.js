const { Miniflare, Log, LogLevel } = require('miniflare');
(async () => {
  const mf = new Miniflare({
    modules: true, scriptPath: 'dist/worker.js', compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'd' }, kvNamespaces: { KVU_KV: 'k' },
    bindings: { ADMIN_PASSWORD: 'p', API_SECRET_TOKEN: 't0k', CUSTOM_DOMAIN: 'edge.example.com' },
    log: new Log(LogLevel.ERROR),
  });
  const H = { 'x-api-token': 't0k', 'content-type': 'application/json' };
  await mf.dispatchFetch('http://localhost/health');
  const c = await mf.dispatchFetch('http://localhost/api/users', { method: 'POST', headers: H, body: JSON.stringify({ name: 'sp', quota_gb: 5, days: 30 }) });
  const uuid = (await c.json())?.data?.item?.uuid;
  for (const q of ['?format=uris', '?target=clash', '?format=singbox', '']) {
    const r = await mf.dispatchFetch('http://localhost/sub/' + uuid + q);
    const t = await r.text();
    console.log('sub' + (q || '(base64)'), r.status, 'len=' + t.length, JSON.stringify(t.slice(0, 150)));
  }
  const host = await mf.dispatchFetch('http://edge.example.com/sub/' + uuid + '?format=uris');
  console.log('via-host', host.status, (await host.text()).slice(0, 200));
  await mf.dispose();
})();
