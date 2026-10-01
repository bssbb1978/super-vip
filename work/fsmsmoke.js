const { Miniflare, Log, LogLevel } = require('miniflare');
(async () => {
  const mf = new Miniflare({ modules: true, scriptPath: 'dist/probe.js', compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'd' }, bindings: { ADMIN_PASSWORD: 'p' }, log: new Log(LogLevel.ERROR) });
  const r = await (await mf.dispatchFetch('http://x/__dbg/fsm')).json();
  console.log(JSON.stringify(r, null, 1).slice(0, 1200));
  await mf.dispose();
})();
