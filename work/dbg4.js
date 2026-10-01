const { Miniflare, Log, LogLevel } = require('miniflare');
(async () => {
  const mf = new Miniflare({ modules: true, scriptPath: process.argv[2] || 'dist/core-only.js', compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'd' }, bindings: { ADMIN_PASSWORD: 'p' }, log: new Log(LogLevel.ERROR) });
  for (const p of ['/health', '/', '/api/public/latency']) {
    const r = await mf.dispatchFetch('http://x' + p);
    const t = await r.text();
    console.log('---', p, r.status, r.headers.get('content-type'));
    console.log(t.slice(0, 700));
  }
  await mf.dispose();
})();
