import { Miniflare, Log, LogLevel } from 'miniflare';
import net from 'node:net';
const echo = net.createServer(s => s.pipe(s));
await new Promise(r => echo.listen(0, '127.0.0.1', r));
const port = echo.address().port;
const mf = new Miniflare({
  modules: true,
  script: `import { connect } from 'cloudflare:sockets';
export default {
  async fetch(req) {
    const u = new URL(req.url);
    const host = u.searchParams.get('h'); const p = Number(u.searchParams.get('p'));
    try {
      const sock = connect({ hostname: host, port: p });
      const w = sock.writable.getWriter();
      await w.write(new TextEncoder().encode('hello'));
      const rd = sock.readable.getReader();
      const { value } = await rd.read();
      return new Response('echo: ' + new TextDecoder().decode(value || new Uint8Array()));
    } catch (e) { return new Response('ERR ' + (e && e.message), { status: 502 }); }
  }
};`,
  compatibilityDate: '2024-09-23',
  log: new Log(LogLevel.ERROR),
});
for (const [h, p] of [['127.0.0.1', port], ['localhost', port], ['one.one.one.one', 80]]) {
  try {
    const r = await mf.dispatchFetch('http://x/?h=' + h + '&p=' + p);
    console.log(h + ':' + p, r.status, (await r.text()).slice(0, 60));
  } catch (e) { console.log(h + ':' + p, 'THREW', e.message.slice(0, 80)); }
}
await mf.dispose(); echo.close();
