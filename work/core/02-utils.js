/* ═══════════════════════════════════════════════════════════════════════════
 * A1b · UTILITY EXTENSIONS — everything the higher layers expect to exist
 * ═══════════════════════════════════════════════════════════════════════════ */
(function extendRuntime() {
  /* byte plumbing */
  if (!QV.concat) {
    QV.concat = (...arrs) => {
      const parts = arrs.flat().filter(x => x && x.length !== undefined && x.length >= 0 && !(x instanceof Array));
      const total = parts.reduce((s, x) => s + x.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        const v = p instanceof Uint8Array ? p : new Uint8Array(p);
        out.set(v, off); off += v.length;
      }
      return out;
    };
  }
  QV.u16le = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
  QV.u16be = (n) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
  QV.u32be = (n) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  if (!QV.rand16) QV.rand16 = () => (QV.rand(2)[0] << 8) | QV.rand(2)[1];
  QV.bytesEqual = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

  /* text + escaping (used by every HTML surface) */
  if (!QV.esc) QV.esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  QV.escOptional = (s) => (s === undefined || s === null ? '' : QV.esc(s));
  QV.mask = (s, keep = 4) => {
    const v = String(s ?? '');
    return v.length <= keep ? '•'.repeat(v.length) : v.slice(0, keep) + '•'.repeat(Math.min(12, v.length - keep));
  };
  /* shortId() keeps its historic no-argument form; shortId(n) gives n bytes */
  QV.shortId = (n) => QV.hex(QV.rand(n ? Math.max(1, Math.min(16, n | 0)) : 4));
  /** FNV-1a over a string: deterministic, dependency-free, used for rotation */
  QV.hash32 = (str) => {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  };
  QV.genUuid = () => (crypto.randomUUID ? crypto.randomUUID() : QV.hex(QV.rand(16)).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'));

  /* human formatting */
  QV.humanBytes = (n) => QV.formatBytes(n);
  QV.humanN = (n) => Number(n || 0).toLocaleString('en-US');
  QV.timeAgo = (ts) => {
    if (!ts) return '—';
    const d = Date.now() - Number(ts);
    if (d < 0) return 'in ' + QV.formatDuration(-d);
    if (d < 60000) return Math.floor(d / 1000) + 's ago';
    return QV.formatDuration(d) + ' ago';
  };
  QV.fromNow = (ts) => {
    if (!ts) return '∞';
    const d = Number(ts) - Date.now();
    return d < 0 ? 'expired ' + QV.formatDuration(-d) + ' ago' : 'in ' + QV.formatDuration(d);
  };

  /* JWT shortcut used by the router */
  QV.jwtVerify = async (token, secret) => {
    if (!secret || !token) return null;
    try { return await QV.jwt.verify(token, secret); } catch (e) { return null; }
  };

  /* labelled metric counters (in-isolate; rolled up into D1 by cron) */
  QV.metrics = (() => {
    const counters = new Map(), hist = new Map();
    return {
      count(name, value = 1, labels = {}) {
        const key = name + ':' + JSON.stringify(labels);
        counters.set(key, (counters.get(key) || 0) + value);
      },
      observe(name, ms) {
        const a = hist.get(name) || { n: 0, sum: 0, min: Infinity, max: 0 };
        a.n++; a.sum += ms; a.min = Math.min(a.min, ms); a.max = Math.max(a.max, ms);
        hist.set(name, a);
      },
      histogram(name) {
        const v = hist.get(name);
        if (!v) return { count: 0 };
        const avg = +(v.sum / Math.max(1, v.n)).toFixed(2);
        return { count: v.n, min: v.min === Infinity ? null : v.min, max: v.max, avg, p95: avg };
      },
      /** counters with the empty label set folded away — for /health */
      flat() {
        const out = {};
        for (const [k, v] of counters) {
          const name = k.endsWith(':\{\}') ? k.slice(0, -3) : k;
          out[name] = (out[name] || 0) + v;
        }
        return out;
      },
      snapshot() {
        const out = { counters: {}, histograms: {}, uptime_s: Math.round((Date.now() - (QV.bootedAt || QV.BOOTED_AT || Date.now())) / 1000) };
        for (const [k, v] of counters) out.counters[k] = v;
        for (const [k, v] of hist) out.histograms[k] = { ...v, avg: +(v.sum / Math.max(1, v.n)).toFixed(2), min: v.min === Infinity ? null : v.min };
        return out;
      },
      /** fold the isolate counters into D1 and start over (cron-driven) */
      async rollup(env) {
        const snap = await this.flush(env);
        return snap;
      },
      reset() { counters.clear(); hist.clear(); },
      /** durable rollup — merges in-isolate counters into D1 */
      async flush(env) {
        const snap = this.snapshot();
        if (!env?.__cfg?.__bindings?.d1) return snap;
        await QV.d1.Metrics.merge(env, snap).catch(() => {});
        this.reset();
        return snap;
      },
    };
  })();

  /* token bucket factory (the header has one shared instance; this makes more) */
  QV.tokenBucket = (key, ratePerMin = 60, burst = 30) => {
    const store = QV.tokenBucket.__store || (QV.tokenBucket.__store = new Map());
    const rate = ratePerMin / 60000;
    return {
      take(cost = 1) {
        const now = Date.now();
        let s = store.get(key);
        if (!s) { s = { tokens: burst, last: now }; store.set(key, s); }
        s.tokens = Math.min(burst, s.tokens + (now - s.last) * rate);
        s.last = now;
        if (store.size > 50000) store.clear();
        if (s.tokens >= cost) { s.tokens -= cost; return true; }
        return false;
      },
      remaining() { const s = store.get(key); return s ? Math.floor(s.tokens) : burst; },
    };
  };

  /* request fingerprinting — shared by anti-DPI + rate limits */
  QV.fingerprint = (request, ip) => {
    const h = request.headers;
    const ua = h.get('user-agent') || '';
    const alpn = h.get('cf-connecting-proto') || h.get('x-forwarded-proto') || 'https';
    const ja3 = [
      h.get('accept-language') || '', h.get('accept-encoding') || '', h.get('sec-ch-ua') || '',
      h.get('sec-ch-ua-platform') || '', h.get('priority') || '', ua,
    ].join('|');
    return { ua, alpn, ja3, ip: ip || '', key: QV.hex(QV.utf8(ja3)).slice(0, 16) };
  };

  /* safe JSON with size guard (D1 rows and KV values are small) */
  QV.json = {
    parse: (s, dflt = null) => { try { return JSON.parse(s); } catch (e) { return dflt; } },
    stringify: (o, dflt = '{}') => { try { return JSON.stringify(o); } catch (e) { return dflt; } },
    truncate: (s, n = 100000) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s),
  };
})();
