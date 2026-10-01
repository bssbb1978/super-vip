const { Miniflare, Log, LogLevel } = require('miniflare');
(async () => {
  const mf = new Miniflare({
    modules: true, scriptPath: 'dist/worker.js', compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'd' }, kvNamespaces: { KVU_KV: 'k' },
    bindings: { ADMIN_PASSWORD: 'p', API_SECRET_TOKEN: 't0k' }, log: new Log(LogLevel.ERROR),
  });
  const H = { 'x-api-token': 't0k', 'content-type': 'application/json' };
  await mf.dispatchFetch('http://localhost/health');
  const c = await mf.dispatchFetch('http://localhost/api/users', { method: 'POST', headers: H, body: JSON.stringify({ name: 'ap', quota_gb: 10, days: 30 }) });
  const uuid = (await c.json())?.data?.item?.uuid;
  const p = await mf.dispatchFetch('http://localhost/api/users/' + uuid, { method: 'PATCH', headers: H, body: JSON.stringify({ quota_gb: 25 }) });
  const pj = await p.json();
  console.log('PATCH', p.status, JSON.stringify(pj).slice(0, 300));
  const s = await mf.dispatchFetch('http://localhost/sub/' + uuid);
  console.log('sub status', s.status, 'userinfo=', JSON.stringify(s.headers.get('subscription-userinfo')), 'len', (await s.text()).length);
  console.log('all headers:', [...s.headers.entries()].map(([k, v]) => k + '=' + String(v).slice(0, 40)).join(' | '));
  const login = await mf.dispatchFetch('http://localhost/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'p' }) });
  const lj = await login.json();
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  console.log('login', login.status, 'cookie', cookie.slice(0, 20), 'token', String(lj.data && lj.data.token).slice(0, 8));
  const admin = await mf.dispatchFetch('http://localhost/admin', { headers: { cookie } });
  const at = await admin.text();
  console.log('admin', admin.status, at.length, JSON.stringify(at.slice(0, 80)));
  await mf.dispose();
})();
