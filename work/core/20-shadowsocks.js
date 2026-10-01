/* ═══════════════════════════════════════════════════════════════════════════
 * A5 · SHADOWSOCKS AEAD ENGINE  (third protocol, next to VLESS & the shapes)
 * ═══════════════════════════════════════════════════════════════════════════
 *  Supported ciphers
 *    legacy AEAD (SIP004, HKDF-SHA1 sub-keys)
 *      · chacha20-ietf-poly1305      32B key
 *      · aes-256-gcm                 32B key
 *      · aes-128-gcm                 16B key
 *    2022 AEAD (SIP022, BLAKE3 sub-keys)
 *      · 2022-blake3-chacha20-poly1305  32B key
 *      · 2022-blake3-aes-256-gcm        32B key
 *      · 2022-blake3-aes-128-gcm        16B key
 *
 *  Transport inside the Worker
 *    Shadowsocks is a TCP/UDP protocol; a Worker only receives HTTP(S)/WS.
 *    The engine therefore exposes the exact AEAD stream framing over a
 *    WebSocket carrier ("ss+ws"), which is what the bundled client profile
 *    uses.  The same AEAD stream class is reused for UDP (DNS) relay.
 *
 *  Wire format implemented
 *    TCP request header (SOCKS5-like, identical to Shadowsocks):
 *        ATYP(1) | ADDR(var) | PORT(2)
 *        ATYP=1 IPv4 4B · ATYP=3 domain (len+bytes) · ATYP=4 IPv6 16B
 *    legacy stream: [salt][seal(len 2B)][seal(payload ≤0x3FFF)]...
 *    2022 stream  : [salt][seal(header 11B)][seal(payload)]... where header =
 *        type(1) | timestamp(8, big endian ms) | length(2, big endian)
 * ═══════════════════════════════════════════════════════════════════════════ */
