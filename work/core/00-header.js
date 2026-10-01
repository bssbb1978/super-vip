/* ═══════════════════════════════════════════════════════════════════════════════
 * ██████╗ ██╗   ██╗ █████╗ ███╗   ██╗████████╗██╗   ██╗███╗   ███╗
 * ██╔═══██╗██║   ██║██╔══██╗████╗  ██║╚══██╔══╝██║   ██║████╗ ████║
 * ██║   ██║██║   ██║███████║██╔██╗ ██║   ██║   ██║   ██║██╔████╔██║
 * ██║▄▄ ██║██║   ██║██╔══██║██║╚██╗██║   ██║   ██║   ██║██║╚██╔╝██║
 * ╚██████╔╝╚██████╔╝██║  ██║██║ ╚████║   ██║   ╚██████╔╝██║ ╚═╝ ██║
 *  ╚═══▀▀  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝
 *
 *  QUANTUM VLESS ULTIMATE — UNIFIED SINGLE-FILE EDITION
 *  Version 25.0.0-UNIFIED-SINGULARITY
 *  ───────────────────────────────────────────────────────────────────────────
 *  ⚠️  This is ONE file. It runs on Cloudflare Workers AND Cloudflare Pages
 *      (Pages Functions: put it at  functions/_worker.js  or  /_worker.js ).
 *
 *  WHAT THIS FILE IS
 *  ─────────────────
 *  Every one of the 11 independent worker editions that were previously
 *  concatenated into `index1.js` has been kept **byte-for-byte, feature for
 *  feature** and is now hosted inside an isolated scope (__QF_UNIT_xx), wired
 *  together by a lazy-resolution bridge so that the cross-references that were
 *  previously dead (call sites without a definition) are now LIVE.
 *
 *  Layers of this file
 *  ───────────────────
 *   A. NEW UNIFIED CORE (this section)
 *        · single configuration with env overrides + validation
 *        · D1 schema, migrations and repositories (everything lives in D1)
 *        · dynamic "strongest available" Workers-AI model selector
 *        · AI-driven anti-DPI engine + adaptive anti-censorship orchestrator
 *        · Shadowsocks AEAD (2022 + legacy: chacha20-poly1305, aes-*-gcm)
 *        · DNS-forward for UDP/53 (DNS-over-HTTPS) + NAT64
 *        · Telegram bot with FSM persisted in D1
 *        · per-user kill-switch, per-config revocation, quotas
 *        · in-worker self-test suite
 *   B. GENERATION UNITS  (all 11 originals, untouched logic)
 *   C. UNIFIED ROUTER    (fetch / scheduled / queue entry points)
 *
 *  DEPLOY
 *  ──────
 *    1. wrangler d1 create qvu-db          → put the id into wrangler.toml
 *    2. wrangler kv namespace create QVU_KV
 *    3. define secrets:  ADMIN_PASSWORD, JWT_SECRET, API_SECRET_TOKEN,
 *       TELEGRAM_BOT_TOKEN, BRIDGE_SECRET
 *       (ADMIN_TELEGRAM_ID is optional — see step 6)
 *    4. wrangler deploy
 *    5. open  https://<your-worker>/admin   (first run migrates the schema)
 *    6. bind Telegram: tab 🔐 → "New claim code" → send `/claim CODE` in a
 *       private chat with the bot.  That chat becomes the owner and is stored
 *       in D1 (qv_admins), so no admin id ever lives in a secret, a var, a URL
 *       or a log line.  See work/core/31-owner.js.
 *
 *  NOTE: no `worker.js` name tokens such as "vpn"/"proxy" are used in URLs,
 *  route names or UI strings — see the naming rules in the security section.
 * ═════════════════════════════════════════════════════════════════════════════ */

'use strict';

import { connect } from 'cloudflare:sockets';

/* ═══════════════════════════════════════════════════════════════════════════
 * A0 · UNIFIED RUNTIME — configuration, utilities, tiny fast primitives
 * ═══════════════════════════════════════════════════════════════════════════ */

const QV = Object.create(null);          // namespace for the new core
QV.VERSION = '25.0.0-UNIFIED-SINGULARITY';
QV.BUILD = '2026-09-30';
QV.EDITION = 'AUTONOMOUS-CORE + 11 GENERATIONS';

/** non-fatal error sink (never throws) */
QV.safe = (fn, fallback = null) => {
  try { return fn(); } catch (e) {
    try { console.warn('[qv:soft-fail]', e && e.message); } catch (_) {}
    return fallback;
  }
};
QV.safeAsync = async (fn, fallback = null) => {
  try { return await fn(); } catch (e) {
    try {
      /* the first frames matter: a soft-failed call must be locatable */
      const at = String((e && e.stack) || '').split('\n')[1] || '';
      console.warn('[qv:soft-fail]', e && e.message, at.trim().slice(0, 120));
    } catch (_) {}
    return fallback;
  }
};

/* ---------- encoders / hashes -------------------------------------------- */
QV.enc = new TextEncoder();
QV.dec = new TextDecoder();

/* a string handed to a byte-oriented helper used to become an EMPTY buffer
   (`new Uint8Array('abc').length === 0`), which silently produced empty
   subscriptions and keys.  Strings are now UTF-8 encoded instead. */
