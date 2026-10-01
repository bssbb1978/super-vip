const { Miniflare, Log, LogLevel } = require('miniflare');
(async () => {
  const mf = new Miniflare({
    modules: true, scriptPath: 'dist/worker.js', compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'd' }, kvNamespaces: { KVU_KV: 'k' },
    bindings: { ADMIN_PASSWORD: 'test-pass', API_SECRET_TOKEN: 'test-api-token', TELEGRAM_WEBHOOK_SECRET: 'test-tg-secret', CUSTOM_DOMAIN: 'localhost', HOSTS: 'localhost' },
    log: new Log(LogLevel.ERROR),
  });
  const H = { 'x-api-token': 'test-api-token', 'content-type': 'application/json' };
  await mf.dispatchFetch('http://localhost/health');
  const c = await mf.dispatchFetch('http://localhost/api/users', { method: 'POST', headers: H, body: JSON.stringify({ name: 'sq', quota_gb: 10, days: 30 }) });
  const uuid = (await c.json())?.data?.item?.uuid;
  const seq = ['', '?target=clash', '?target=singbox', '', '', ''];
  for (const [i, q] of seq.entries()) {
    const r = await mf.dispatchFetch('http://localhost/sub/' + uuid + q);
    const t = await r.text();
    console.log(i, q || '(base64)', 'status=' + r.status, 'len=' + t.length, 'ui=' + JSON.stringify(r.headers.get('subscription-userinfo')), 'head=' + JSON.stringify(t.slice(0, 40)));
  }
  await mf.dispose();
})();