QV.ss = (() => {
  const C = QV.crypto;
  const MAX_PAYLOAD = 0x3fff;

  const CIPHERS = {
    'chacha20-ietf-poly1305': { family: 'legacy', keyLen: 32, saltLen: 32, aead: 'chacha20-poly1305', tagLen: 16 },
    'aes-256-gcm': { family: 'legacy', keyLen: 32, saltLen: 32, aead: 'aes-256-gcm', tagLen: 16 },
    'aes-128-gcm': { family: 'legacy', keyLen: 16, saltLen: 16, aead: 'aes-128-gcm', tagLen: 16 },
    '2022-blake3-chacha20-poly1305': { family: '2022', keyLen: 32, saltLen: 32, aead: 'chacha20-poly1305', tagLen: 16 },
    '2022-blake3-aes-256-gcm': { family: '2022', keyLen: 32, saltLen: 32, aead: 'aes-256-gcm', tagLen: 16 },
    '2022-blake3-aes-128-gcm': { family: '2022', keyLen: 16, saltLen: 16, aead: 'aes-128-gcm', tagLen: 16 },
  };

  /* ---------- sub-key derivation ---------------------------------------- */
  /* ═══ cached derivations ═══════════════════════════════════════════════
   * The subkey of a stream is a pure function of (cipher, password, salt).
   * Both KDFs are the most expensive thing in this file, and a half-open
   * stream is retried on every frame until it either authenticates or dies,
   * so the result is memoised — bounded by entries *and* bytes.
   * ═════════════════════════════════════════════════════════════════════ */
  const KEY_CACHE = QV.cache('ssKeys', { max: 1024, maxBytes: 512 * 1024, ttl: 300000 });
  /** salts seen recently: a replayed salt is an active-probing signature */
  const SALT_SEEN = QV.cache('ssSalt', { max: 4096, maxBytes: 512 * 1024, ttl: 180000 });
  const DERIVE_LABEL = 'AXR-SS-AEAD-V1';
  const MAX_TRIALS = 24;

  const deriveSubkey = async (cipher, masterKey, salt) => {
    const spec = CIPHERS[cipher];
    if (!spec) throw new Error('unknown cipher ' + cipher);
    if (spec.family === '2022') return C.BLAKE3(salt, masterKey, spec.keyLen);
    return C.hkdf('SHA-1', masterKey, salt, QV.utf8('ss-subkey'), spec.keyLen);
  };
  /** memoised subkey: the salt travels in-band, so this is hit on retries and
   *  on every frame after the first of a half-open stream */
  const subkeyCached = async (cipher, masterKey, salt) => {
    const ck = cipher + '\u0000' + QV.hex(masterKey).slice(0, 16) + '\u0000' + QV.hex(salt);
    const hit = KEY_CACHE.get(ck);
    if (hit) { QV.count('ss_key_cache_hit'); return hit; }
    const k = await deriveSubkey(cipher, masterKey, salt);
    KEY_CACHE.set(ck, k, 300000);
    return k;
  };

  /* ---------- raw AEAD seal/open for both families ---------------------- */
  const aeadSeal = async (spec, key, nonce, plaintext) => {
    if (spec.aead === 'chacha20-poly1305') {
      const r = C.aeadEncrypt(key, nonce, plaintext);
      return C.concat(r.ciphertext, r.tag);
    }
    const ck = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, ck, plaintext));
    return out;
  };
  const aeadOpen = async (spec, key, nonce, sealed) => {
    try {
      if (spec.aead === 'chacha20-poly1305') {
        const ct = sealed.subarray(0, sealed.length - 16);
        const tag = sealed.subarray(sealed.length - 16);
        return C.aeadDecrypt(key, nonce, ct, tag);
      }
      const ck = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, ck, sealed));
    } catch (e) { return null; }        // authentication failure
  };

  /* ---------- nonce counter (little-endian, 12 bytes) ------------------- */
  const newNonce = () => new Uint8Array(12);
  const incNonce = (n) => { for (let i = 0; i < 12; i++) { if (++n[i] !== 0) break; } return n; };

  /* ---------- address codec -------------------------------------------- */
  /** IPv6 text → 16 bytes, honouring `::` compression (RFC 4291 §2.2) */
  const parseV6 = (host) => {
    const [head, tail] = host.split('::');
    const h = head ? head.split(':').filter(Boolean) : [];
    const t = tail !== undefined ? (tail ? tail.split(':').filter(Boolean) : []) : [];
    if (tail === undefined && h.length !== 8) throw new Error('bad ipv6 address: ' + host);
    if (tail !== undefined && h.length + t.length > 8) throw new Error('bad ipv6 address: ' + host);
    const pad = new Array(8 - h.length - t.length).fill('0');
    const groups = [...h, ...pad, ...t].map(g => {
      const v = parseInt(g, 16);
      if (!isFinite(v) || v < 0 || v > 0xffff) throw new Error('bad ipv6 group: ' + g);
      return v;
    });
    const bytes = new Uint8Array(16);
    groups.forEach((g, i) => { bytes[i * 2] = g >> 8; bytes[i * 2 + 1] = g & 0xff; });
    return bytes;
  };
  /** 16 bytes → canonical text with the longest zero run compressed */
  const formatV6 = (b) => {
    const g = [];
    for (let i = 0; i < 8; i++) g.push((b[i * 2] << 8) | b[i * 2 + 1]);
    let best = { i: -1, n: 0 }, cur = { i: -1, n: 0 };
    g.forEach((v, i) => {
      if (v === 0) { if (cur.i < 0) cur = { i, n: 1 }; else cur.n++; if (cur.n > best.n) best = { ...cur }; }
      else cur = { i: -1, n: 0 };
    });
    const hex = g.map(v => v.toString(16));
    if (best.n < 2) return hex.join(':');
    return (hex.slice(0, best.i).join(':') + '::' + hex.slice(best.i + best.n).join(':')).replace(/^::/, '::').replace(/::$/, '::');
  };

  const encodeAddress = (host, port) => {
    const portBytes = new Uint8Array([(port >> 8) & 0xff, port & 0xff]);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const parts = host.split('.').map(Number);
      return C.concat(new Uint8Array([1, ...parts]), portBytes);
    }
    if (host.includes(':')) {
      return C.concat(new Uint8Array([4]), parseV6(host), portBytes);
    }
    const d = QV.utf8(host);
    return C.concat(new Uint8Array([3, d.length]), d, portBytes);
  };
  const decodeAddress = (buf) => {
    if (!buf || !buf.length) return null;
    const atyp = buf[0];
    if (atyp === 1 && buf.length >= 7) return { host: `${buf[1]}.${buf[2]}.${buf[3]}.${buf[4]}`, port: (buf[5] << 8) | buf[6], len: 7, type: 'ipv4' };
    if (atyp === 4 && buf.length >= 19) return { host: formatV6(buf.subarray(1, 17)), port: (buf[17] << 8) | buf[18], len: 19, type: 'ipv6' };
    if (atyp === 3 && buf.length >= 2) {
      const l = buf[1];
      if (buf.length < 4 + l) return null;
      const host = QV.dec.decode(buf.subarray(2, 2 + l));
      return { host, port: (buf[2 + l] << 8) | buf[3 + l], len: 4 + l, type: 'domain' };
    }
    return null;
  };

  /* ---------- master key handling --------------------------------------- */
  const masterKeyFromPassword = (password, cipher) => {
    const spec = CIPHERS[cipher];
    if (!spec) throw new Error('unknown cipher');
    if (spec.family === '2022') {
      const raw = QV.b64.dec(String(password).trim());
      if (raw.length !== spec.keyLen) throw new Error(`SS-2022 key must be ${spec.keyLen} bytes of base64`);
      return raw;
    }
    return C.evpBytesToKey(QV.utf8(password), spec.keyLen);
  };
  const randomPassword = (cipher) => {
    const spec = CIPHERS[cipher];
    return spec.family === '2022' ? QV.b64.enc(QV.rand(spec.keyLen)) : QV.hex(QV.rand(spec.keyLen));
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * SSStream — the AEAD stream codec (works over any byte sink/source)
   * ═══════════════════════════════════════════════════════════════════════ */
  class SSStream {
    constructor({ cipher, password, isServer = true }) {
      this.spec = CIPHERS[cipher] || CIPHERS['chacha20-ietf-poly1305'];
      this.cipher = cipher in CIPHERS ? cipher : 'chacha20-ietf-poly1305';
      this.master = masterKeyFromPassword(password, this.cipher);
      this.isServer = isServer;
      this.encKey = null; this.decKey = null;
      this.encNonce = newNonce(); this.decNonce = newNonce();
      this.encSalt = null; this.decSalt = null;
      this.decBuffer = new Uint8Array(0);
      this.headerSent = false;
      /* `decSaltKnown` is set once the peer's salt has been authenticated: it
         tells push() which header shape the other end expects */
      this.decSaltKnown = false;
      this.tsWindow = 30;                 // SIP022 §3.1.3, seconds; 0 disables
      this.stat = { up: 0, down: 0, chunks: 0 };
    }

    /** initialise the encrypting direction (writes the salt on first seal) */
    async initEncrypt(salt = null) {
      this.encSalt = salt || QV.rand(this.spec.saltLen);
      this.encKey = await subkeyCached(this.cipher, this.master, this.encSalt);
      this.encNonce.fill(0);
      return this.encSalt;
    }

    /** initialise the decrypting direction from the peer's salt */
    async initDecrypt(salt) {
      this.decSalt = salt;
      this.decKey = await subkeyCached(this.cipher, this.master, salt);
      this.decSaltKnown = true;
      this.decNonce.fill(0);
    }

    /** the fixed-length header of a 2022 stream (SIP022 §3.1.3):
     *   type | unix epoch | request salt (response stream only) | length      */
    _header2022(len) {
      const isResponse = this.isServer && this.decSalt;
      const saltLen = isResponse ? this.spec.saltLen : 0;
      const hdr = new Uint8Array(1 + 8 + saltLen + 2);
      hdr[0] = isResponse ? 1 : 0;                         // 1 = server stream
      const ts = BigInt(Math.floor(Date.now() / 1000));
      for (let i = 0; i < 8; i++) hdr[1 + i] = Number((ts >> BigInt(8 * (7 - i))) & 0xffn);
      if (isResponse) hdr.set(this.decSalt, 9);            // the request salt it answers
      hdr[hdr.length - 2] = (len >> 8) & 0xff; hdr[hdr.length - 1] = len & 0xff;
      return hdr;
    }

    /** split a plaintext stream into AEAD chunks and return the wire bytes */
    async push(plaintext) {
      if (!this.encKey) await this.initEncrypt();
      const out = [];
      if (!this.headerSent) { out.push(this.encSalt); this.headerSent = true; }
      const maxPayload = this.spec.family === '2022' ? 0xffff : MAX_PAYLOAD;
      let offset = 0;
      while (offset < plaintext.length) {
        const chunk = plaintext.subarray(offset, Math.min(offset + maxPayload, plaintext.length));
        offset += chunk.length;
        if (this.spec.family === '2022') {
          out.push(await aeadSeal(this.spec, this.encKey, this.encNonce, this._header2022(chunk.length))); incNonce(this.encNonce);
        } else {
          const len = new Uint8Array([chunk.length >> 8, chunk.length & 0xff]);
          out.push(await aeadSeal(this.spec, this.encKey, this.encNonce, len)); incNonce(this.encNonce);
        }
        out.push(await aeadSeal(this.spec, this.encKey, this.encNonce, chunk)); incNonce(this.encNonce);
        this.stat.chunks++; this.stat.up += chunk.length;
      }
      return C.concat(...out);
    }

    /** feed wire bytes in, get all fully authenticated plaintext chunks out */
    async pull(wire) {
      this.decBuffer = C.concat(this.decBuffer, wire);
      const pieces = [];
      for (;;) {
        if (!this.decKey) {
          if (this.decBuffer.length < this.spec.saltLen) break;
          const salt = this.decBuffer.subarray(0, this.spec.saltLen);
          this.decBuffer = this.decBuffer.subarray(this.spec.saltLen);
          await this.initDecrypt(salt);
          continue;
        }
        /* A 2022 stream starts with one of two header shapes and the only way
           to tell them apart is to authenticate them: the request header is
           11 bytes (type 0), the response header carries the request salt
           (type 1).  Each trial is one AEAD open; a failed open consumes no
           nonce, so trying both is safe. */
        let length = null, headerLen = 0;
        if (this.spec.family === '2022') {
          const candidates = this.decSaltKnown
            ? [1 + 8 + this.spec.saltLen + 2, 11]
            : [11, 1 + 8 + this.spec.saltLen + 2];
          for (const hsize of candidates) {
            if (this.decBuffer.length < hsize + 16) continue;
            const plain = await aeadOpen(this.spec, this.decKey, this.decNonce, this.decBuffer.subarray(0, hsize + 16));
            if (!plain) continue;
            const type = plain[0];
            const ts = plain.subarray(1, 9).reduce((a, b) => a * 256 + b, 0);
            if (type === 1 && hsize !== 1 + 8 + this.spec.saltLen + 2) continue;
            if (type === 0 && hsize !== 11) continue;
            if (type !== 0 && type !== 1) continue;
            /* SIP022 §3.1.3: a timestamp outside the window MUST be rejected —
               that is the replay defence of the 2022 edition */
            if (type === 0) {
              const window = Number(this.tsWindow || 0);
              if (window > 0) {
                const secs = ts > 1e12 ? Math.floor(ts / 1000) : ts;
                const skew = Math.abs(Math.floor(Date.now() / 1000) - secs);
                if (skew > window) return { pieces, error: 'timestamp-out-of-window' };
              }
            }
            length = (plain[hsize - 2] << 8) | plain[hsize - 1];
            headerLen = hsize + 16;          // the sealed header, tag included
            incNonce(this.decNonce);                             // the header used one nonce
            break;
          }
          if (length === null) {
            const maxNeed = 1 + 8 + this.spec.saltLen + 2 + 16;
            if (this.decBuffer.length >= maxNeed) return { pieces, error: 'auth-failed(header)' };
            break;
          }
        } else {
          const need = 2 + 16;
          if (this.decBuffer.length < need) break;
          const lenPlain = await aeadOpen(this.spec, this.decKey, this.decNonce, this.decBuffer.subarray(0, need));
          if (!lenPlain) return { pieces, error: 'auth-failed(length)' };
          incNonce(this.decNonce);                               // length and body each use one nonce
          length = (lenPlain[0] << 8) | lenPlain[1];
          headerLen = need;
        }
        const maxPayload = this.spec.family === '2022' ? 0xffff : MAX_PAYLOAD;
        if (length > maxPayload) return { pieces, error: 'chunk-too-big' };
        if (this.decBuffer.length < headerLen + length + 16) break;  // wait for more
        const bodySealed = this.decBuffer.subarray(headerLen, headerLen + length + 16);
        const body = await aeadOpen(this.spec, this.decKey, this.decNonce, bodySealed);
        if (!body) return { pieces, error: 'auth-failed(payload)' };
        incNonce(this.decNonce);
        this.decBuffer = this.decBuffer.subarray(headerLen + length + 16);
        pieces.push(body);
        this.stat.down += body.length;
      }
      return { pieces };
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * SS over WebSocket — server side
   * ═══════════════════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════════════════════════════
   * Credential fan-out — Shadowsocks has no in-band key exchange: the server
   * must already know a password to notice that a stream is addressed to it.
   * So the server keeps a *set* of credentials and tries them in order:
   *   1. env.SS_PASSWORD            (operator override, always wins)
   *   2. the deployment keys       (self-minted on first boot, kept in KV)
   *   3. every per-user credential (indexed when its subscription is built)
   * The first credential that authenticates identifies the user, which is what
   * makes the per-user quota cut-off work for this protocol too.  With no
   * credential at all the endpoint answers a decoy instead of a diagnostic —
   * a 503 that names an environment variable is a gift to an active prober.
   * ═══════════════════════════════════════════════════════════════════════ */
  const MASTER_SECRET_KEY = 'qv:keys:ssmaster';
  const USERKEY_CACHE = QV.cache('ssUserKeys', { max: 2048, maxBytes: 768 * 1024, ttl: 300000 });
  const MSTORE = QV.cache('ssMaster', { max: 4, maxBytes: 8192, ttl: 60000 });

  /** the deployment secret the per-user keys are derived from — it is never
   *  stored per user and never handed out; rotate it and every credential the
   *  server accepts changes with it */
  const deriveMaster = async (env) => {
    const hit = MSTORE.get('m');
    if (hit) return hit;
    let raw = null;
    const fromEnv = env.SS_MASTER_SECRET || env.SS_SECRET || '';
    if (fromEnv) raw = /^[A-Za-z0-9+/=_-]{24,}$/.test(fromEnv) ? QV.b64.dec(fromEnv) : QV.utf8(fromEnv);
    if (!raw || raw.length < 16) {
      let stored = await QV.safeAsync(() => QV.d1.Kv.get(env, MASTER_SECRET_KEY, null), null);
      if (!stored) { stored = QV.b64.enc(QV.rand(32)); await QV.safeAsync(() => QV.d1.Kv.set(env, MASTER_SECRET_KEY, stored, 0), null); }
      raw = QV.b64.dec(stored);
    }
    MSTORE.set('m', raw);
    return raw;
  };

  /** UserKey = HKDF-SHA256(ikm = MASTER_SECRET, salt = UUID, info = label)
   *  → a 32-byte PSK (SS-2022) and, truncated, an AEAD password.  The key is
   *  reproducible from the master alone, so no per-user secret is stored in
   *  the database; the entry in KV (qv:ss:<uuid>) stays only as the legacy
   *  credential that already shipped, nothing is removed. */
  const derivedCreds = async (env, uuid) => {
    if (!uuid) return null;
    const hit = USERKEY_CACHE.get(uuid);
    if (hit) { QV.count('ss_derive_cache_hit'); return hit; }
    const master = await QV.safeAsync(() => deriveMaster(env), null);
    if (!master) return null;
    const k = await C.hkdf('SHA-256', master, QV.utf8(uuid), QV.utf8(DERIVE_LABEL), 32);
    const out = {
      uuid,
      key2022: QV.b64.enc(k),
      legacy: QV.hex(k.subarray(0, 12)),          // 24 alphanumerics, EVP_BytesToKey input
      label: DERIVE_LABEL,
    };
    USERKEY_CACHE.set(uuid, out, 300000);
    return out;
  };

  const MASTER2022 = 'qv:keys:ss2022';
  const MASTERLEG = 'qv:keys:sslegacy';
  const SS_INDEX = 'qv:ss:index';
  const SS_REV = 'qv:ss:rev';          // bumped whenever a credential is added
  const SS_CACHE = new Map();          // per-isolate; a revision check keeps it honest

  /** mint the two deployment-wide credentials once and remember them */
  const ensureMaster = async (env) => {
    const hit = SS_CACHE.get('master');
    if (hit && Date.now() - hit.at < 60000) return hit.value;
    let twoK = await QV.d1.Kv.get(env, MASTER2022, null);
    if (!twoK) { twoK = QV.b64.enc(QV.rand(32)); await QV.d1.Kv.set(env, MASTER2022, twoK, 0); }
    let legacy = await QV.d1.Kv.get(env, MASTERLEG, null);
    if (!legacy) { legacy = QV.b64.enc(QV.rand(18)).replace(/[^A-Za-z0-9]/g, '').slice(0, 24); await QV.d1.Kv.set(env, MASTERLEG, legacy, 0); }
    const value = { twoK, legacy };
    SS_CACHE.set('master', { at: Date.now(), value });
    return value;
  };

  /** remember a user's credential so an incoming stream can be attributed */
  const indexAdd = async (env, uuid) => {
    try {
      const list = (await QV.d1.Kv.get(env, SS_INDEX, [])) || [];
      if (!list.includes(uuid)) {
        list.push(uuid);
        while (list.length > 200) list.shift();               // bounded: KV value size
        await QV.d1.Kv.set(env, SS_INDEX, list, 0);
        await QV.d1.Kv.set(env, SS_REV, Date.now(), 0);       // invalidates every isolate
      }
      SS_CACHE.delete('index');
      return true;
    } catch (e) { return false; }
  };

  /** all per-user credentials currently on file — one cheap revision check */
  const userCreds = async (env) => {
    let rev = null;
    try { rev = await QV.d1.Kv.get(env, SS_REV, 0); } catch (e) { /* treat as unknown */ }
    const hit = SS_CACHE.get('index');
    if (hit && rev !== null && hit.rev === rev) return hit.value;
    const out = [];
    try {
      const list = (await QV.d1.Kv.get(env, SS_INDEX, [])) || [];
      for (const uuid of list.slice(-48)) {
        const rec = await QV.d1.Kv.get(env, 'qv:ss:' + uuid, null);
        if (!rec) continue;
        const r = Array.isArray(rec) ? { legacy: String(rec[0] || ''), key2022: String(rec[1] || '') } : rec;
        const cred = { uuid, legacy: r.legacy, key2022: r.key2022 };
        if (cred.legacy || cred.key2022) out.push(cred);
      }
    } catch (e) { /* an unreadable index only costs us per-user isolation */ }
    SS_CACHE.set('index', { at: Date.now(), rev, value: out });
    return out;
  };

  /** a stream nobody could open: the next attempt should re-read the index */
  const invalidate = () => SS_CACHE.delete('index');

  /** ordered credential candidates for one incoming stream.
   *  Order matters: the first candidate that authenticates identifies the
   *  user, and every candidate costs one KDF, so the most likely ones go
   *  first and the list is capped.  A client that knows its own short id can
   *  say so (`?u=<8 hex>` or `/ss/<8 hex>`): then its credentials are tried
   *  first, which keeps the first-packet cost flat as the user count grows. */
  const candidates = async (env, want, hint = null) => {
    const out = [];
    const push = (password, cipher, uuid) => {
      if (!password) return;
      if (out.length >= MAX_TRIALS) return;
      if (out.some(c => c.password === password && c.cipher === cipher)) return;
      out.push({ password: String(password), cipher, uuid: uuid || null });
    };
    if (env.SS_PASSWORD) push(env.SS_PASSWORD, env.SS_CIPHER || '2022-blake3-chacha20-poly1305', env.SS_UUID || null);
    const master = await QV.safeAsync(() => ensureMaster(env), null);
    const list = await userCreds(env);
    const keyed = list.filter(u => u.uuid);
    /* 1. the hinted account: one KDF instead of twenty-four */
    const h = String(hint || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8);
    const hinted = h.length === 8 ? keyed.find(u => String(u.uuid).toLowerCase().startsWith(h)) : null;
    if (hinted) {
      const d = await QV.safeAsync(() => derivedCreds(env, hinted.uuid), null);
      if (d) { push(d.key2022, '2022-blake3-chacha20-poly1305', hinted.uuid); push(d.legacy, 'aes-128-gcm', hinted.uuid); }
      push(hinted.key2022, '2022-blake3-chacha20-poly1305', hinted.uuid);
      push(hinted.legacy, 'aes-128-gcm', hinted.uuid);
    }
    if (master) {
      push(master.twoK, '2022-blake3-chacha20-poly1305', null);
      push(master.legacy, 'aes-128-gcm', null);
    }
    /* 2. every account that has been active recently, by derivation */
    for (const u of keyed.slice(-16)) {
      if (hinted && u.uuid === hinted.uuid) continue;
      const d = await QV.safeAsync(() => derivedCreds(env, u.uuid), null);
      if (d) push(d.key2022, '2022-blake3-chacha20-poly1305', u.uuid);
    }
    /* 3. the credentials that were minted before the derivation existed */
    for (const u of keyed.slice(-16)) {
      const d = await QV.safeAsync(() => derivedCreds(env, u.uuid), null);
      push(u.key2022, '2022-blake3-chacha20-poly1305', u.uuid);
      if (d) push(d.legacy, 'aes-128-gcm', u.uuid);
      push(u.legacy, 'aes-128-gcm', u.uuid);
    }
    if (want) out.sort((a, b) => (b.cipher === want ? 1 : 0) - (a.cipher === want ? 1 : 0));
    return out;
  };

  /** a decoy that says nothing at all about what this endpoint really is */
  const notHere = async (env, ctx) => {
    const decoy = QV.safeAsync(() => QV.antidpi.tarpitFor(env, ctx, null, 200), null);
    const r = await decoy;
    if (r instanceof Response) return r;
    return new Response('<html><head><title>404 Not Found</title></head><body><h1>Not Found</h1></body></html>',
      { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  };

  const handleSSConnection = async (request, env, ctx, clientIP, opts = {}) => {
    const upgrade = request.headers.get('Upgrade') || '';
    if (upgrade.toLowerCase() !== 'websocket') {
      return new Response('Upgrade required', { status: 426 });
    }
    const url = new URL(request.url);
    const prefer = opts.cipher || url.searchParams.get('c') || env.SS_CIPHER || '2022-blake3-chacha20-poly1305';
    /* the short id in the URL (or the 8-hex tail of the path) tells the server
       whose credentials to try first: the first packet then costs one KDF
       instead of one per account.  It is a hint, never a requirement — a
       credential with no hint still works, just slower to identify. */
    const tail = (url.pathname.split('/').filter(Boolean).pop() || '');
    const hint = url.searchParams.get('u') || (/^[0-9a-f]{8}$/i.test(tail) ? tail : null);
    const pool = opts.password
      ? [{ password: String(opts.password), cipher: prefer, uuid: env.SS_UUID || null }]
      : await candidates(env, prefer, hint);
    /* nothing to decrypt with → behave like a plain web server, reveal nothing */
    if (!pool.length) return notHere(env, ctx);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    /* every byte the server writes goes through the shaper */
    const sendShaped = shapeStream(server, env);

    let stream = null;                    // the trial that authenticated
    let cursor = 0;                       // its position in the credential pool
    let trials = null;                    // every credential still in the running
    let winner = null;
    let remote = null, remoteWriter = null, closed = false;
    const sessionId = QV.uuid();
    const started = Date.now();
    let uuid = null;

    const closeAll = (reason) => {
      if (closed) return; closed = true;
      const st = stream ? stream.stat : { up: 0, down: 0 };      // never identified
      QV.safe(() => remote && remote.close());
      QV.safe(() => server.close(1000, reason || 'done'));
      if (uuid) {
        QV.safeAsync(() => QV.d1.Sessions.close(env, sessionId, reason, st.up, st.down));
        /* Usage is aggregated in isolate RAM and written in one batched round
           trip — never a D1 write per packet, and never a KV write per packet.
           A short session leaves its bytes in the map for the 60 s meter tick;
           a fat or long one is flushed right away so a cut-off cannot lag. */
        QV.safeAsync(async () => {
          QV.d1.Sessions.meterDeferred(env, uuid, st.up, st.down, sessionId, ctx);
          /* the close is the natural flush point: one batched write per
             session instead of one per packet, and the account's counters are
             current the moment the tunnel ends */
          await QV.d1.Sessions.flushMeters(env, ctx, { uuid });
        });
      }
      QV.emit(env, 'ss:close', 'info', { uuid, ip: clientIP, message: reason || 'closed', ctx, meta: { up: st.up, down: st.down, ms: Date.now() - started } });
    };

    /* a WebSocket frame may arrive as ArrayBuffer, as a typed array, as a Blob
       or — from a text sender — as a string; all four must be readable */
    const asBytes = async (d) => {
      if (d == null) return new Uint8Array(0);
      if (d instanceof ArrayBuffer) return new Uint8Array(d);
      if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      if (typeof Blob !== 'undefined' && d instanceof Blob) return new Uint8Array(await d.arrayBuffer());
      if (typeof d === 'string') return QV.utf8(d);
      return QV.utf8(String(d));
    };

    /* a running stream is re-checked now and then: a kill-switch or a spent
       quota must end it, not only the next connection attempt */
    let guard = 0;
    const stillAllowed = async () => {
      if (!uuid || ++guard % 32 !== 0) return true;
      /* tier 1: isolate RAM (≈0 µs).  Tier 2: the KV snapshot the metering
         path keeps warm.  Tier 3: D1, only on a cold cache.  A revoked or
         over-quota account is cut on the very next check. */
      const verdict = await QV.safeAsync(() => QV.d1.Users.allowed(env, uuid), null);
      if (verdict && !verdict.ok && verdict.reason !== 'unknown') { closeAll('revoked'); return false; }
      return true;
    };

    let frames = 0;
    /* Frames must be consumed strictly in order: the AEAD state (salt, nonce
       counter, read buffer) is a stream, not a set of messages.  The runtime
       may deliver several frames before the previous handler returned, so the
       whole identification + decrypt pipeline runs on a promise chain. */
    const onFrame = async (event) => {
      try {
        const data = await asBytes(event.data);
        let pieces;
        if (env.SS_DEBUG) QV.log.warn('ss-dbg', 'frame', { n: ++frames, bytes: data.length, type: Object.prototype.toString.call(event.data) });

        /* ── identification: Shadowsocks carries no user identity, so every
           candidate credential stays in the running until one of them
           authenticates (a salt is 16 bytes for the legacy ciphers and 32 for
           2022, so guessing from a single frame would be wrong).  The survivor
           identifies the user — that is what makes the per-user cut-off and
           the traffic accounting work for this protocol as well. ─────────── */
        if (!stream) {
          if (!trials) {
            trials = pool.map((cand, i) => ({ i, cand, s: new SSStream({ cipher: cand.cipher, password: cand.password, isServer: true }) }));
          }
          /* a salt that was already seen is an active-probing replay: the
             socket dies without one byte of answer */
          for (const t of trials) {
            if (t.dead || t.s.decKey) continue;
            const need = t.s.spec.saltLen;
            if (data.length < need) continue;
            const saltKey = t.s.cipher + ':' + QV.hex(data.subarray(0, need));
            const seen = SALT_SEEN.get(saltKey);
            if (seen) {
              QV.metrics.count('ss_salt_replay', 1);
              QV.emit(env, 'ss:replay', 'warn', { ip: clientIP, message: 'salt replayed', ctx, meta: { cipher: t.s.cipher } });
              return closeAll('salt-replay');
            }
            SALT_SEEN.set(saltKey, 1, 180000);
            break;                       // the salt is the same for every 2022 trial
          }
          for (const t of trials) {
            if (t.dead) continue;
            const r = await QV.safeAsync(() => t.s.pull(data), { error: 'threw' });
            if (env.SS_DEBUG) QV.log.warn('ss-dbg', 'trial', { cipher: t.cand.cipher, uuid: String(t.cand.uuid || '-'), error: (r && r.error) || '-', pieces: (r && r.pieces || []).length, salt: !!t.s.decKey });
            if (!r || r.error) { t.dead = true; continue; }
            if (r.pieces && r.pieces.length) { if (!winner) { winner = t; pieces = r.pieces; } }
          }
          trials = trials.filter(t => !t.dead);
          if (winner) {
            stream = winner.s; cursor = winner.i;
            /* a 2022 response stream repeats the request salt in its header */
            stream.remoteSalt = stream.decSalt;
            uuid = winner.cand.uuid || env.SS_UUID || null;
            if (uuid) {
              /* the verdict comes from isolate RAM (KV snapshot, D1 last) */
              const verdict = await QV.safeAsync(() => QV.d1.Users.allowed(env, uuid), null);
              if (verdict && !verdict.ok) return closeAll(verdict.reason === 'unknown' ? 'unidentified' : 'revoked');
              QV.safeAsync(() => QV.d1.Sessions.open(env, { id: sessionId, uuid, ip: clientIP, transport: 'ss-aead', ua: request.headers.get('user-agent') }))
                .then((sid) => { if (env.SS_DEBUG) QV.log.warn('ss-dbg', 'session open', { sid: String(sid), uuid }); },
                      (err) => { if (env.SS_DEBUG) QV.log.warn('ss-dbg', 'session open FAILED', { err: String(err && err.message) }); });
            }
            QV.emit(env, 'ss:auth', 'info', { uuid, ip: clientIP, message: 'credential accepted', ctx,
              meta: { cipher: winner.cand.cipher, tried: cursor + 1, candidates: pool.length } });
          } else if (!trials.length) {
            /* nothing fits: answer exactly like a web server that never offered
               this endpoint — no diagnostic, no dangling socket */
            invalidate();                  // a credential may have raced us
            QV.metrics.count('ss_unidentified', 1);
            QV.emit(env, 'ss:reject', 'warn', { ip: clientIP, message: 'no credential matched', ctx, meta: { candidates: pool.length } });
            return closeAll('unidentified');
          } else {
            return;                        // inconclusive so far: wait for more
          }
        } else {
          const r = await stream.pull(data);
          if (env.SS_DEBUG) QV.log.warn('ss-dbg', 'served frame', { bytes: data.length, error: r.error || '-', pieces: (r.pieces || []).length, buffered: stream.decBuffer.length });
          if (r.error) { QV.log.warn('ss', 'stream auth failed', { error: r.error, ip: clientIP }); return closeAll(r.error); }
          pieces = r.pieces;
        }

        for (const chunk of pieces) {
          if (!remote) {
            /* very first plaintext chunk carries the SOCKS5-style request header */
            const addr = decodeAddress(chunk);
            if (!addr) return closeAll('bad-address');
            let rest = chunk.subarray(addr.len);
            /* SIP022 §3.1.3: a 2022 request stream continues with a padding
               field — [padding length u16][padding] — before the initial
               payload.  Read it when it is there; a client that omits it (the
               0-length case is spelled the same way) is read as payload. */
            if (stream.spec.family === '2022' && rest.length >= 2) {
              const padLen = (rest[0] << 8) | rest[1];
              if (padLen <= (stream.maxPadding || 900) && rest.length >= 2 + padLen) {
                rest = rest.subarray(2 + padLen);
                QV.count('ss_padding_seen', padLen);
              }
            }
            const blocked = (env.BLOCKED_PORTS || '22,25,110,143,465,587,993,995,3389,5900,8080')
              .split(',').map(s => parseInt(s.trim(), 10));
            if (blocked.includes(addr.port)) return closeAll('blocked-port');

            /* SOCKS5-style: the socket is only opened after the address header */
            remote = connect({ hostname: addr.host, port: addr.port });
            remoteWriter = remote.writable.getWriter();
            QV.emit(env, 'ss:open', 'info', { uuid, ip: clientIP, message: `${addr.host}:${addr.port}`, ctx,
              meta: { transport: 'ss-aead', cipher: pool[cursor].cipher } });

            /* pipe remote -> client (encrypted) */
            (async () => {
              const reader = remote.readable.getReader();
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done || !value || !value.length) break;
                  stream.stat.down += value.length;                 // counted once
                  if (env.SS_DEBUG) QV.log.warn('ss-dbg', 'upstream read', { done: !!done, bytes: value.length });
                  if (!(await stillAllowed())) break;
                  /* push() returns one buffer (salt, length, body) for the wire */
                  const wire = await stream.push(value);
                  try { await sendShaped(wire); }
                  catch (e) { QV.log.warn('ss', 'downstream send failed', { err: e && e.message }); break; }
                }
              } catch (e) { QV.log.warn('ss', 'upstream read failed', { err: e?.message }); }
              finally { closeAll('eof'); }
            })();

            if (rest.length) { await remoteWriter.write(rest); stream.stat.up += rest.length; }
          } else if (chunk.length) {
            if (env.SS_DEBUG) QV.log.warn('ss-dbg', 'upstream write', { bytes: chunk.length, hasWriter: !!remoteWriter });
            if (!(await stillAllowed())) return;
            if (remoteWriter) await remoteWriter.write(chunk);
            stream.stat.up += chunk.length;
          }
        }
      } catch (e) {
        QV.log.error('ss', 'message handling failed', { err: e?.message });
        closeAll('error');
      }
    };
    let chain = Promise.resolve();
    server.addEventListener('message', (event) => {
      chain = chain.then(() => onFrame(event)).catch((e) => {
        QV.log.error('ss', 'frame pipeline failed', { err: e && e.message });
        closeAll('error');
      });
    });
    server.addEventListener('close', () => closeAll('client-close'));
    server.addEventListener('error', (e) => { QV.log.warn('ss', 'ws error', { err: e?.message || 'unknown' }); closeAll('ws-error'); });

    return new Response(null, { status: 101, webSocket: client });
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * SS UDP relay (used by the DNS forwarder for udp/53 + NAT64)
   *   Datagram layout (Shadowsocks UDP): [ATYP ADDR PORT][payload]
   * ═══════════════════════════════════════════════════════════════════════ */
  /** one spelling for every host: strips [brackets], lowercases, keeps the
   *  canonical IPv6 form so comparisons between headers never misfire */
  const canonicalHost = (host) => {
    const h = String(host == null ? '' : host).trim();
    if (!h) return '';
    const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
    if (!bare.includes(':')) return bare.toLowerCase();
    const v6 = parseV6(bare);
    return v6 ? formatV6(v6) : bare.toLowerCase();
  };

  const encodeUdp = (host, port, payload) => C.concat(encodeAddress(host, port), payload);
  const decodeUdp = (buf) => {
    const addr = decodeAddress(buf);
    if (!addr) return null;
    return { host: addr.host, port: addr.port, payload: buf.subarray(addr.len) };
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * ANTI-FINGERPRINT SHAPING
   *   DPI heuristics key on frame sizes and inter-frame timing.  Neither can
   *   be changed inside the AEAD stream without breaking the client, but both
   *   can be changed *below* it: a WebSocket frame is transparent to the
   *   stream, so the server may split its writes at random and space the
   *   first few of them.  The peer reassembles exactly the same bytes.
   * ═══════════════════════════════════════════════════════════════════════ */
  const shapeCfg = (env) => {
    const mode = String((env && (env.QV_SHAPE || env.SHAPE_MODE)) || 'auto').toLowerCase();
    const off = mode === '0' || mode === 'off' || mode === 'false';
    return {
      on: !off,
      maxPiece: Math.max(600, Math.min(8000, parseInt((env && env.QV_SHAPE_PIECE) || '1300', 10) || 1300)),
      jitterMs: off ? 0 : Math.max(0, Math.min(40, parseInt((env && env.QV_SHAPE_JITTER) || '4', 10) || 0)),
      jitterFrames: Math.max(0, Math.min(64, parseInt((env && env.QV_SHAPE_FRAMES) || '10', 10) || 0)),
    };
  };
  const randInt = (n) => (n > 0 ? Math.floor(Math.random() * n) : 0);

  /** send one logical chunk as one or more randomly sized frames */
  const shapeSend = async (server, wire, state = {}) => {
    if (!wire || !wire.length) return 0;
    const cfg = state.cfg || (state.cfg = shapeCfg(state.env || {}));
    let sent = 0;
    if (!cfg.on || wire.length <= 64) { server.send(wire); return 1; }
    let off = 0;
    while (off < wire.length) {
      const piece = Math.min(wire.length - off, cfg.maxPiece - randInt(Math.floor(cfg.maxPiece / 3)));
      server.send(off === 0 && piece === wire.length ? wire : wire.subarray(off, off + piece));
      off += piece; sent++;
      if (state.frames === undefined) state.frames = 0;
      if (++state.frames <= cfg.jitterFrames && cfg.jitterMs > 0 && off < wire.length) {
        await new Promise((r) => setTimeout(r, randInt(cfg.jitterMs + 1)));
      }
    }
    return sent;
  };
  /** the same shaping for any byte pipeline (used by the VLESS handler too) */
  const shapeStream = (server, env) => {
    const state = { env, cfg: null, frames: 0 };
    return (wire) => shapeSend(server, wire, state);
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * URI generation (ss://) for the per-user config page
   * ═══════════════════════════════════════════════════════════════════════ */
  const buildUri = ({ host, port = 443, cipher, password, label = 'QV', path = '/ws', tls = true, sni }) => {
    const userinfo = QV.b64.url(QV.utf8(`${cipher}:${password}`));
    const q = new URLSearchParams();
    if (tls) q.set('security', 'tls');
    if (sni) q.set('sni', sni);
    q.set('type', 'ws');
    q.set('host', host);
    q.set('path', path);
    return `ss://${userinfo}@${host}:${port}?${q.toString()}#${encodeURIComponent(label)}`;
  };

  /* the router wants one entry point per transport; both share the codec */
  const handleWS = (request, env, ctx, clientIP) => handleSSConnection(request, env, ctx, clientIP, { transport: 'ws' });
  const handleTCP = (request, env, ctx, clientIP) => handleSSConnection(request, env, ctx, clientIP, { transport: 'http' });

  /** what the operator sees: which credentials exist, derived or stored */
  const audit = async (env) => {
    const list = await userCreds(env);
    const rows = [];
    for (const u of list.slice(-50)) {
      const d = await QV.safeAsync(() => derivedCreds(env, u.uuid), null);
      rows.push({ uuid: u.uuid, short: String(u.uuid).slice(0, 8), derived: !!d,
        derived_fp: d ? QV.hex(QV.utf8(d.key2022)).slice(0, 8) : null,
        stored_fp: u.key2022 ? QV.hex(QV.utf8(u.key2022)).slice(0, 8) : null,
        legacy: !!u.legacy });
    }
    return { count: rows.length, hint_style: 'short 8-hex id in the URL or the path tail',
      label: DERIVE_LABEL, triallimit: MAX_TRIALS, salt_cache: SALT_SEEN.stats(), key_cache: KEY_CACHE.stats(), users: rows };
  };

  return { handleWS, handleTCP, indexAdd, invalidate, candidates, ensureMaster, userCreds, CIPHERS, SSStream, handleSSConnection, deriveSubkey, encodeAddress, decodeAddress, parseV6, formatV6,
    derivedCreds, deriveMaster, audit, shapeSend, shapeStream, shapeCfg, shortId: QV.shortId, caches: () => ({ keys: KEY_CACHE.stats(), salt: SALT_SEEN.stats(), users: USERKEY_CACHE.stats() }),
    canonicalHost, encodeUdp, decodeUdp, buildUri, masterKeyFromPassword, randomPassword, MAX_PAYLOAD };
})();
