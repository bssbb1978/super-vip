const { Miniflare, Log, LogLevel } = require('miniflare');
(async () => {
  const mf = new Miniflare({
    modules: true,
    script: `export default { async fetch(r, env) {
      const out = {};
      try {
        await env.DB.prepare('CREATE TABLE t(a TEXT)').run();
        await env.DB.prepare('CREATE VIEW v AS SELECT a FROM t').run();
        await env.DB.prepare('CREATE TRIGGER tr INSTEAD OF INSERT ON v BEGIN INSERT INTO t(a) VALUES(new.a); END').run();
        await env.DB.prepare('INSERT INTO v(a) VALUES(?)').bind('x').run();
        out.view = await env.DB.prepare('SELECT COUNT(*) AS n FROM t').first();
        out.trigger = 'ok';
      } catch (e) { out.err = e.message; }
      return Response.json(out);
    } };`,
    compatibilityDate: '2025-01-01', d1Databases: { DB: 'd' }, log: new Log(LogLevel.ERROR),
  });
  const r = await mf.dispatchFetch('http://x/');
  console.log(await r.text());
  await mf.dispose();
})();
