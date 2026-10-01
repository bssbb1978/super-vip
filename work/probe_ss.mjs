import { boot } from './tests/helpers.mjs';
import crypto from 'node:crypto';
const b64d = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const evp = (pw, n) => { const o = []; let p = Buffer.alloc(0); while (Buffer.concat(o).length < n) { p = crypto.createHash('md5').update(Buffer.concat([p, pw])).digest(); o.push(p); } return Buffer.concat(o).subarray(0, n); };
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha1', ikm, salt, Buffer.from(info), len));

const qv = await boot({ SS_DEBUG: '1' });
const user = await qv.createUser({ name: 'ss-dbg', quota_gb: 5, days: 10 });
const r = await qv.get('/sub/' + user.uuid);
const text = Buffer.from(await r.text(), 'base64').toString('utf8');
const uris = text.split('\n').filter(l => l.startsWith('ss://'));
console.log('--- ss uris ---');
for (const u of uris) console.log(u.slice(0, 90));
const legacy = uris.find(l => !l.includes('2022-blake3'));
const info = b64d(legacy.match(/^ss:\/\/([^@]+)@/)[1]).toString('utf8');
const [method, password] = info.split(':');
console.log('credential:', method, JSON.stringify(password));

const r2 = await qv.get('/ss', { headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
console.log('upgrade status', r2.status);
const ws = r2.webSocket; ws.accept();
ws.addEventListener('message', e => console.log('MSG', Buffer.from(e.data).length, 'bytes'));
ws.addEventListener('close', () => console.log('CLOSED'));
ws.addEventListener('error', e => console.log('ERR', e.message || e));

const master = evp(Buffer.from(password, 'utf8'), 16);
const salt = crypto.randomBytes(16);
const key = hkdf(master, salt, 'ss-subkey', 16);
let n = Buffer.alloc(12);
const seal = (pt) => { const c = crypto.createCipheriv('aes-128-gcm', key, n); const out = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]); for (let i = 0; i < 12; i++) { n[i] = (n[i] + 1) & 0xff; if (n[i]) break; } return out; };
const addr = Buffer.concat([Buffer.from([1, 127, 0, 0, 1]), Buffer.from([0x1f, 0x90])]);
const payload = Buffer.from('ping');
const body = Buffer.concat([addr, payload]);
const len = Buffer.from([body.length >> 8, body.length & 0xff]);
const f1 = salt, f2 = seal(len), f3 = seal(body);
console.log('frames', f1.length, f2.length, f3.length, 'body', body.length);
ws.send(f1); ws.send(f2); ws.send(f3);
await new Promise(r => setTimeout(r, 1500));
const ev = await qv.json('/api/events?limit=40', { headers: qv.auth() });
console.log('--- events ---');
for (const e of (ev.data.items || []).slice(0, 40)) {
  const m = e.meta || e.details || {};
  if (/ss:/.test(String(e.component || '')) || /ss/.test(String(e.message || ''))) console.log(e.component || e.kind, e.message, JSON.stringify(m));
}
await qv.dispose();
