const { Miniflare, Log, LogLevel } = require('miniflare');
(async () => {
  for (const cfg of [
    { name: 'no-kv', opts: { d1Databases: { DB: 'd' }, bindings: { ADMIN_PASSWORD: 'p' } } },
    { name: 'with-kv', opts: { d1Databases: { DB: 'd' }, kvNamespaces: { KV: 'k' }, bindings: { ADMIN_PASSWORD: 'p' } } },
  ]) {
    const mf = new Miniflare({ modules: true, scriptPath: 'dist/probe.js', compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.ERROR), ...cfg.opts });
    const h = await mf.dispatchFetch('http://x/health');
    const hj = await h.json();
    console.log(cfg.name, '/health →', h.status, 'd1:', hj.env?.bindings?.d1, 'warnings:', (hj.env?.warnings || []).length);
    const n = await (await mf.dispatchFetch('http://x/__dbg/net')).json();
    console.log(cfg.name, '/net →', JSON.stringify(n));
    await mf.dispose();
  }
})();
