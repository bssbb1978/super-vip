const { Miniflare, Log, LogLevel } = require('miniflare');
(async () => {
  const mf = new Miniflare({ modules: true, scriptPath: 'dist/core-only.js', compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'd' }, bindings: { ADMIN_PASSWORD: 'p', DOMAIN: 'e.example' }, log: new Log(LogLevel.ERROR) });
  const t = (await (await mf.dispatchFetch('http://x/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'p' }) })).json()).token;
  const H = { 'x-api-token': t };
  console.log('dns json:', (await (await mf.dispatchFetch('http://x/dns/json?name=cloudflare.com')).text()).slice(0, 200));
  console.log('dns api :', (await (await mf.dispatchFetch('http://x/api/dns?name=cloudflare.com', { headers: H })).text()).slice(0, 200));
  const st = await (await mf.dispatchFetch('http://x/api/selftest', { headers: H })).json();
  for (const r of st.selfcheck.results.filter(r => r.status === 'fail')) console.log('FAIL', r.group + '/' + r.name, '→', r.detail);
  await mf.dispose();
})();
