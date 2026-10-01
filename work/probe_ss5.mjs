import { boot } from './tests/helpers.mjs';
import net from 'node:net';
import crypto from 'node:crypto';
const b64d = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* ── the client half of Shadowsocks AEAD (SIP004), exactly as the spec says ── */
const evpBytesToKey = (password, keyLen) => {
  const out = []; let prev = Buffer.alloc(0);
  while (Buffer.concat(out).length < keyLen) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, password])).digest();
    out.push(prev);
  }
  return Buffer.concat(out).subarray(0, keyLen);
};
const hkdfSha1 = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha1', ikm, salt, Buffer.from(info), len));

class ClientSS {
  constructor(cipher, password) {
    this.cipher = cipher;
    this.master = evpBytesToKey(Buffer.from(password, 'utf8'), cipher === 'aes-128-gcm' ? 16 : 32);
    this.encNonce = Buffer.alloc(12); this.decNonce = Buffer.alloc(12);
    this.decBuf = Buffer.alloc(0); this.encSalt = null; this.decKey = null;
  }
  static inc(n) { for (let i = 0; i < 12; i++) { n[i] = (n[i] + 1) & 0xff; if (n[i]) break; } return n; }
  seal(plain) {
    const c = crypto.createCipheriv('aes-128-gcm', this.encKey, this.encNonce);
    const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    ClientSS.inc(this.encNonce);
    return out;
  }
  hello() {
    this.encSalt = crypto.randomBytes(16);
    this.encKey = hkdfSha1(this.master, this.encSalt, 'ss-subkey', 16);
    return this.encSalt;
  }
  push(plain) {
    const len = Buffer.from([plain.length >> 8, plain.length & 0xff]);
    return Buffer.concat([this.seal(len), this.seal(plain)]);
  }
  pull(chunk) {
    if (!this.decKey) {
      this.decBuf = Buffer.concat([this.decBuf, chunk]);
      if (this.decBuf.length < 16) return [];
      const salt = this.decBuf.subarray(0, 16);
      this.decBuf = this.decBuf.subarray(16);
      this.decKey = hkdfSha1(this.master, salt, 'ss-subkey', 16);
    }
    const out = [];
    for (;;) {
      if (this.decBuf.length < 18) break;
      /* GCM: the 16-byte tag rides at the end of every sealed chunk */
      const d = crypto.createDecipheriv('aes-128-gcm', this.decKey, this.decNonce);
      d.setAuthTag(this.decBuf.subarray(2, 18));               // 2-byte ciphertext + 16-byte tag
      let lenPlain;
      try { lenPlain = Buffer.concat([d.update(this.decBuf.subarray(0, 2)), d.final()]); }
      catch (e) { throw new Error('auth failed'); }
      ClientSS.inc(this.decNonce);
      const length = (lenPlain[0] << 8) | lenPlain[1];
      console.log('   length field =', length, 'have', this.decBuf.length);
      if (this.decBuf.length < 18 + length + 16) break;
      const b = crypto.createDecipheriv('aes-128-gcm', this.decKey, this.decNonce);
      b.setAuthTag(this.decBuf.subarray(18 + length, 18 + length + 16));
      const body = Buffer.concat([b.update(this.decBuf.subarray(18, 18 + length)), b.final()]);
      ClientSS.inc(this.decNonce);
      this.decBuf = this.decBuf.subarray(18 + length + 16);
      out.push(body);
    }
    return out;
  }
}





const wsHeaders = { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' };
const openTunnel = async (path = '/ss') => {
  const r = await qv.get(path, { headers: wsHeaders });
  expect(r.status).toBe(101);
  const ws = r.webSocket;
  ws.accept();
  return ws;
};
/** one persistent reader per socket: frames are decrypted as they arrive and
    waiters are woken with whatever new plaintext appeared (a second listener
    would steal the frame from the first one) */
const reader = (ws, ss) => {
  let buffer = '';
  const waiters = [];
  const wake = () => {
    while (waiters.length && buffer) { const w = waiters.shift(); w(buffer); buffer = ''; }
  };
  ws.addEventListener('message', (e) => {
    const b = Buffer.from(e.data);
    console.log('   frame', b.length, 'decNonce', Buffer.from(ss.decNonce).toString('hex'), 'dkey', !!ss.decKey, 'buf', b.subarray(0, 4).toString('hex'));
    try {
      const pieces = ss.pull(b);
      console.log('   pieces', pieces.length, pieces.map(p => JSON.stringify(p.toString('utf8'))).join(','));
      buffer += Buffer.concat(pieces).toString('utf8');
    } catch (err) { console.log('   pull threw', err.message); buffer += '\u0000bad'; }
    wake();
  });
  ws.addEventListener('close', () => { while (waiters.length) waiters.shift()(''); });
  return {
    next(timeout = 4000) {
      if (buffer) { const b = buffer; buffer = ''; return Promise.resolve(b); }
      return new Promise((res) => {
        const t = setTimeout(() => res(''), timeout);
        waiters.push((v) => { clearTimeout(t); res(v); });
      });
    },
  };
};


const echoSrv = net.createServer(sock => sock.pipe(sock));
await new Promise(r => echoSrv.listen(0, '127.0.0.1', r));
const echoPort = echoSrv.address().port;
const qv = await boot({ SS_DEBUG: '1' });
const user = await qv.createUser({ name: 'ss5', quota_gb: 5, days: 10 });
const sub = Buffer.from(await (await qv.get('/sub/' + user.uuid)).text(), 'base64').toString('utf8');
const uri = sub.split('\n').find(l => l.startsWith('ss://Y'));
const info = b64d(uri.match(/^ss:\/\/([^@]+)@/)[1]).toString('utf8');
const [method, password] = info.split(':');
const r = await qv.get('/ss', { headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
const ws = r.webSocket; ws.accept();
const ss = new ClientSS(method, password);
const ch = reader(ws, ss);
ws.send(ss.hello());
const addr = Buffer.concat([Buffer.from([1, 127, 0, 0, 1]), Buffer.from([echoPort >> 8, echoPort & 0xff])]);
ws.send(ss.push(Buffer.concat([addr, Buffer.from('ping-through-the-tunnel')])));
console.log('first  >', JSON.stringify(await ch.next()));
ws.send(ss.push(Buffer.from('again')));
console.log('second >', JSON.stringify(await ch.next()));
ws.close();
await new Promise(r => setTimeout(r, 600));
const sess = await qv.json('/api/sessions', { headers: qv.auth() });
console.log('sessions:', JSON.stringify((sess.data.items || []).slice(0, 4)));
const us = await qv.json('/api/users', { headers: qv.auth() });
const mine = (us.data.items || []).find(u => u.uuid === user.uuid);
console.log('user row:', JSON.stringify(mine && { uuid: mine.uuid, used: mine.used_bytes, up: mine.up_bytes, down: mine.down_bytes }));
const ev = await qv.json('/api/events?limit=30', { headers: qv.auth() });
console.log('ss events:', (ev.data.items || []).filter(e => /ss/.test(String(e.component) + String(e.message))).map(e => e.component + ':' + e.message).join(' | '));
await qv.dispose(); echoSrv.close();
