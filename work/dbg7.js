const { Miniflare, Log, LogLevel } = require('miniflare');
const script = process.argv[2] || 'dist/worker.js';
(async () => {
  const mf = new Miniflare({
    modules: true, scriptPath: script, compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'd' }, kvNamespaces: { KVU_KV: 'k' },
    bindings: { ADMIN_PASSWORD: 'p', API_SECRET_TOKEN: 't0k', TELEGRAM_WEBHOOK_SECRET: 's', CUSTOM_DOMAIN: 'example.workers.dev' },
    log: new Log(LogLevel.ERROR),
  });
  const H = { 'x-api-token': 't0k', 'content-type': 'application/json' };
  await mf.dispatchFetch('http://localhost/health');
  const created = await mf.dispatchFetch('http://localhost/api/users', { method: 'POST', headers: H, body: JSON.stringify({ name: 'dbg', quota_gb: 10, days: 30 }) });
  const cj = await created.json();
  const uuid = cj?.data?.item?.uuid;
  console.log('create', created.status, uuid, JSON.stringify(cj).slice(0, 300));
  if (uuid) {
    const sub = await mf.dispatchFetch('http://localhost/sub/' + uuid);
    const body = await sub.text();
    console.log('sub', sub.status, body.length, JSON.stringify(body.slice(0, 200)));
    const clash = await mf.dispatchFetch('http://localhost/sub/' + uuid + '?target=clash');
    console.log('clash', clash.status, (await clash.text()).slice(0, 160).replace(/\n/g, ' | '));
  }
  const admin = await mf.dispatchFetch('http://localhost/admin', { headers: H });
  const at = await admin.text();
  console.log('admin', admin.status, at.slice(0, 120).replace(/\n/g, ' '));
  const dns = await mf.dispatchFetch('http://localhost/dns-query?name=example.com&type=A');
  console.log('doh-json', dns.status, (await dns.text()).slice(0, 160));
  // base64url variant
  const bin = Buffer.from([0xbe, 0xef, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7, 101, 120, 97, 109, 112, 108, 101, 3, 99, 111, 109, 0, 0, 1, 0, 1]);
  const url = 'http://localhost/dns-query?dns=' + bin.toString('base64url').replace(/=/g, '');
  const d2 = await mf.dispatchFetch(url, { headers: { accept: 'application/dns-message' } });
  const ab = await d2.arrayBuffer();
  console.log('doh-wire', d2.status, 'bytes=' + ab.byteLength, 'type=' + d2.headers.get('content-type'));
  await mf.dispose();
})();
