/* Compare the worker's own key derivation with the Node reference client. */
import crypto from 'node:crypto';
const evp = (pw, n) => { const o = []; let p = Buffer.alloc(0); while (Buffer.concat(o).length < n) { p = crypto.createHash('md5').update(Buffer.concat([p, pw])).digest(); o.push(p); } return Buffer.concat(o).subarray(0, n); };
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha1', ikm, salt, Buffer.from(info), len));

const QV = globalThis.QV || (await import('./dist/surface.mjs?x=' + Date.now()), globalThis.QV);
const password = 'Nsjgp7YuPKKkk4oSsvme4i';
const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const masterW = QV.crypto.evpBytesToKey(QV.utf8(password), 16);
const masterN = evp(Buffer.from(password, 'utf8'), 16);
console.log('master worker:', Buffer.from(masterW).toString('hex'));
console.log('master node  :', masterN.toString('hex'));
const subW = await QV.ss.deriveSubkey('aes-128-gcm', masterW, new Uint8Array(salt));
const subN = hkdf(masterN, salt, 'ss-subkey', 16);
console.log('subkey worker:', Buffer.from(subW).toString('hex'));
console.log('subkey node  :', subN.toString('hex'));

/* now seal a length field with both sides and compare */
const nonce = new Uint8Array(12);
const keyW = await crypto.subtle.importKey('raw', new Uint8Array(subW), { name: 'AES-GCM' }, false, ['encrypt']);
const plain = new Uint8Array([0, 5]);
const outW = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, keyW, plain));
const c = crypto.createCipheriv('aes-128-gcm', Buffer.from(subW), Buffer.from(nonce));
const outN = Buffer.concat([c.update(Buffer.from(plain)), c.final(), c.getAuthTag()]);
console.log('seal worker  :', Buffer.from(outW).toString('hex'));
console.log('seal node    :', outN.toString('hex'));
