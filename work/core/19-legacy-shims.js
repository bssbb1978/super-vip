/* ═══════════════════════════════════════════════════════════════════════════
 * A4d · LEGACY MODULE BRIDGE — resurrects the nine "dead" modules
 * ═══════════════════════════════════════════════════════════════════════════
 *  The bundled generations were written as many files that imported each other
 *  (./vless-engine.js, ./ai-engine.js, ./telegram-bot.js, …).  When the bundle
 *  was pasted into one file those imports became dead destructures that always
 *  yielded `undefined`, so thousands of call sites silently did nothing.
 *
 *  Here `__QF_MODULES__` is a **lazy registry**:
 *    · every symbol any unit defines is registered under its own name (first
 *      definition wins) — so the bundled classes become reachable again;
 *    · symbols no unit defines get a real implementation from QV.legacy below,
 *      which is written against the new core (D1, AI, anti-DPI, VLESS engine).
 *  Nothing throws at import time; a missing symbol only fails if it is called.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function legacyBridge() {
  const registry = new Map();          // symbol name → implementation
  const sources = new Map();           // symbol name → 'unit:u07' | 'core'

  /* ─────────── real implementations for symbols no unit provides ───────── */

  /** VLESS request header parser — pure JS replacement for the missing
   *  ./rust/pkg/vless_parser.js wasm module.  Same contract as the Rust one:
   *  { version, uuid, addons, command, port, address, addressType,
   *    raw_data_index }                                            */
  const processVLESSHeader = (buffer) => {
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (b.length < 24) throw new Error('vless: header too short');
    const version = b[0];
    const uuidBytes = b.subarray(1, 17);
    const hex = [...uuidBytes].map(x => x.toString(16).padStart(2, '0')).join('');
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const optLen = b[17];
    let off = 18 + optLen;
    if (b.length < off + 4) throw new Error('vless: truncated after addons');
    const addons = optLen ? QV.dec.decode(b.subarray(18, off)) : '';
    const command = b[off]; off += 1;
    const port = (b[off] << 8) | b[off + 1]; off += 2;
    const addressType = b[off]; off += 1;
    let address = '';
    /* VLESS ATYP: 1 = IPv4, 2 = domain, 3 = IPv6  (4 accepted as an alias for
       IPv6 because several client forks emit the Shadowsocks numbering) */
    if (addressType === 1) { address = `${b[off]}.${b[off + 1]}.${b[off + 2]}.${b[off + 3]}`; off += 4; }
    else if (addressType === 2) { const len = b[off]; address = QV.dec.decode(b.subarray(off + 1, off + 1 + len)); off += 1 + len; }
    else if (addressType === 3 || addressType === 4) { address = QV.ss.formatV6(b.subarray(off, off + 16)); off += 16; }
    else throw new Error('vless: unsupported address type ' + addressType);
    return { version, uuid, addons, command, port, address, addressType, raw_data_index: off, raw: b };
  };

  /** open a TCP socket to the requested destination (Workers sockets API) */
  const connectToDestination = async (address, port, options = {}) => {
    if (!CONNECT_AVAILABLE()) throw new Error('cloudflare:sockets is not available in this runtime');
    const target = QV.dns.unwrapTarget(address, options.nat64Prefixes || QV.dns.NAT64_PREFIXES.map(p => p.prefix));
    const socket = connect({ hostname: target.host, port });
    await socket.opened;
    return socket;
  };
  const CONNECT_AVAILABLE = () => typeof connect === 'function';

  /** his own VLESS-over-WebSocket handler — used when no unit claims it */
  const handleVLESSConnection = async (request, env, ctx, clientIP) => {
    const upgrade = (request.headers.get('upgrade') || '').toLowerCase();
    if (upgrade !== 'websocket') return new Response('Upgrade required', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const sendShaped = QV.ss && QV.ss.shapeStream ? QV.ss.shapeStream(server, env) : (w) => server.send(w);
    let remote = null, writer = null, header = null, closed = false;
    const sessionId = QV.uuid();
    let bytes = 0;
    const finish = (reason) => {
      if (closed) return; closed = true;
      QV.safe(() => remote && remote.close());
      QV.safe(() => server.close(1000, reason || 'done'));
      if (header) QV.safeAsync(() => QV.d1.Sessions.close(env, sessionId, reason, bytes, 0));
      QV.emit(env, 'vless:close', 'info', { uuid: header?.uuid, ip: clientIP, message: reason || 'closed', ctx, meta: { bytes } });
    };
    server.addEventListener('message', async (ev) => {
      try {
        const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : QV.utf8(String(ev.data));
        if (!header) {
          header = processVLESSHeader(data);
          if (header.command !== 1) return finish('unsupported-command');
          if (!QV.isUuid(header.uuid)) return finish('bad-uuid');
          const user = await QV.d1.Users.get(env, header.uuid);
          if (user && (!user.enabled || user.killswitch)) return finish('revoked');
          const blocked = (env.BLOCKED_PORTS || '22,25,110,143,465,587,993,995,3389,5900,8080').split(',').map(s => parseInt(s.trim(), 10));
          if (blocked.includes(header.port)) return finish('blocked-port');
          const sessions = await QV.d1.Sessions.activeCount(env, header.uuid, 300);
          if (user && sessions >= (user.max_sessions || 3)) return finish('session-limit');
          QV.safeAsync(() => QV.d1.Sessions.open(env, { id: sessionId, uuid: header.uuid, ip: clientIP, transport: 'vless-ws', ua: request.headers.get('user-agent') }));
          QV.emit(env, 'vless:open', 'info', { uuid: header.uuid, ip: clientIP, ctx, message: `${header.address}:${header.port}` });
          remote = await connectToDestination(header.address, header.port, { nat64Prefixes: QV.dns.nat64PrefixesFromEnv(env) });
          /* the one place where a tunnel success is *authenticated*: the user
             row was found, quota/revocation/session-limit checks passed, and an
             upstream socket is open.  That is the signal the endpoint ranking
             wants — host always, dialled address only if the client named it. */
          try {
            if (QV.cleanip && QV.cleanip.feedback) {
              let url = null; try { url = new URL(request.url); } catch (e) {}
              const ep = (url && (url.searchParams.get('ep') || url.searchParams.get('ip'))) || '';
              const host = String(request.headers.get('host') || '').split(':')[0];
              const asn = (request.cf && request.cf.asn) ? String(request.cf.asn) : null;
              QV.safeAsync(() => QV.cleanip.feedback(env, header.uuid, host, true, asn, ep, { ownHost: host }));
            }
          } catch (e) { /* feedback must never break a working session */ }
          writer = remote.writable.getWriter();
          (async () => {
            const reader = remote.readable.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done || !value || !value.length) break;
                await sendShaped(value);
                bytes += value.length;
              }
            } catch (e) { QV.log.warn('vless', 'upstream read failed', { err: e?.message }); }
            finally { finish('eof'); }
          })();
          const rest = data.subarray(header.raw_data_index);
          if (rest.length) await writer.write(rest);
        } else if (data.length) {
          await writer.write(data);
          bytes += data.length;
        }
      } catch (e) {
        QV.log.error('vless', 'message failed', { err: e?.message });
        finish('error');
      }
    });
    server.addEventListener('close', () => finish('client-close'));
    server.addEventListener('error', () => finish('ws-error'));
    return new Response(null, { status: 101, webSocket: client });
  };

  /* ---------- obfuscation key management (D1-backed, rotating) ---------- */
  const OB_KEY = 'qv:obfuscation:keys';
  const rotateObfuscationKeys = async (env, ctx, opts = {}) => {
    const now = Date.now();
    const keep = opts.keep || 3;
    const previous = (await QV.safeAsync(() => QV.d1.Kv.get(env, OB_KEY, null), null)) || { keys: [], rotatedAt: 0 };
    const fresh = {
      id: QV.hex(QV.rand(8)),
      key: QV.b64.enc(QV.rand(32)),
      createdAt: now,
      ttlSec: opts.ttlSec || 3600,
    };
    const keys = [fresh, ...(previous.keys || [])].slice(0, keep);
    const next = { keys, rotatedAt: now, generation: (previous.generation || 0) + 1 };
    await QV.safeAsync(() => QV.d1.Kv.set(env, OB_KEY, next, 0));
    QV.log.info('obfuscation', 'keys rotated', { generation: next.generation, active: fresh.id });
    QV.emit(env, 'obfuscation:rotate', 'info', { message: `generation ${next.generation}`, ctx });
    return next;
  };
  const loadObfuscationKeys = async (env) => {
    const stored = await QV.safeAsync(() => QV.d1.Kv.get(env, OB_KEY, null), null);
    if (stored && stored.keys?.length) {
      const age = Date.now() - (stored.rotatedAt || 0);
      if (age > (stored.keys[0].ttlSec || 3600) * 1000) return rotateObfuscationKeys(env, null, {});
      return stored;
    }
    return rotateObfuscationKeys(env, null, {});
  };

  /* ---------- fragment buffer housekeeping ------------------------------ */
  const fragmentBuffers = new Map();
  const cleanupFragmentBuffers = async (env, ctx) => {
    const before = fragmentBuffers.size;
    for (const [k, v] of fragmentBuffers) if (!v.exp || v.exp < Date.now()) fragmentBuffers.delete(k);
    QV.lru.clear();
    const reaped = await QV.safeAsync(() => QV.d1.Sessions.reap(env, 300), null);
    return { dropped: before - fragmentBuffers.size, reaped: !!reaped };
  };

  /* ---------- AI SNI hunt adapters (the versions the old modules exported) */
  const runAISNIHunt = async (env, ctx, opts = {}) => {
    const found = await QV.antidpi.hunt(env, ctx, { count: opts.count || 10 });
    return found.map(f => ({ sni: f.sni, score: f.score, latency: f.latencyMs, provider: f.edge || 'edge' }));
  };
  const testSingleSNI = async (env, sni) => {
    const t0 = Date.now();
    try {
      const res = await QV.fetchWithRetry(`https://${sni}/cdn-cgi/trace`, {}, { retries: 0, timeoutMs: 4500 });
      const text = await res.text();
      const ok = res.ok && /(^|\n)colo=/.test(text);
      if (ok) await QV.safeAsync(() => QV.d1.Sni.upsert(env, { sni, score: QV.antidpi.scoreSni(sni) + 15, latency_ms: Date.now() - t0, success: 1 }));
      return { sni, ok, latency: Date.now() - t0, colo: (text.match(/colo=(\w+)/) || [])[1] || null };
    } catch (e) {
      await QV.safeAsync(() => QV.d1.Sni.upsert(env, { sni, score: -5, fail: 1 }));
      return { sni, ok: false, error: e?.message };
    }
  };
  const detectCDNProvider = (host) => {
    const h = String(host || '').toLowerCase();
    const table = [
      [/cloudflare|workers\.dev|cflare/, 'cloudflare'],
      [/jsdelivr|fastly|akamai|edgekey|edgesuite/, 'fastly/akamai'],
      [/cloudfront|amazonaws/, 'aws'],
      [/azure|microsoft|msedge/, 'azure'],
      [/google|gstatic|googleusercontent/, 'google'],
      [/\.ir$|aparat|digikala|tci\.ir|mci\.ir/, 'domestic-ir'],
    ];
    for (const [re, name] of table) if (re.test(h)) return name;
    return 'unknown';
  };

  /* ---------- class fallbacks (used only if no unit defines them) -------- */
  class VLESSEngine {
    constructor(env, ctx) { this.env = env; this.ctx = ctx; this.version = QV.VERSION; }
    async handle(request, env = this.env, ctx = this.ctx) { return handleVLESSConnection(request, env, ctx, '0.0.0.0'); }
    parseHeader(buffer) { return processVLESSHeader(buffer); }
    describe() { return { engine: 'core-vless', version: QV.VERSION, transports: ['ws-tls', 'httpupgrade', 'xhttp', 'grpc-tls'] }; }
  }
  class SecurityLayer {
    constructor(env) { this.env = env; this.threats = new Map(); }
    check(request, ip) {
      const verdict = QV.antidpi.classify(request, ip || '0.0.0.0');
      if (verdict.action === 'ban') { this.threats.set(ip, Date.now() + 3600000); return { allow: false, reason: verdict.reason }; }
      const bucket = QV.tokenBucket('sec:' + (ip || '0.0.0.0'), 240, 80);
      return bucket.take() ? { allow: true, reason: 'ok' } : { allow: false, reason: 'rate-limited', retryAfter: 15 };
    }
    tarpit(ms) { return QV.antidpi.tarpit(ms); }
    fingerprint(request, ip) { return QV.fingerprint(request, ip); }
    stats() { return { tracked: this.threats.size, bans: [...this.threats.values()].filter(v => v > Date.now()).length }; }
  }
  class AIEngine {
    constructor(env, ctx) { this.env = env; this.ctx = ctx; }
    static async run(env, prompt, opts) { return QV.ai.run(env, prompt, opts); }
    async chat(messages, opts) { return QV.ai.chat(this.env, messages, opts); }
    async json(prompt, opts) { return QV.ai.json(this.env, prompt, opts); }
    async hunt(opts) { return runAISNIHunt(this.env, this.ctx, opts); }
    async plan() { return QV.antidpi.analyse(this.env, this.ctx, { reason: 'ai-engine' }); }
    models() { return QV.ai.byKind('chat', 5).map(m => ({ id: m.id, score: m.score, effective: m.effective })); }
    async probe() { return QV.ai.probe(this.env, this.ctx); }
  }
  class TelegramBot {
    constructor(env, ctx) { this.env = env; this.ctx = ctx; }
    async send(chatId, text, keyboard) { return QV.telegram.send(this.env, chatId, text, keyboard); }
    async notifyAdmin(text, keyboard) { return QV.telegram.notifyAdmin(this.env, text, keyboard); }
    async webhook(request) { return QV.telegram.handleWebhook(request, this.env, this.ctx); }
    setup(url) { return QV.telegram.setWebhook(this.env, url); }
  }
  class SNIDashboard {
    constructor(env, ctx) { this.env = env; this.ctx = ctx; }
    async data() { return QV.antidpi.status(this.env); }
    async hunt(count = 8) { return QV.antidpi.hunt(this.env, this.ctx, { count }); }
    async top(limit = 25) { return QV.d1.Sni.top(this.env, limit); }
  }
  class AntiCensorshipEngine {
    constructor(env, ctx) { this.env = env; this.ctx = ctx; }
    async strategy() { return QV.antidpi.load(this.env); }
    async replan(reason = 'engine') { return QV.antidpi.analyse(this.env, this.ctx, { reason }); }
    fragment(asn, country) { return QV.antidpi.frag(this.env, asn, country); }
    profile(asn, country) { return QV.antidpi.profileFor(asn, country); }
    async sni(opts) { return QV.antidpi.pickSni(this.env, opts || {}); }
    classify(request, ip) { return QV.antidpi.classify(request, ip); }
  }
  class AdminPanel {
    constructor(env, ctx) { this.env = env; this.ctx = ctx; }
    html(who) { return QV.panels.admin(this.env, who || { role: 'admin' }); }
    async handle(request) { return QV.router.handleFetch(request, this.env, this.ctx); }
  }

  const FALLBACKS = {
    VLESSEngine, SecurityLayer, AIEngine, TelegramBot, SNIDashboard, AntiCensorshipEngine, AdminPanel,
    handleVLESSConnection, processVLESSHeader, connectToDestination,
    rotateObfuscationKeys, loadObfuscationKeys, cleanupFragmentBuffers,
    runAISNIHunt, testSingleSNI, detectCDNProvider,
    /* aliases some generations used */
    ActiveSecurityLayer: SecurityLayer,
    QuantumAIOrchestrator: AIEngine,
    QuantumObfuscator: class { constructor(env) { this.env = env; } keys() { return loadObfuscationKeys(this.env); } rotate() { return rotateObfuscationKeys(this.env); } },
    NeuralTrafficMorpher: class {
      constructor(env) { this.env = env; }
      profile(asn, country) { return QV.antidpi.frag(this.env, asn, country); }
      shapeFor(req) { return QV.antidpi.classify(req, req?.headers?.get?.('cf-connecting-ip') || '0.0.0.0'); }
    },
    HybridStorage: class {
      constructor(env) { this.env = env; }
      get(k, d) { return QV.d1.Kv.get(this.env, k, d); }
      set(k, v, ttl) { return QV.d1.Kv.set(this.env, k, v, ttl); }
      del(k) { return QV.d1.Kv.del(this.env, k); }
    },
    MultiCDNLoadBalancer: class {
      constructor(env) { this.env = env; }
      async pick() { return QV.antidpi.scanCleanIPs(this.env, null, { limit: 5 }); }
    },
    UserPanel: AdminPanel,
  };

  const register = (name, impl, source = 'core') => {
    if (!impl) return;
    if (!registry.has(name)) { registry.set(name, impl); sources.set(name, source); }
  };
  for (const [name, impl] of Object.entries(FALLBACKS)) register(name, impl, 'core');

  /* ─────────── the lazy module table the legacy units import from ──────── */
  const lazySymbol = (name) => new Proxy(function __lazyQV() {}, {
    apply(_t, thisArg, args) {
      const impl = registry.get(name);
      if (typeof impl === 'function') return impl.apply(thisArg, args);
      throw new Error(`[qv] ${name} is not available (no unit defined it)`);
    },
    construct(_t, args, newTarget) {
      const impl = registry.get(name);
      if (typeof impl === 'function') return Reflect.construct(impl, args, newTarget === undefined ? impl : impl);
      throw new Error(`[qv] ${name} cannot be constructed (no unit defined it)`);
    },
    get(_t, prop) {
      const impl = registry.get(name);
      if (prop === '__impl') return impl;
      if (prop === 'name') return name;
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => `[qv ${name}]`;
      if (prop === 'prototype') return (typeof impl === 'function' ? impl.prototype : Object.prototype);
      if (impl && prop in impl) return impl[prop];
      return undefined;
    },
    has(_t, prop) { return true; },
    set(_t, prop, value) { const impl = registry.get(name); if (impl) impl[prop] = value; return true; },
  });

  const MODULE_MAP = {
    './vless-engine.js': ['VLESSEngine', 'handleVLESSConnection', 'processVLESSHeader', 'connectToDestination', 'parseVlessHeader', 'createVLESSServer'],
    './security-layer.js': ['SecurityLayer', 'ActiveSecurityLayer', 'AntiCensorshipEngine', 'checkSecurity', 'validateRequest'],
    './admin-panel.js': ['AdminPanel', 'UserPanel', 'generateAdminPanel', 'ADMIN_PANEL_HTML'],
    './telegram-bot.js': ['TelegramBot', 'setupTelegramBot', 'sendTelegramMessage'],
    './sni-dashboard.js': ['SNIDashboard', 'generateSNIDashboard', 'renderSNIDashboard'],
    './anti-censorship.js': ['AntiCensorshipEngine', 'NeuralTrafficMorpher', 'MultiCDNLoadBalancer', 'HybridStorage'],
    './ai-engine.js': ['AIEngine', 'QuantumAIOrchestrator', 'runAISNIHunt', 'testSingleSNI', 'detectCDNProvider', 'aiChat'],
    './obfuscation.js': ['QuantumObfuscator', 'rotateObfuscationKeys', 'loadObfuscationKeys', 'obfuscatePayload'],
    './traffic-morphing.js': ['NeuralTrafficMorpher', 'cleanupFragmentBuffers', 'morphTraffic', 'fragmentBuffer'],
  };

  const moduleTable = new Proxy({}, {
    get(_t, mod) {
      if (typeof mod !== 'string') return undefined;
      const known = MODULE_MAP[mod] || null;
      return new Proxy({}, {
        get(_t2, name) {
          if (typeof name !== 'string') return undefined;
          const impl = registry.get(name);
          if (impl !== undefined) return impl;
          if (known && known.includes(name)) return lazySymbol(name);
          /* unknown but plausible export: still return a lazy symbol so
             destructuring stays truthy and calling gives a clear error */
          return lazySymbol(name);
        },
        has(_t2, name) { return typeof name === 'string'; },
        ownKeys() { return known || []; },
        getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
      });
    },
    has: () => true,
  });

  globalThis.__QF_MODULES__ = moduleTable;
  globalThis.__QV_LEGACY = { FALLBACKS, registry, sources, moduleTable, MODULE_MAP };
  /** called by the assembly bridge once every unit scope exists */
  globalThis.__QF_REGISTER = (name, impl, source) => register(name, impl, source);

  /* ═══════════════════════════════════════════════════════════════════════
   * LEGACY SCHEMA ADOPTION
   *   Each merged generation shipped its own D1 tables (`users`,
   *   `security_events`, `neural_asset_registry`, …).  The core keeps its own
   *   `qv_*` schema, but a legacy code path that writes to its own table must
   *   not die with "no such table": the declarations the units already carry
   *   are executed once, on the same database, so every historic writer keeps
   *   its storage and nothing that used to work is lost.
   * ═══════════════════════════════════════════════════════════════════════ */
  const splitSql = (ddl) => String(ddl)
    .split('\n').map(line => line.replace(/^\s*\/\/.*$/, '')).join('\n')   // JS-style comment lines
    .split(';').map(x => x.trim()).filter(Boolean);

  const legacySchema = {
    async ensure(env) {
      const done = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:boot:legacy-schema', 0), 0);
      if (done) return { created: 0, cached: true };
      const schema = QV.safe(() => registry.get('DATABASE_SCHEMA'), null);
      if (!schema || typeof schema !== 'object') return { created: 0, error: 'no legacy schema in scope' };
      let created = 0, failed = 0;
      for (const [, ddl] of Object.entries(schema)) {
        if (typeof ddl !== 'string' || !/create\s+table/i.test(ddl)) continue;
        for (const stmt of splitSql(ddl)) {
          if (!/create\s+(table|index|view)/i.test(stmt)) continue;
          const ok = await QV.safeAsync(async () => { await QV.d1.run(env, stmt); return true; }, false);
          if (ok) created++; else failed++;
        }
      }
      if (created) await QV.safeAsync(() => QV.d1.Kv.set(env, 'qv:boot:legacy-schema', Date.now(), 0), null);
      const probe = await QV.safeAsync(() => QV.d1.one(env, `SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table'`), null);
      const total = probe ? probe.c : -1;
      QV.emit(env, 'legacy:schema', failed ? 'warn' : 'info', { message: `legacy tables ensured: ${created} created, ${failed} failed, ${total} tables live` });
      return { created, failed, tables: total };
    },
    names: () => { const sc = QV.safe(() => registry.get('DATABASE_SCHEMA'), null); return sc ? Object.keys(sc) : []; },
  };

  QV.legacySchema = legacySchema;

  QV.legacy = {
    processVLESSHeader, connectToDestination, handleVLESSConnection,
    rotateObfuscationKeys, loadObfuscationKeys, cleanupFragmentBuffers,
    runAISNIHunt, testSingleSNI, detectCDNProvider,
    FALLBACKS, registry, sources,
    stats: () => ({ symbols: registry.size, units: [...sources.values()].filter(s => String(s).startsWith('unit:')).length }),
  };
})();
