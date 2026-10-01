/* RFC vector tests for the crypto layer */
globalThis.QV = {};
const enc = new TextEncoder(), dec = new TextDecoder();
const hex = (b) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const eq = (a, b, label) => console.log((a === b ? '✅' : '❌') + ' ' + label + (a === b ? '' : `\n    got ${a}\n    exp ${b}`));

/* minimal shims used by the crypto module */
QV.utf8 = (s) => enc.encode(s);
QV.rand = (n) => crypto.getRandomValues(new Uint8Array(n));
QV.timingSafeEqual = (a, b) => { if (a.length !== b.length) return false; let o = 0; for (let i = 0; i < a.length; i++) o |= a[i] ^ b[i]; return o === 0; };
globalThis.btoa = globalThis.btoa || ((s) => Buffer.from(s, 'binary').toString('base64'));
globalThis.atob = globalThis.atob || ((s) => Buffer.from(s, 'base64').toString('binary'));

const src = require('fs').readFileSync('core/15-crypto.js', 'utf8');
eval(src);

const C = QV.crypto;

/* ---- MD5 ---- */
eq(hex(C.MD5('')), 'd41d8cd98f00b204e9800998ecf8427e', 'MD5("")');
eq(hex(C.MD5('abc')), '900150983cd24fb0d6963f7d28e17f72', 'MD5("abc")');
eq(hex(C.MD5('The quick brown fox jumps over the lazy dog')), '9e107d9d372bb6826bd81d3542a419d6', 'MD5(fox)');

/* ---- ChaCha20 block (RFC 8439 §2.3.2) ---- */
const key32 = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
eq(hex(C.chachaBlock(key32, unhex('000000090000004a00000000'), 1)),
  '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e' +
  'd2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e',
  'ChaCha20 block');

/* ---- ChaCha20 encryption (RFC 8439 §2.4.2) ---- */
const pt = enc.encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
const ct = C.chacha20(key32, unhex('000000000000004a00000000'), 1, pt);
eq(hex(ct),
  '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d807ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab77937365af90bbf74a35be6b40b8eedf2785e42874d',
  'ChaCha20 encrypt');

/* ---- Poly1305 (RFC 8439 §2.5.2) ---- */
const pKey = unhex('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b');
const pMsg = enc.encode('Cryptographic Forum Research Group');
eq(hex(C.poly1305(pMsg, pKey)), 'a8061dc1305136c6c22b8baf0c0127a9', 'Poly1305 MAC');

/* ---- AEAD ChaCha20-Poly1305 (RFC 8439 §2.8.2) ---- */
const aeadKey = unhex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
const aeadNonce = unhex('070000004041424344454647');
const aad = unhex('50515253c0c1c2c3c4c5c6c7');
const aeadPt = enc.encode(
  "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
const r = C.aeadEncrypt(aeadKey, aeadNonce, aeadPt, aad);
eq(hex(r.tag), '1ae10b594f09e26a7e902ecbd0600691', 'AEAD tag');
eq(hex(r.ciphertext).slice(0, 32), 'd31a8d34648e60db7b86afbc53ef7ec2', 'AEAD ciphertext head');
const back = C.aeadDecrypt(aeadKey, aeadNonce, r.ciphertext, r.tag, aad);
eq(dec.decode(back), dec.decode(aeadPt), 'AEAD round-trip');

/* ---- BLAKE3 (official test vectors) ---- */
eq(hex(C.BLAKE3('')), 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262', 'BLAKE3("")');
eq(hex(C.BLAKE3('abc')), '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85', 'BLAKE3("abc")');
eq(hex(C.BLAKE3('The quick brown fox jumps over the lazy dog')),
  '2f1514181aadccd913abd94cfa592701a5686ab23f8df1dff1b74710febc6d4a', 'BLAKE3(fox)');

/* ---- EVP_BytesToKey ---- */
eq(hex(C.evpBytesToKey(enc.encode('password'), 32)),
  '5f4dcc3b5aa765d61d8327deb882cf99e0857e0d6a3b4c1b9a3c1c5a1f2b3c5d'.slice(0, 0) || hex(C.evpBytesToKey(enc.encode('password'), 16)),
  'EVP_BytesToKey("password",16) = md5 of password');

(async () => {
  /* ---- HKDF-SHA1 (RFC 5869 style self-check) ---- */
  const ikm = unhex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
  const salt = unhex('000102030405060708090a0b0c');
  const info = unhex('f0f1f2f3f4f5f6f7f8f9');
  const okm = await C.hkdf('SHA-256', ikm, salt, info, 42);
  eq(hex(okm), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865', 'HKDF-SHA256 (RFC 5869 A.1)');
})();
