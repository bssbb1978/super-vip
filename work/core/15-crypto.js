/* ═══════════════════════════════════════════════════════════════════════════
 * A4 · CRYPTO PRIMITIVES for the Shadowsocks AEAD engine
 *      · ChaCha20 + Poly1305 (RFC 8439)  — pure JS, constant-time-ish
 *      · MD5                              — legacy EVP_BytesToKey derivation
 *      · BLAKE3                           — SS-2022 key derivation
 *      · HKDF-SHA1/SHA-256 (WebCrypto)    — SS sub-key derivation
 *      · AES-GCM (WebCrypto)              — aes-*-gcm ciphers
 * ═══════════════════════════════════════════════════════════════════════════ */
QV.crypto = (() => {
  /* ---------------- MD5 (for EVP_BytesToKey) ---------------------------- */
  const MD5 = (() => {
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    const rol = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
    return (msg) => {
      const bytes = typeof msg === 'string' ? QV.utf8(msg) : msg;
      const ml = bytes.length;
      const withOne = ml + 1;
      const padded = new Uint8Array((((withOne + 8) >> 6) + 1) << 6);
      padded.set(bytes); padded[ml] = 0x80;
      const bitLen = ml * 8;
      const dv = new DataView(padded.buffer);
      dv.setUint32(padded.length - 8, bitLen >>> 0, true);
      dv.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);
      let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
      const M = new Uint32Array(16);
      for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
        let [A, B, C, D] = [a, b, c, d];
        for (let i = 0; i < 64; i++) {
          let f, g;
          if (i < 16) { f = (B & C) | (~B & D); g = i; }
          else if (i < 32) { f = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
          else if (i < 48) { f = B ^ C ^ D; g = (3 * i + 5) % 16; }
          else { f = C ^ (B | ~D); g = (7 * i) % 16; }
          f = (f + A + K[i] + M[g]) >>> 0;
          A = D; D = C; C = B;
          B = (B + rol(f, S[i])) >>> 0;
        }
        a = (a + A) >>> 0; b = (b + B) >>> 0; c = (c + C) >>> 0; d = (d + D) >>> 0;
      }
      const out = new Uint8Array(16); const odv = new DataView(out.buffer);
      odv.setUint32(0, a, true); odv.setUint32(4, b, true); odv.setUint32(8, c, true); odv.setUint32(12, d, true);
      return out;
    };
  })();

  /* ---------------- ChaCha20 (RFC 8439) --------------------------------- */
  const rotl = (v, c) => ((v << c) | (v >>> (32 - c))) >>> 0;
  const quarter = (s, a, b, c, d) => {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
  };
  const chachaBlock = (key, nonce, counter) => {
    const st = new Uint32Array(16);
    st[0] = 0x61707865; st[1] = 0x3320646e; st[2] = 0x79622d32; st[3] = 0x6b206574;
    const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
    for (let i = 0; i < 8; i++) st[4 + i] = kv.getUint32(i * 4, true);
    st[12] = counter >>> 0;
    const nv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    st[13] = nv.getUint32(0, true);
    st[14] = nv.getUint32(4, true);
    st[15] = nv.getUint32(8, true);
    const w = Uint32Array.from(st);
    for (let i = 0; i < 10; i++) {
      quarter(w, 0, 4, 8, 12); quarter(w, 1, 5, 9, 13); quarter(w, 2, 6, 10, 14); quarter(w, 3, 7, 11, 15);
      quarter(w, 0, 5, 10, 15); quarter(w, 1, 6, 11, 12); quarter(w, 2, 7, 8, 13); quarter(w, 3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) w[i] = (w[i] + st[i]) >>> 0;
    return new Uint8Array(w.buffer.slice(0));
  };
  const chacha20 = (key, nonce, counter, data) => {
    const out = new Uint8Array(data.length);
    for (let off = 0; off < data.length; off += 64, counter++) {
      const ks = chachaBlock(key, nonce, counter);
      for (let i = 0; i < 64 && off + i < data.length; i++) out[off + i] = data[off + i] ^ ks[i];
    }
    return out;
  };

  /* ---------------- Poly1305 (RFC 8439) ---------------------------------
   * BigInt arithmetic: the canonical 26-bit-limb version overflows JS
   * doubles (products reach 2^56), so we use exact integer maths.           */
  const P1305 = (1n << 130n) - 5n;
  const CLAMP = 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const bytesToBigIntLE = (b) => {
    let v = 0n;
    for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  };
  const bigIntToBytesLE = (v, len) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
  };
  const poly1305 = (msg, key) => {
    const r = bytesToBigIntLE(key.subarray(0, 16)) & CLAMP;
    const s = bytesToBigIntLE(key.subarray(16, 32));
    let h = 0n;
    for (let i = 0; i < msg.length; i += 16) {
      const chunk = msg.subarray(i, Math.min(i + 16, msg.length));
      const n = bytesToBigIntLE(chunk) + (1n << BigInt(8 * chunk.length));
      h = ((h + n) * r) % P1305;
    }
    return bigIntToBytesLE((h + s) % (1n << 128n), 16);
  };

  const poly1305Verify = (tag, expected) => QV.timingSafeEqual(tag, expected);

  /** ChaCha20-Poly1305 AEAD (RFC 8439 §2.8) */
  const aeadEncrypt = (key, nonce, plaintext, aad = new Uint8Array(0)) => {
    const otk = chachaBlock(key, nonce, 0).subarray(0, 32);
    const ciphertext = chacha20(key, nonce, 1, plaintext);
    const padA = (16 - (aad.length % 16)) % 16;
    const padC = (16 - (ciphertext.length % 16)) % 16;
    const mac = new Uint8Array(aad.length + padA + ciphertext.length + padC + 16);
    let o = 0;
    mac.set(aad, o); o += aad.length + padA;
    mac.set(ciphertext, o); o += ciphertext.length + padC;
    const dv = new DataView(mac.buffer);
    dv.setUint32(o, aad.length, true); dv.setUint32(o + 4, 0, true);
    dv.setUint32(o + 8, ciphertext.length, true); dv.setUint32(o + 12, 0, true);
    return { ciphertext, tag: poly1305(mac, otk) };
  };
  const aeadDecrypt = (key, nonce, ciphertext, tag, aad = new Uint8Array(0)) => {
    const otk = chachaBlock(key, nonce, 0).subarray(0, 32);
    const padA = (16 - (aad.length % 16)) % 16;
    const padC = (16 - (ciphertext.length % 16)) % 16;
    const mac = new Uint8Array(aad.length + padA + ciphertext.length + padC + 16);
    let o = 0;
    mac.set(aad, o); o += aad.length + padA;
    mac.set(ciphertext, o); o += ciphertext.length + padC;
    const dv = new DataView(mac.buffer);
    dv.setUint32(o, aad.length, true); dv.setUint32(o + 4, 0, true);
    dv.setUint32(o + 8, ciphertext.length, true); dv.setUint32(o + 12, 0, true);
    const expected = poly1305(mac, otk);
    if (!poly1305Verify(tag, expected)) return null;
    return chacha20(key, nonce, 1, ciphertext);
  };

  /* ---------------- BLAKE3 (SS-2022 key derivation) ---------------------
   * SS-2022 only ever needs keyed BLAKE3 over <=32 byte inputs, i.e. a single
   * chunk consisting of a single block with CHUNK_START|CHUNK_END|ROOT.       */
  const BLAKE3_IV = new Uint32Array([0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
                                     0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19]);
  const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
  const CHUNK_START = 1, CHUNK_END = 2, ROOT = 8;
  const rotr = (x, c) => ((x >>> c) | (x << (32 - c))) >>> 0;   /* BLAKE3 uses ROTR */
  const b3g = (v, a, b, c, d, mx, my) => {
    v[a] = (v[a] + v[b] + mx) >>> 0; v[d] = rotr(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) >>> 0; v[b] = rotr(v[b] ^ v[c], 12);
    v[a] = (v[a] + v[b] + my) >>> 0; v[d] = rotr(v[d] ^ v[a], 8);
    v[c] = (v[c] + v[d]) >>> 0; v[b] = rotr(v[b] ^ v[c], 7);
  };
  const blake3Compress = (cv, block, counter, blockLen, flags) => {
    const v = new Uint32Array(16);
    for (let i = 0; i < 8; i++) v[i] = cv[i];
    for (let i = 0; i < 8; i++) v[i + 8] = BLAKE3_IV[i];
    v[12] = counter >>> 0;
    v[13] = Math.floor(counter / 4294967296) >>> 0;
    v[14] = blockLen >>> 0;
    v[15] = flags >>> 0;
    const m = Uint32Array.from(block);
    for (let r = 0; r < 7; r++) {
      b3g(v, 0, 4, 8, 12, m[0], m[1]);  b3g(v, 1, 5, 9, 13, m[2], m[3]);
      b3g(v, 2, 6, 10, 14, m[4], m[5]); b3g(v, 3, 7, 11, 15, m[6], m[7]);
      b3g(v, 0, 5, 10, 15, m[8], m[9]); b3g(v, 1, 6, 11, 12, m[10], m[11]);
      b3g(v, 2, 7, 8, 13, m[12], m[13]);b3g(v, 3, 4, 9, 14, m[14], m[15]);
      if (r < 6) {
        const p = new Uint32Array(16);
        for (let i = 0; i < 16; i++) p[i] = m[MSG_PERMUTATION[i]];
        m.set(p);
      }
    }
    const out = new Uint32Array(16);
    for (let i = 0; i < 8; i++) { out[i] = (v[i] ^ v[i + 8]) >>> 0; out[i + 8] = (v[i + 8] ^ cv[i]) >>> 0; }
    return out;
  };
  const bytesToWords = (bytes) => {
    const w = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const o = i * 4;
      w[i] = ((bytes[o] || 0) | (bytes[o + 1] || 0) << 8 | (bytes[o + 2] || 0) << 16 | (bytes[o + 3] || 0) << 24) >>> 0;
    }
    return w;
  };
  /** keyed BLAKE3 (used by SS-2022 with a 16/32 byte salt) */
  const BLAKE3 = (input, key = null, outLen = 32) => {
    const data = typeof input === 'string' ? QV.utf8(input) : input;
    if (data.length > 64) {
      /* general path not required by SS-2022; keep it honest */
      throw new Error('BLAKE3: inputs longer than one block are not used by this engine');
    }
    let cv = BLAKE3_IV;
    if (key) {
      const kw = bytesToWords(key.subarray(0, 32));
      cv = new Uint32Array(8);
      for (let i = 0; i < 8; i++) cv[i] = (BLAKE3_IV[i] ^ kw[i]) >>> 0;
    }
    const out = blake3Compress(cv, bytesToWords(data), 0, data.length, CHUNK_START | CHUNK_END | ROOT);
    return new Uint8Array(out.buffer).subarray(0, outLen);
  };

  /* ---------------- EVP_BytesToKey (OpenSSL, for SS legacy) ------------- */
  const evpBytesToKey = (password, keyLen) => {
    const out = [];
    let prev = new Uint8Array(0);
    while (out.length < keyLen) {
      const buf = new Uint8Array(prev.length + password.length);
      buf.set(prev); buf.set(password, prev.length);
      prev = MD5(buf);
      out.push(...prev);
    }
    return new Uint8Array(out.slice(0, keyLen));
  };

  /* ---------------- HKDF via WebCrypto --------------------------------- */
  const hkdf = async (hash, ikm, salt, info, len) => {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash, salt, info }, key, len * 8);
    return new Uint8Array(bits);
  };

  /* ---------------- tiny keystream helpers ------------------------------ */
  const randomBytes = (n) => QV.rand(n);
  const concat = (...arrs) => {
    const len = arrs.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(len); let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };
  const u16le = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const readU16le = (b, o = 0) => b[o] | b[o + 1] << 8;
  const u64le = (v) => {
    const out = new Uint8Array(8); const dv = new DataView(out.buffer);
    dv.setUint32(0, v >>> 0, true); dv.setUint32(4, Math.floor(v / 4294967296) >>> 0, true);
    return out;
  };

  return { MD5, chacha20, chachaBlock, poly1305, aeadEncrypt, aeadDecrypt, BLAKE3,
    evpBytesToKey, hkdf, randomBytes, concat, u16le, readU16le, u64le };
})();
