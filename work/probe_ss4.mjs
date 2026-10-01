import { boot } from './tests/helpers.mjs';
import net from 'node:net';
import crypto from 'node:crypto';
const b64d = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const evp = (pw, n) => { const o = []; let p = Buffer.alloc(0); while (Buffer.concat(o).length < n) { p = crypto.createHash('md5').update(Buffer.concat([p, pw])).digest(); o.push(p); } return Buffer.concat(o).subarray(0, n); };
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha1', ikm, salt, Buffer.from(info), len));
const inc = (n) => { for (let i = 0; i < 12; i++) { n[i] = (n[i] + 1) & 0xff; if (n[i]) break; } };
class C {
  constructor(password) { this.master = evp(Buffer.from(password, 'utf8'), 16); this.enc = Buffer.alloc(12); this.dec = Buffer.alloc(12); this.buf = Buffer.alloc(0); this.key = null; this.dkey = null; }
  seal(pt) { const c = crypto.createCipheriv('aes-128-gcm', this.key, this.enc); const o = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]); inc(this.enc); return o; }
  hello() { this.salt = crypto.randomBytes(16); this.key = hkdf(this.master, this.salt, 'ss-subkey', 16); return this.salt; }
  push(pt) { return Buffer.concat([this.seal(Buffer.from([pt.length >> 8, pt.length & 0xff])), this.seal(pt)]); }
  pull(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.dkey) { if (this.buf.length < 16) return []; const s = this.buf.subarray(0, 16); this.buf = this.buf.subarray(16); this.dkey = hkdf(this.master, s, 'ss-subkey', 16); }
    const out = [];
    for (;;) {
      if (this.buf.length < 18) break;
      const d = crypto.createDecipheriv('aes-128-gcm', this.dkey, this.dec); d.setAuthTag(this.buf.subarray(2, 18));
      let lp; try { lp = Buffer.concat([d.update(this.buf.subarray(0, 2)), d.final()]); } catch (e) { throw new Error('auth failed'); }
      inc(this.dec);
      const len = (lp[0] << 8) | lp[1];
      if (this.buf.length < 18 + len + 16) break;
      const b = crypto.createDecipheriv('aes-128-gcm', this.dkey, this.dec); b.setAuthTag(this.buf.subarray(18 + len, 18 + len + 16));
      out.push(Buffer.concat([b.update(this.buf.subarray(18, 18 + len)), b.final()]));
      inc(this.dec); this.buf = this.buf.subarray(18 + len + 16);
    }
    return out;
  }
}
const echo = net.createServer(s => s.pipe(s));
await new Promise(r => echo.listen(0, '127.0.0.1', r));
const echoPort = echo.address().port;
console.log('echo port', echoPort);
const qv = await boot({ SS_DEBUG: '1' });
const user = await qv.createUser({ name: 'ss4', quota_gb: 5, days: 10 });
const sub = Buffer.from(await (await qv.get('/sub/' + user.uuid)).text(), 'base64').toString('utf8');
const uri = sub.split('\n').find(l => l.startsWith('ss://Y'));
const info = b64d(uri.match(/^ss:\/\/([^@]+)@/)[1]).toString('utf8');
const [method, password] = info.split(':');
console.log('credential', method, password);
const r = await qv.get('/ss', { headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
const ws = r.webSocket; ws.accept();
const c = new C(password);
const msgs = [];
ws.addEventListener('message', e => {
  const b = Buffer.from(e.data);
  msgs.push(b.length);
  if (msgs.length === 1) console.log('first frame', b.length, b.subarray(0, 24).toString('hex'));
  let p = '';
  try { p = Buffer.concat(c.pull(b)).toString('utf8'); } catch (err) { p = 'AUTHFAIL:' + err.message; }
  if (p) console.log('PLAIN >', JSON.stringify(p));
});
ws.addEventListener('close', () => console.log('CLOSED'));
ws.send(c.hello());
const addr = Buffer.concat([Buffer.from([1, 127, 0, 0, 1]), Buffer.from([echoPort >> 8, echoPort & 0xff])]);
ws.send(c.push(Buffer.concat([addr, Buffer.from('ping-through-the-tunnel')])));
ws.send(c.push(Buffer.from('again')));          // immediately, like the test does
await new Promise(r => setTimeout(r, 1500));
console.log('frames in:', msgs.join(','));
const ev = await qv.json('/api/events?limit=30', { headers: qv.auth() });
for (const e of (ev.data.items || []).slice(0, 12)) console.log('EV', e.component, e.message, JSON.stringify(e.meta || {}).slice(0, 120));
await qv.dispose(); echo.close();
