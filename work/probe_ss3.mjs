/* isolated codec check: the worker's server stream vs a Node client */
import crypto from 'node:crypto';
const QV = globalThis.QV || (await import('./dist/surface.mjs?y=' + Date.now()), globalThis.QV);
const evp = (pw, n) => { const o = []; let p = Buffer.alloc(0); while (Buffer.concat(o).length < n) { p = crypto.createHash('md5').update(Buffer.concat([p, pw])).digest(); o.push(p); } return Buffer.concat(o).subarray(0, n); };
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha1', ikm, salt, Buffer.from(info), len));

const password = 'JONdDo2SYW23OYXMsDZFYth';
const cipher = 'aes-128-gcm';
const salt = crypto.randomBytes(16);
const master = evp(Buffer.from(password, 'utf8'), 16);
const key = hkdf(master, salt, 'ss-subkey', 16);
let nonce = Buffer.alloc(12);
const seal = (pt) => { const c = crypto.createCipheriv('aes-128-gcm', key, nonce); const out = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]); for (let i = 0; i < 12; i++) { nonce[i] = (nonce[i] + 1) & 0xff; if (nonce[i]) break; } return out; };

const server = new QV.ss.SSStream({ cipher, password, isServer: true });
const addr = Buffer.concat([Buffer.from([1, 127, 0, 0, 1]), Buffer.from([0x1f, 0x90])]);
const body = Buffer.concat([addr, Buffer.from('ping')]);
const wire = Buffer.concat([salt, seal(Buffer.from([0, body.length])), seal(body)]);
console.log('wire', wire.length);
const r = await server.pull(new Uint8Array(wire));
console.log('server pull →', JSON.stringify({ error: r.error, pieces: r.pieces.length, first: r.pieces[0] ? Buffer.from(r.pieces[0]).toString('hex') : null }));

/* and the reverse: worker pushes, Node opens */
const srv2 = new QV.ss.SSStream({ cipher, password, isServer: false });
const out = await srv2.push(new Uint8Array(body));
const buf = Buffer.from(out);
console.log('worker seal[0..3]', buf.subarray(0, 4).toString('hex'), 'len', buf.length);
const sSalt = buf.subarray(0, 16);
const sKey = hkdf(master, sSalt, 'ss-subkey', 16);
const dec = crypto.createDecipheriv('aes-128-gcm', sKey, Buffer.alloc(12));
dec.setAuthTag(buf.subarray(18, 34));
const len = Buffer.concat([dec.update(buf.subarray(16, 18)), dec.final()]);
console.log('worker length field', len.toString('hex'));
const n1 = Buffer.alloc(12); n1[0] = 1;
const b = crypto.createDecipheriv('aes-128-gcm', sKey, n1);
b.setAuthTag(buf.subarray(45, 61));
console.log('worker body', Buffer.concat([b.update(buf.subarray(34, 45)), b.final()]).toString('hex'));