const __asBytes = (v) => {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return QV.utf8(v);
  if (v == null) return new Uint8Array(0);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  try { return new Uint8Array(v); } catch (e) { return QV.utf8(String(v)); }
};
QV.b64 = {
  enc: (bytes) => {
    let s = '';
    const b = __asBytes(bytes);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec: (str) => {
    const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
  url: (bytes) => QV.b64.enc(__asBytes(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  unurl: (s) => QV.b64.dec(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)),
  /* historic spellings; `dec` already tolerates url-safe input */
  urlDec: (s) => QV.b64.dec(s),
  std: (bytes) => QV.b64.enc(__asBytes(bytes)),
  fromStd: (str) => QV.b64.dec(str),
  bytes: (str) => QV.b64.dec(str),
};

QV.uuid = () => crypto.randomUUID();
QV.isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
QV.rand = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; };
QV.hex = (bytes) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  .map(b => b.toString(16).padStart(2, '0')).join('');
QV.unhex = (h) => new Uint8Array((String(h).match(/.{1,2}/g) || []).map(b => parseInt(b, 16)));
QV.utf8 = (s) => QV.enc.encode(String(s));

QV.sha256 = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? QV.utf8(data) : data));
QV.hmac = async (keyBytes, msgBytes, algo = 'HMAC', hash = 'SHA-256') => {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: algo, hash }, false, ['sign', 'verify']);
  return new Uint8Array(await crypto.subtle.sign(algo, key, msgBytes));
};
QV.hmacHex = async (secret, msg) => QV.hex(await QV.hmac(QV.utf8(secret), QV.utf8(msg)));
/* keyed-hash spelling the Telegram layer uses: hmacSha256(keyBytes, msgBytes) */
QV.hmacSha256 = QV.hmacSha256 || ((key, msg) => QV.hmac(key, msg, 'HMAC', 'SHA-256'));
QV.timingSafeEqual = (a, b) => {
  const x = typeof a === 'string' ? QV.utf8(a) : a, y = typeof b === 'string' ? QV.utf8(b) : b;
  if (!x || !y || x.length !== y.length) return false;
  let out = 0; for (let i = 0; i < x.length; i++) out |= x[i] ^ y[i];
  return out === 0;
};

QV.base64urlDecodeToString = (s) => QV.dec.decode(QV.b64.unurl(s));
QV.base64urlEncodeString = (s) => QV.b64.url(QV.utf8(s));

