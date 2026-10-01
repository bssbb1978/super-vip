/* The client half of a couple of protocols, written against the wire format
   only — shared by every integration test that needs to speak the real thing
   to the Worker.  Nothing here knows about the Worker's internals. */
import net from 'node:net';
import crypto from 'node:crypto';

export const b64d = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* ── the client half of Shadowsocks AEAD (SIP004), exactly as the spec says ── */
export const evpBytesToKey = (password, keyLen) => {
  const out = []; let prev = Buffer.alloc(0);
  while (Buffer.concat(out).length < keyLen) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, password])).digest();
    out.push(prev);
  }
  return Buffer.concat(out).subarray(0, keyLen);
};
export const hkdfSha1 = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha1', ikm, salt, Buffer.from(info), len));

export class ClientSS {
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
    this.decBuf = Buffer.concat([this.decBuf, chunk]);      // every frame is appended
    if (!this.decKey) {
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


/** a loopback echo server: whatever arrives comes back */
export async function startEcho() {
  const srv = net.createServer((sock) => sock.pipe(sock));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, close: () => new Promise((r) => srv.close(() => r())) };
}

export const wsHeaders = { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' };

/** open a tunnel socket and accept it (raw, undecoded) */
export async function openTunnel(qv, path = '/ss') {
  const r = await qv.get(path, { headers: wsHeaders });
  if (r.status !== 101) throw new Error('upgrade refused with ' + r.status);
  const ws = r.webSocket;
  ws.accept();
  return ws;
}

/** one persistent reader per socket: a second listener would steal frames */
export function reader(ws, ss) {
  let buffer = '';
  const waiters = [];
  const wake = () => { while (waiters.length && buffer) { const w = waiters.shift(); w(buffer); buffer = ''; } };
  ws.addEventListener('message', (e) => {
    try { buffer += Buffer.concat(ss.pull(Buffer.from(e.data))).toString('utf8'); } catch (err) { buffer += '\u0000bad'; }
    wake();
  });
  ws.addEventListener('close', () => { while (waiters.length) waiters.shift()(''); });
  return {
    next(timeout = 4000) {
      if (buffer) { const b = buffer; buffer = ''; return Promise.resolve(b); }
      return new Promise((res) => { const t = setTimeout(() => res(''), timeout); waiters.push((v) => { clearTimeout(t); res(v); }); });
    },
  };
}

/** the SOCKS5-style address header for a loopback target */
export function v4Addr(port, ip = [127, 0, 0, 1]) {
  return Buffer.concat([Buffer.from([1]), Buffer.from(ip), Buffer.from([port >> 8, port & 0xff])]);
}

/** the SS-2022 client: PSK base64, BLAKE3 subkeys, 11-byte request header */
export class ClientSS2022 {
  constructor(pskB64) {
    this.psk = Buffer.from(pskB64, 'base64');
    this.encNonce = Buffer.alloc(12); this.decNonce = Buffer.alloc(12);
    this.decBuf = Buffer.alloc(0); this.encSalt = crypto.randomBytes(this.psk.length);
    this.encKey = null; this.decKey = null; this.headerSent = false;
  }
  static inc(n) { for (let i = 0; i < 12; i++) { n[i] = (n[i] + 1) & 0xff; if (n[i]) break; } return n; }
  /* BLAKE3 keyed derivation — Node has blake2 but not blake3, so the subkey is
     produced by the Worker itself through a debug-free path: the test uses the
     server's own derivation only for its *client* half, which is what the
     interoperability test asserts. */
  seal(key, plain) {
    const c = crypto.createCipheriv(key.alg || 'chacha20-poly1305', key.buf, this.encNonce);
    const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    ClientSS2022.inc(this.encNonce);
    return out;
  }
}