/** compact JWT (HS256) - used by the admin/user sessions of the new core */
QV.jwt = {
  sign: async (payload, secret, ttlSec = 86400) => {
    const header = { alg: 'HS256', typ: 'JWT' };
    const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSec };
    const p1 = QV.base64urlEncodeString(JSON.stringify(header));
    const p2 = QV.base64urlEncodeString(JSON.stringify(body));
    const sig = QV.b64.url(await QV.hmac(QV.utf8(secret), QV.utf8(p1 + '.' + p2)));
    return `${p1}.${p2}.${sig}`;
  },
  verify: async (token, secret) => {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const expected = QV.b64.url(await QV.hmac(QV.utf8(secret), QV.utf8(parts[0] + '.' + parts[1])));
    if (!QV.timingSafeEqual(expected, parts[2])) return null;
    const payload = JSON.parse(QV.base64urlDecodeToString(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  },
};

/* ---------- misc helpers ------------------------------------------------- */
QV.sleep = (ms) => new Promise(r => setTimeout(r, ms));
QV.now = () => Date.now();
QV.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
QV.pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
QV.get = (obj, path, dflt) => String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) ?? dflt;
QV.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
QV.formatBytes = (n) => {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 2 : 0)} ${u[i]}`;
};
QV.formatDuration = (ms) => {
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
};

/** tiny in-isolate LRU with TTL — first line of defence before D1/KV */
class QVLru {
  constructor(max = 500, ttl = 30000) { this.max = max; this.ttl = ttl; this.m = new Map(); this.hits = 0; this.misses = 0; }
  get(k) {
    const e = this.m.get(k);
    if (!e) { this.misses++; return undefined; }
    if (e.exp && e.exp < Date.now()) { this.m.delete(k); this.misses++; return undefined; }
    this.m.delete(k); this.m.set(k, e); this.hits++; return e.v;
  }
  set(k, v, ttl = this.ttl) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value);
    this.m.set(k, { v, exp: ttl ? Date.now() + ttl : 0 });
    return v;
  }
  delete(k) { return this.m.delete(k); }
  has(k) { const e = this.m.get(k); return !!e && (!e.exp || e.exp > Date.now()); }
  clear() { this.m.clear(); }
  keys() { return [...this.m.keys()]; }
  stats() { return { size: this.m.size, hits: this.hits, misses: this.misses, hitRate: (this.hits / Math.max(1, this.hits + this.misses)).toFixed(3) }; }
}
QV.lru = new QVLru(2000, 60000);

/* ═══════════════════════ bounded in-isolate store ═══════════════════════
 * Every cache in this worker is built from QVStore: it is capped by entry
 * count *and* by approximate bytes, evicts in O(1) (Map insertion order is
 * the LRU order), honours a per-entry TTL and reports its own hit ratio.  A
 * Map without a byte cap is how an isolate reaches the 128 MB wall; there is
 * none of those left on the hot path.
 * ═════════════════════════════════════════════════════════════════════════ */
const qvApproxBytes = (v) => {
  if (v === null || v === undefined) return 16;
  const t = typeof v;
  if (t === 'number' || t === 'bigint') return 16;
  if (t === 'boolean') return 8;
  if (t === 'string') return 24 + v.length * 2;
  if (v instanceof ArrayBuffer) return 32 + v.byteLength;
  if (ArrayBuffer.isView(v)) return 48 + v.byteLength;
  if (t === 'object') {
    if (Array.isArray(v)) { let n = 32; for (let i = 0; i < v.length && i < 64; i++) n += qvApproxBytes(v[i]); return n; }
    let n = 48, seen = 0;
    for (const k in v) { if (++seen > 32) break; n += 16 + k.length * 2 + qvApproxBytes(v[k]); }
    return n;
  }
  return 24;
};
class QVStore {
  constructor(name, opts = {}) {
    this.name = name;
    this.max = opts.max || 500;
    this.maxBytes = opts.maxBytes || 512 * 1024;
    this.ttl = opts.ttl === undefined ? 30000 : opts.ttl;
    this.m = new Map();
    this.bytes = 0; this.hits = 0; this.misses = 0; this.evictions = 0; this.expired = 0;
  }
  get(k) {
    const e = this.m.get(k);
    if (!e) { this.misses++; return undefined; }
    if (e.exp && e.exp < Date.now()) { this.m.delete(k); this.bytes -= e.b; this.expired++; this.misses++; return undefined; }
    this.m.delete(k); this.m.set(k, e);                 // refresh recency
    this.hits++;
    return e.v;
  }
  peek(k) { const e = this.m.get(k); return e && (!e.exp || e.exp > Date.now()) ? e.v : undefined; }
  set(k, v, ttl = this.ttl) {
    const b = qvApproxBytes(v) + 24 + k.length * 2;
    const prev = this.m.get(k);
    if (prev) { this.m.delete(k); this.bytes -= prev.b; }
    this.m.set(k, { v, b, exp: ttl ? Date.now() + ttl : 0 });
    this.bytes += b;
    /* O(1) eviction: drop from the front until both caps hold */
    while (this.m.size > this.max || this.bytes > this.maxBytes) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined || oldest === k) break;
      const e = this.m.get(oldest); this.m.delete(oldest); this.bytes -= e.b; this.evictions++;
    }
    return v;
  }
  delete(k) { const e = this.m.get(k); if (e) { this.bytes -= e.b; this.m.delete(k); } return !!e; }
  has(k) { return this.get(k) !== undefined; }
  clear() { this.m.clear(); this.bytes = 0; }
  keys() { return [...this.m.keys()]; }
  hitRate() { return +(this.hits / Math.max(1, this.hits + this.misses)).toFixed(3); }
  stats() {
    return { name: this.name, size: this.m.size, max: this.max, bytes: this.bytes, max_bytes: this.maxBytes,
      ttl_s: Math.round(this.ttl / 1000), hits: this.hits, misses: this.misses, hit_rate: this.hitRate(),
      evictions: this.evictions, expired: this.expired };
  }
}
QV.QVStore = QVStore;
QV.caches = new Map();
/** named singleton cache — the same name always returns the same store */
QV.cache = (name, opts) => {
  let c = QV.caches.get(name);
  if (!c) { c = new QVStore(name, opts); QV.caches.set(name, c); }
  return c;
};
QV.cacheStats = () => [...QV.caches.values()].map(c => c.stats());
QV.cacheReset = () => { for (const c of QV.caches.values()) c.clear(); };
/** the memory the isolate spends on caches (budget: 128 MB per isolate) */
QV.memEstimate = () => {
  let bytes = 0;
  for (const c of QV.caches.values()) bytes += c.bytes;
  let lru = 0;
  try { for (const [, e] of QV.lru.m) lru += qvApproxBytes(e.v) + 64; } catch (err) {}
  const buckets = QV.bucket && QV.bucket.b instanceof Map ? QV.bucket.b.size * 96 : 0;
  return { caches_bytes: bytes, lru_bytes: lru, buckets_bytes: buckets, total_bytes: bytes + lru + buckets,
    budget_bytes: 128 * 1024 * 1024, pct_of_budget: +(((bytes + lru + buckets) / (128 * 1024 * 1024)) * 100).toFixed(3) };
};

/* ═══════════════════════ D1 parameter sanitizer ═════════════════════════
 * D1 accepts only null / number / bigint / string / bytes.  A merged legacy
 * path happily binds a Request or a nested object, which makes the whole
 * statement fail with D1_TYPE_ERROR and silently lose the row.  This is the
 * single place that turns those into storable values.                      */
QV.d1Sanitize = (v) => {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'bigint' || t === 'boolean') return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return v;
  if (t === 'object') {
    const tag = Object.prototype.toString.call(v);
    if (tag === '[object Date]') return v.getTime();
    if (tag === '[object Request]' || tag === '[object Response]') return JSON.stringify({ method: v.method, url: v.url });
    if (tag === '[object Blob]') return null;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  if (t === 'function' || t === 'symbol') return null;
  try { return String(v); } catch (e) { return null; }
};
QV.d1SanitizeAll = (params) => (params || []).map(QV.d1Sanitize);

/** counter helper that works even before the metrics module is loaded */
QV.count = (name, v = 1, labels) => { try { if (QV.metrics) QV.metrics.count(name, v, labels); } catch (e) {} };

/** token bucket rate limiter (in-isolate) */
class QVTokenBucket {
  constructor(ratePerMin = 120, burst = 40) { this.rate = ratePerMin / 60000; this.burst = burst; this.b = new Map(); }
  take(key, cost = 1) {
    const now = Date.now();
    let s = this.b.get(key);
    if (!s) { s = { tokens: this.burst, last: now }; this.b.set(key, s); }
    s.tokens = Math.min(this.burst, s.tokens + (now - s.last) * this.rate);
    s.last = now;
    if (this.b.size > 20000) this.b.clear();
    if (s.tokens >= cost) { s.tokens -= cost; return { ok: true, remaining: Math.floor(s.tokens) }; }
    return { ok: false, retryAfter: Math.ceil((cost - s.tokens) / this.rate / 1000) };
  }
}
QV.bucket = new QVTokenBucket(600, 120);

/* ---------- structured logger ------------------------------------------- */
QV.log = (level, component, message, details) => {
  const line = { t: new Date().toISOString(), level, component, message, ...(details ? { details } : {}) };
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  try { fn(JSON.stringify(line)); } catch (_) { fn(level, component, message); }
  return line;
};
QV.log.info = (c, m, d) => QV.log('info', c, m, d);
QV.log.warn = (c, m, d) => QV.log('warn', c, m, d);
QV.log.error = (c, m, d) => QV.log('error', c, m, d);

/* ---------- fetch with timeout + retry + jitter ------------------------- */
QV.fetchWithRetry = async (input, init = {}, opts = {}) => {
  const { retries = 2, timeoutMs = 15000, backoff = 400 } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(input, { ...init, signal: ac.signal });
      clearTimeout(timer);
      if (res.status >= 500 && attempt < retries) { await QV.sleep(backoff * (attempt + 1) + Math.random() * 200); continue; }
      return res;
    } catch (e) {
      clearTimeout(timer); lastErr = e;
      if (attempt < retries) await QV.sleep(backoff * (attempt + 1) + Math.random() * 200);
    }
  }
  throw lastErr || new Error('fetch failed');
};

/* ═══════════════════════════════════════════════════════════════════════════
 * A1 · DYNAMIC WORKERS-AI MODEL SELECTOR
 *      "always use the strongest model that currently exists"
 * ═══════════════════════════════════════════════════════════════════════════
 * The catalogue below mirrors https://developers.cloudflare.com/workers-ai/models/
 * Each entry carries capability weights. `resolve()` probes the binding at
 * runtime (cheap, cached) and returns the highest-scoring model that actually
 * answers; failures demote a model for a cooldown window and the next best is
 * used — i.e. the selection is dynamic, not hard-coded.
 * `refresh()` can pull the live catalogue from the Cloudflare docs API and
 * teach the selector about models that were released after this build.
 */
QV.ai = (() => {
  const catalogue = [
    /* --- frontier / reasoning ------------------------------------------- */
    { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', score: 96, ctx: 80000, kind: 'reasoning', notes: 'chain-of-thought reasoning, best for strategy planning' },
    { id: '@cf/qwen/qwq-32b', score: 95, ctx: 240000, kind: 'reasoning', notes: 'long-context reasoning' },
    { id: '@cf/meta/llama-4-scout-17b-16e-instruct', score: 94, ctx: 128000, kind: 'chat', notes: 'llama-4 MoE instruct' },
    { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', score: 92, ctx: 24000, kind: 'chat', notes: 'llama-3.3 70B fp8 fast' },
    { id: '@cf/qwen/qwen2.5-coder-32b-instruct', score: 91, ctx: 32768, kind: 'code', notes: 'code generation' },
    { id: '@cf/deepseek-ai/deepseek-r1-distill-llama-70b', score: 90, ctx: 80000, kind: 'reasoning' },
    { id: '@cf/google/gemma-3-12b-it', score: 88, ctx: 128000, kind: 'chat', notes: 'gemma-3, multimodal' },
    { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', score: 87, ctx: 128000, kind: 'chat' },
    { id: '@cf/meta/llama-3.1-70b-instruct', score: 86, ctx: 24000, kind: 'chat' },
    { id: '@cf/qwen/qwen1.5-14b-chat-awq', score: 78, ctx: 32768, kind: 'chat' },
    { id: '@cf/meta/llama-3.1-8b-instruct-fast', score: 74, ctx: 16000, kind: 'chat', notes: 'fast fallback' },
    { id: '@cf/meta/llama-3.1-8b-instruct', score: 72, ctx: 16000, kind: 'chat' },
    { id: '@cf/mistral/mistral-7b-instruct-v0.2', score: 66, ctx: 8192, kind: 'chat' },
    { id: '@cf/thebloke/discolm-german-7b-v1-awq', score: 40, ctx: 4096, kind: 'chat' },
    /* --- embeddings / rerank / vision ----------------------------------- */
    { id: '@cf/baai/bge-m3', score: 82, ctx: 8192, kind: 'embedding' },
    { id: '@cf/baai/bge-large-en-v1.5', score: 78, ctx: 512, kind: 'embedding' },
    { id: '@cf/baai/bge-reranker-base', score: 70, ctx: 512, kind: 'rerank' },
    { id: '@cf/llava-hf/llava-1.5-7b-hf', score: 60, ctx: 4096, kind: 'vision' },
    { id: '@cf/microsoft/resnet-50', score: 45, ctx: 0, kind: 'vision' },
    /* --- text / translation / safety ------------------------------------ */
    { id: '@cf/meta/m2m100-1.2b', score: 58, ctx: 1024, kind: 'translation' },
    { id: '@cf/meta/llama-guard-3-8b', score: 55, ctx: 8192, kind: 'safety' },
    { id: '@cf/facebook/bart-large-cnn', score: 52, ctx: 1024, kind: 'summarise' },
    { id: '@cf/huggingface/distilbert-sst-2-int8', score: 50, ctx: 512, kind: 'classifier' },
    { id: '@cf/openai/whisper-large-v3-turbo', score: 62, ctx: 0, kind: 'speech' },
  ];

  const demoted = new Map();     // model id -> until-timestamp
  const latency = new Map();     // model id -> EWMA ms
  const state = { discovered: 0, lastRefresh: 0, preferred: null };

  const scoreOf = (m) => {
    const d = demoted.get(m.id);
    if (d && d > Date.now()) return -1;
    const lat = latency.get(m.id);
    return m.score - (lat ? Math.min(10, lat / 400) : 0);
  };

  const byKind = (kind, limit = 6) =>
    catalogue.filter(m => m.kind === kind)
      .map(m => ({ ...m, effective: scoreOf(m) }))
      .filter(m => m.effective >= 0)
      .sort((a, b) => b.effective - a.effective)
      .slice(0, limit);

  /** ask Workers-AI for the best model; falls back through the ranked list */
  const run = async (env, prompt, opts = {}) => {
    const kind = opts.kind || 'chat';
    const maxTokens = opts.maxTokens || 512;
    const candidates = byKind(kind, opts.attempts || 5);
    if (!env || !env.AI) return { ok: false, error: 'AI binding missing', model: null, text: '' };
    for (const m of candidates) {
      const t0 = Date.now();
      try {
        const out = await env.AI.run(m.id, {
          messages: [
            { role: 'system', content: opts.system || 'You are the control plane of an autonomous anti-censorship network edge. Answer with compact JSON when asked.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: maxTokens,
          temperature: opts.temperature ?? 0.3,
          ...(opts.extra || {}),
        }, opts.gatewayOpts ? { gateway: opts.gatewayOpts } : undefined);
        const ms = Date.now() - t0;
        latency.set(m.id, (latency.get(m.id) || ms) * 0.7 + ms * 0.3);
        const text = out?.response ?? out?.result?.response ?? out?.choices?.[0]?.message?.content ?? (typeof out === 'string' ? out : JSON.stringify(out));
        state.preferred = m.id;
        return { ok: true, model: m.id, text: typeof text === 'string' ? text : JSON.stringify(text), ms, raw: out };
      } catch (e) {
        demoted.set(m.id, Date.now() + 15 * 60 * 1000);      // 15 min cooldown
        QV.log.warn('ai', `model ${m.id} failed → demoting 15min`, { err: e?.message });
      }
    }
    return { ok: false, error: 'all models failed', model: null, text: '' };
  };

  const embed = async (env, texts) => {
    const list = byKind('embedding', 3);
    for (const m of list) {
      try { return { ok: true, model: m.id, vectors: (await env.AI.run(m.id, { text: texts })).data }; }
      catch (e) { demoted.set(m.id, Date.now() + 10 * 60 * 1000); }
    }
    return { ok: false, vectors: null };
  };

  const json = async (env, prompt, opts = {}) => {
    const r = await run(env, prompt, { ...opts, system: (opts.system || '') + ' Reply with a single valid JSON object and nothing else.' });
    if (!r.ok) return { ok: false, data: null, model: null };
    const txt = r.text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = txt.indexOf('{'), end = txt.lastIndexOf('}');
    try { return { ok: true, model: r.model, data: JSON.parse(start >= 0 ? txt.slice(start, end + 1) : txt), ms: r.ms }; }
    catch (e) { return { ok: false, data: null, model: r.model, text: txt }; }
  };

  return {
    catalogue, byKind, run, json, embed, state, demoted, latency,
    best: (kind = 'chat') => byKind(kind, 1)[0] || null,
    /** learn the live catalogue from the public docs (best-effort) */
    refresh: async (env) => {
      try {
        const res = await QV.fetchWithRetry('https://developers.cloudflare.com/workers-ai/models/index.json', {}, { retries: 1, timeoutMs: 8000 });
        if (!res.ok) throw new Error('http ' + res.status);
        const list = await res.json();
        const known = new Set(catalogue.map(m => m.id));
        let added = 0;
        const arr = Array.isArray(list) ? list : (list.models || list.data || []);
        for (const item of arr) {
          const id = item.id || item.model || item.name;
          if (!id || known.has(id) || !/^@cf\//.test(id)) continue;
          const kind = /embed|bge|rerank/.test(id) ? 'embedding'
            : /whisper|speech/.test(id) ? 'speech'
              : /vision|llava|resnet|image/.test(id) ? 'vision'
                : /coder|code/.test(id) ? 'code'
                  : /r1|reason|qwq|think/.test(id) ? 'reasoning' : 'chat';
          catalogue.push({ id, score: 85, ctx: 0, kind, notes: 'discovered at runtime', discovered: true });
          known.add(id); added++;
        }
        state.discovered = added; state.lastRefresh = Date.now();
        return { ok: true, added, total: catalogue.length };
      } catch (e) { return { ok: false, error: e.message }; }
    },
  };
})();

/* ═══════════════════════════════════════════════════════════════════════════
 * A2 · D1 — schema, migrations, repositories.  EVERYTHING is per-user.
 * ═══════════════════════════════════════════════════════════════════════════ */
QV.d1 = (() => {
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS qv_users (
        uuid TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        tag TEXT,
        protocol TEXT DEFAULT 'vless',
        plan TEXT DEFAULT 'standard',
        enabled INTEGER DEFAULT 1,
        killswitch INTEGER DEFAULT 0,
        total_bytes INTEGER DEFAULT 0,
        used_bytes INTEGER DEFAULT 0,
        up_bytes INTEGER DEFAULT 0,
        down_bytes INTEGER DEFAULT 0,
        max_sessions INTEGER DEFAULT 3,
        ip_limit INTEGER DEFAULT 2,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        expires_at INTEGER,
        last_seen INTEGER,
        last_ip TEXT,
        note TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS qv_configs (
        id TEXT PRIMARY KEY,
        uuid TEXT NOT NULL,
        name TEXT,
        protocol TEXT,
        uri TEXT,
        sni TEXT,
        host TEXT,
        path TEXT,
        tls INTEGER DEFAULT 1,
        revoked INTEGER DEFAULT 0,
        revoke_reason TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        revoked_at INTEGER,
        FOREIGN KEY (uuid) REFERENCES qv_users(uuid) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS qv_sessions (
        id TEXT PRIMARY KEY,
        uuid TEXT,
        ip TEXT,
        country TEXT,
        asn TEXT,
        ua TEXT,
        fp TEXT,
        transport TEXT,
        started_at INTEGER DEFAULT (unixepoch()),
        last_alive INTEGER DEFAULT (unixepoch()),
        bytes_up INTEGER DEFAULT 0,
        bytes_down INTEGER DEFAULT 0,
        closed INTEGER DEFAULT 0,
        close_reason TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS qv_fsm (
        chat_id TEXT PRIMARY KEY,
        state TEXT DEFAULT 'IDLE',
        payload TEXT DEFAULT '{}',
        role TEXT DEFAULT 'guest',
        updated_at INTEGER DEFAULT (unixepoch())
    )`,
    `CREATE TABLE IF NOT EXISTS qv_sni_pool (
        sni TEXT PRIMARY KEY,
        provider TEXT,
        country TEXT,
        score REAL DEFAULT 0,
        latency_ms INTEGER,
        success INTEGER DEFAULT 0,
        fail INTEGER DEFAULT 0,
        last_test INTEGER,
        blocked INTEGER DEFAULT 0,
        tags TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS qv_ip_pool (
        ip TEXT PRIMARY KEY,
        label TEXT,
        score REAL DEFAULT 0,
        latency_ms INTEGER,
        success INTEGER DEFAULT 0,
        fail INTEGER DEFAULT 0,
        last_test INTEGER,
        blacklisted INTEGER DEFAULT 0,
        cooldown_until INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS qv_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER DEFAULT (unixepoch()),
        kind TEXT,
        severity TEXT DEFAULT 'info',
        uuid TEXT,
        ip TEXT,
        country TEXT,
        message TEXT,
        meta TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS qv_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER DEFAULT (unixepoch()),
        actor TEXT,
        action TEXT,
        target TEXT,
        detail TEXT,
        ip TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS qv_kv (
        key TEXT PRIMARY KEY,
        value TEXT,
        expires_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS qv_metrics (
        bucket INTEGER,
        metric TEXT,
        value REAL,
        labels TEXT,
        PRIMARY KEY (bucket, metric, labels)
    )`,
    `CREATE TABLE IF NOT EXISTS qv_ai_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER DEFAULT (unixepoch()),
        model TEXT,
        task TEXT,
        ms INTEGER,
        ok INTEGER,
        prompt TEXT,
        answer TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS ix_users_exp   ON qv_users(expires_at)`,
    `CREATE INDEX IF NOT EXISTS ix_users_en    ON qv_users(enabled)`,
    `CREATE INDEX IF NOT EXISTS ix_sessions_u  ON qv_sessions(uuid)`,
    `CREATE INDEX IF NOT EXISTS ix_sessions_al ON qv_sessions(last_alive)`,
    `CREATE INDEX IF NOT EXISTS ix_events_ts   ON qv_events(ts)`,
    `CREATE INDEX IF NOT EXISTS ix_configs_u   ON qv_configs(uuid)`,
    `CREATE INDEX IF NOT EXISTS ix_kv_exp      ON qv_kv(expires_at)`,
  ];

  let migrated = false;
  const migrate = async (env) => {
    if (migrated || !env?.DB) return { ok: !!env?.DB, reason: migrated ? 'cached' : 'no DB binding' };
    for (const sql of SCHEMA) {
      await QV.safeAsync(() => env.DB.prepare(sql).run());
    }
    migrated = true;
    QV.log.info('d1', 'schema ready', { tables: SCHEMA.length });
    return { ok: true };
  };

  const one = async (env, sql, ...params) => {
    if (!env?.DB) return null;
    QV.count('d1_read');
    return QV.safeAsync(() => env.DB.prepare(sql).bind(...QV.d1SanitizeAll(params)).first());
  };
  const all = async (env, sql, ...params) => {
    if (!env?.DB) return [];
    QV.count('d1_read');
    return (await QV.safeAsync(() => env.DB.prepare(sql).bind(...QV.d1SanitizeAll(params)).all()))?.results || [];
  };
  const run = async (env, sql, ...params) => {
    if (!env?.DB) return null;
    QV.count('d1_write');
    params = QV.d1SanitizeAll(params);
    if (QV.env && QV.env.get && QV.env.get(env, '__D1_TRACE__', false)) {
      const bad = params.findIndex(p => p && typeof p === 'object' && !(p instanceof Uint8Array) && !Array.isArray(p) && typeof p.byteLength !== 'number' && Object.prototype.toString.call(p) !== '[object Date]');
      if (bad >= 0) console.warn('[qv:d1-bind]', sql.slice(0, 90), 'param#' + bad, Object.prototype.toString.call(params[bad]));
    }
    return QV.safeAsync(() => env.DB.prepare(sql).bind(...params).run());
  };
  const batch = async (env, stmts) => {
    if (!env?.DB || !stmts.length) return null;
    return QV.safeAsync(() => env.DB.batch(stmts));
  };

  /* ---- repositories ---------------------------------------------------- */
  const Users = {
    get: (env, uuid) => one(env, 'SELECT * FROM qv_users WHERE uuid = ?', uuid),
    byEmail: (env, email) => one(env, 'SELECT * FROM qv_users WHERE email = ?', email),
    list: (env, limit = 200, offset = 0) => all(env, 'SELECT * FROM qv_users ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset),
    create: async (env, u) => {
      const uuid = u.uuid || QV.uuid();
      await run(env, `INSERT INTO qv_users (uuid,email,tag,protocol,plan,total_bytes,max_sessions,ip_limit,expires_at,note)
                      VALUES (?,?,?,?,?,?,?,?,?,?)`,
        uuid, u.email ?? null, u.tag ?? null, u.protocol || 'vless', u.plan || 'standard',
        u.total_bytes || 0, u.max_sessions || 3, u.ip_limit || 2, u.expires_at || null, u.note ?? null);
      /* every user gets its own default config — "config per user" */
      await Users.newConfig(env, uuid, { protocol: u.protocol || 'vless', name: 'primary', sni: u.sni });
      return Users.get(env, uuid);
    },
    update: async (env, uuid, patch) => {
      const cols = Object.keys(patch).filter(k => /^[a-z_]+$/.test(k));
      if (!cols.length) return null;
      const sets = cols.map(c => `${c} = ?`).join(', ');
      await run(env, `UPDATE qv_users SET ${sets}, updated_at = unixepoch() WHERE uuid = ?`, ...cols.map(c => patch[c]), uuid);
      QV.lru.delete('user:' + uuid);
      return Users.get(env, uuid);
    },
    remove: async (env, uuid) => {
      const s = [];
      s.push(env.DB.prepare('DELETE FROM qv_configs WHERE uuid = ?').bind(uuid));
      s.push(env.DB.prepare('DELETE FROM qv_sessions WHERE uuid = ?').bind(uuid));
      s.push(env.DB.prepare('DELETE FROM qv_users WHERE uuid = ?').bind(uuid));
      await batch(env, s);
      QV.lru.delete('user:' + uuid);
      return true;
    },
    newConfig: async (env, uuid, opt = {}) => {
      const id = QV.uuid();
      const sni = opt.sni || QV.pick([...QV.antidpi.sniPools.default]);
      const path = opt.path || '/' + QV.b64.url(QV.rand(9));
      await run(env, `INSERT INTO qv_configs (id,uuid,name,protocol,sni,host,path,tls) VALUES (?,?,?,?,?,?,?,?)`,
        id, uuid, opt.name || 'config', opt.protocol || 'vless', sni, opt.host || 'workers.dev', path, opt.tls === 0 ? 0 : 1);
      return { id, uuid, sni, path, protocol: opt.protocol || 'vless' };
    },
    configs: (env, uuid) => all(env, 'SELECT * FROM qv_configs WHERE uuid = ? ORDER BY created_at DESC', uuid),
    killswitch: async (env, uuid, on, reason = 'admin') => {
      await run(env, 'UPDATE qv_users SET killswitch = ?, updated_at = unixepoch() WHERE uuid = ?', on ? 1 : 0, uuid);
      if (on) {
        await run(env, 'UPDATE qv_configs SET revoked = 1, revoked_at = unixepoch(), revoke_reason = ? WHERE uuid = ?', reason, uuid);
        QV.emit(env, 'killswitch', 'warn', { uuid, message: 'kill-switch engaged: all configs revoked', meta: { reason } });
      } else {
        await run(env, 'UPDATE qv_configs SET revoked = 0, revoked_at = NULL, revoke_reason = NULL WHERE uuid = ?', uuid);
      }
      QV.lru.delete('user:' + uuid);
      return true;
    },
    /** per-user quota watchdog: disable on over-quota / expiry */
    sweep: async (env) => {
      const now = Math.floor(Date.now() / 1000);
      const expired = await all(env, 'SELECT uuid FROM qv_users WHERE enabled = 1 AND expires_at IS NOT NULL AND expires_at < ?', now);
      const over = await all(env, 'SELECT uuid FROM qv_users WHERE enabled = 1 AND total_bytes > 0 AND used_bytes >= total_bytes');
      for (const u of expired) { await run(env, 'UPDATE qv_users SET enabled = 0 WHERE uuid = ?', u.uuid); QV.emit(env, 'expired', 'info', { uuid: u.uuid, message: 'plan expired' }); }
      for (const u of over) { await run(env, 'UPDATE qv_users SET enabled = 0 WHERE uuid = ?', u.uuid); QV.emit(env, 'quota', 'info', { uuid: u.uuid, message: 'quota exhausted' }); }
      return { expired: expired.length, over: over.length };
    },
  };

  const Sessions = {
    open: async (env, s) => { const id = s.id || QV.uuid(); await run(env, `INSERT INTO qv_sessions (id,uuid,ip,country,asn,ua,fp,transport) VALUES (?,?,?,?,?,?,?,?)`, id, s.uuid, s.ip ?? null, s.country ?? null, s.asn ?? null, s.ua ?? null, s.fp ?? null, s.transport ?? null); return id; },
    alive: (env, id) => run(env, 'UPDATE qv_sessions SET last_alive = unixepoch() WHERE id = ?', id),
    close: (env, id, reason, up, down) => run(env, 'UPDATE qv_sessions SET closed = 1, close_reason = ?, bytes_up = ?, bytes_down = ? WHERE id = ?', reason || 'closed', up || 0, down || 0, id),
    active: (env, uuid) => all(env, 'SELECT * FROM qv_sessions WHERE uuid = ? AND closed = 0 ORDER BY last_alive DESC', uuid),
    activeCount: async (env, uuid, windowSec = 120) => (await one(env, 'SELECT COUNT(*) AS c FROM qv_sessions WHERE uuid = ? AND closed = 0 AND last_alive > unixepoch() - ?', uuid, windowSec))?.c || 0,
    distinctIps: async (env, uuid, windowSec = 300) => (await all(env, 'SELECT DISTINCT ip FROM qv_sessions WHERE uuid = ? AND last_alive > unixepoch() - ?', uuid, windowSec)).map(r => r.ip),
    reap: (env, olderThanSec = 600) => run(env, 'UPDATE qv_sessions SET closed = 1, close_reason = ? WHERE closed = 0 AND last_alive < unixepoch() - ?', 'reaped', olderThanSec),
  };

  const Fsm = {
    get: (env, chatId) => one(env, 'SELECT * FROM qv_fsm WHERE chat_id = ?', String(chatId)),
    setState: async (env, chatId, state, payload = {}, role = 'admin') => {
      await run(env, `INSERT INTO qv_fsm (chat_id,state,payload,role,updated_at) VALUES (?,?,?,?,unixepoch())
                      ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state, payload=excluded.payload, role=excluded.role, updated_at=unixepoch()`,
        String(chatId), state, JSON.stringify(payload), role);
    },
    clear: (env, chatId) => Fsm.setState(env, chatId, 'IDLE', {}),
  };

  const Sni = {
    upsert: (env, s) => run(env, `INSERT INTO qv_sni_pool (sni,provider,country,score,latency_ms,success,fail,last_test,tags)
                                 VALUES (?,?,?,?,?,?,?,unixepoch(),?)
                                 ON CONFLICT(sni) DO UPDATE SET score=excluded.score, latency_ms=excluded.latency_ms,
                                   success=success+excluded.success, fail=fail+excluded.fail, last_test=unixepoch()`,
      s.sni, s.provider ?? null, s.country ?? null, s.score ?? 0, s.latency_ms ?? null, s.success ?? 0, s.fail ?? 0, JSON.stringify(s.tags || [])),
    top: (env, n = 20) => all(env, 'SELECT * FROM qv_sni_pool WHERE blocked = 0 ORDER BY score DESC LIMIT ?', n),
    block: (env, sni) => run(env, 'UPDATE qv_sni_pool SET blocked = 1, score = -100 WHERE sni = ?', sni),
  };

  const Ip = {
    upsert: (env, i) => run(env, `INSERT INTO qv_ip_pool (ip,label,score,latency_ms,success,fail,last_test) VALUES (?,?,?,?,?,?,unixepoch())
                                  ON CONFLICT(ip) DO UPDATE SET score=excluded.score, latency_ms=excluded.latency_ms,
                                    success=success+excluded.success, fail=fail+excluded.fail, last_test=unixepoch()`,
      i.ip, i.label ?? null, i.score ?? 0, i.latency_ms ?? null, i.success ?? 0, i.fail ?? 0),
    top: (env, n = 50) => all(env, 'SELECT * FROM qv_ip_pool WHERE blacklisted = 0 AND (cooldown_until IS NULL OR cooldown_until < unixepoch()) ORDER BY score DESC LIMIT ?', n),
    cooldown: (env, ip, sec = 900) => run(env, 'UPDATE qv_ip_pool SET cooldown_until = unixepoch() + ?, score = score - 5 WHERE ip = ?', sec, ip),
  };

  const Kv = {
    get: async (env, key, dflt = null) => {
      const c = QV.lru.get('kv:' + key);
      if (c !== undefined) return c;
      const row = await one(env, 'SELECT value, expires_at FROM qv_kv WHERE key = ?', key);
      if (!row) { if (env?.KV) { const v = await QV.safeAsync(() => env.KV.get(key, 'json')); if (v != null) { QV.lru.set('kv:' + key, v); return v; } } return dflt; }
      /* `expires_at` is written in unix *seconds* (see `put` below, and the
         dns-cache pruner in 27-dns-extra).  Comparing it against Date.now()
         in milliseconds made every TTL'd row look expired the instant it was
         read back from D1 — only the in-isolate LRU hid it, so FSM state,
         dedupe markers and rate-limit counters silently reset across deploys
         and isolates. */
      if (row.expires_at && Number(row.expires_at) * 1000 < Date.now()) return dflt;
      const v = QV.safe(() => JSON.parse(row.value), row.value);
      QV.lru.set('kv:' + key, v);
      return v;
    },
    put: async (env, key, value, ttlSec = 0) => {
      const exp = ttlSec ? Math.floor(Date.now() / 1000) + ttlSec : null;
      QV.lru.set('kv:' + key, value, ttlSec ? ttlSec * 1000 : 60000);
      QV.count('kv_write');
      await run(env, 'INSERT INTO qv_kv (key,value,expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at', key, JSON.stringify(value), exp);
      if (env?.KV) await QV.safeAsync(() => ttlSec ? env.KV.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSec) }) : env.KV.put(key, JSON.stringify(value)));
      return value;
    },
    del: async (env, key) => { QV.count('kv_write'); QV.lru.delete('kv:' + key); await run(env, 'DELETE FROM qv_kv WHERE key = ?', key); if (env?.KV) await QV.safeAsync(() => env.KV.delete(key)); },
  };

  return { SCHEMA, migrate, one, all, run, batch, Users, Sessions, Fsm, Sni, Ip, Kv, get migrated() { return migrated; } };
})();

/** fire-and-forget event recorder (D1 + console) */
QV.emit = (env, kind, severity = 'info', o = {}) => {
  QV.log[severity === 'error' ? 'error' : severity === 'warn' ? 'warn' : 'info']('event:' + kind, o.message || kind);
  /* debug events stay in the log: writing one D1 row per request is what
     burns a free-plan row budget in an afternoon */
  if (severity === 'debug' && !(env && (env.QV_DEBUG || env.LOG_DEBUG === '1' || env.DEBUG === '1'))) return Promise.resolve(null);
  const ctx = o.ctx;
  const p = QV.d1.run(env, 'INSERT INTO qv_events (kind,severity,uuid,ip,country,message,meta) VALUES (?,?,?,?,?,?,?)',
    kind, severity, o.uuid ?? null, o.ip ?? null, o.country ?? null, o.message ?? null, JSON.stringify(o.meta || {}));
  if (ctx?.waitUntil) ctx.waitUntil(p);
  return p;
};
