/* ═══════════════════════════════════════════════════════════════════════════
 * A2 · ENVIRONMENT — bindings, detection, secrets, configuration
 * ═══════════════════════════════════════════════════════════════════════════
 *  The deployment must work on Workers *and* on Pages, with whatever bindings
 *  the operator actually created, in any of the naming styles the generations
 *  used over time (DB / D1 / DATABASE, KV / KV_NAMESPACE / QVU_KV …).
 *  Everything is normalised here once, then the rest of the engine only sees
 *  `cfg.d1`, `cfg.kv`, `cfg.ai`, …   Secrets that were never configured are
 *  generated and persisted in D1 so behaviour is stable across isolates and
 *  redeploys instead of randomly changing.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function envModule() {
  /* every knob, its default and a one-line description (used by /health) */
  const DEFAULTS = {
    /* identity */
    LANDING_TITLE: 'Service', LANDING_SUB: 'This endpoint is a private service node.',
    LANDING_NOTE: 'Access is issued per account.',
    DEFAULT_LANG: 'fa', CUSTOM_DOMAIN: '', HOSTS: '', WS_PATH: '/ws', ALT_PORTS: '443,8443,2053,2087,2096,8443',
    DEFAULT_SNI: 'www.cloudflare.com', REQUIRE_SNI: '0',
    /* limits & policy */
    DEFAULT_QUOTA_GB: '100', MAX_SESSIONS: '3', MAX_USERS: '250',
    BLOCK_ADS: '1', BLOCK_MALWARE: '1', DNS64_ENABLED: '1',
    NAT64_PREFIX: '64:ff9b::/96', EOF_DELAY_MS: '0',
    /* anti-DPI */
    ANTIDPI_MODE: 'auto', FRAGMENT_MODE: 'auto', STRICT_EVASION: '0',
    PROBE_TARPIT_MS: '1800', BAN_MINUTES: '60', ALLOW_COUNTRIES: '', DENY_COUNTRIES: 'KP',
    /* telegram */
    TELEGRAM_BOT_TOKEN: '', ADMIN_TELEGRAM_ID: '', DISABLE_WEBHOOK: '0',
    /* owner binding — the bot is claimed from an authenticated session, so no
       ADMIN_TELEGRAM_ID has to be configured by hand (31-owner.js) */
    OWNER_CLAIM_TTL_MIN: '30', OWNER_MAX_ADMINS: '8', OWNER_NOTIFY_QUEUE: '50',
    OWNER_NOTIFY_TRIES: '5', OWNER_PEPPER: '', OWNER_LOCK: '0',
    /* upstreams */
    DoH_UPSTREAMS: 'https://cloudflare-dns.com/dns-query,https://dns.google/dns-query,https://dns.quad9.net/dns-query,https://doh.opendns.com/dns-query,https://dns.adguard-dns.com/dns-query',
    FALLBACK_UPSTREAM: 'dns.google',
    /* backups / ops */
    BACKUP_KEEP: '7', LOG_LEVEL: 'info', TIMEZONE: 'Asia/Tehran',
  };

  const get = (env, key, dflt) => {
    if (!env) return dflt !== undefined ? dflt : DEFAULTS[key];
    const v = env[key];
    if (v === undefined || v === null || v === '') return dflt !== undefined ? dflt : DEFAULTS[key];
    return v;
  };
  const bool = (env, key, dflt) => {
    const v = String(get(env, key, dflt === undefined ? '' : (dflt ? '1' : '0'))).toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  };
  const list = (env, key, dflt = []) => {
    const raw = get(env, key, null);
    if (raw === null || raw === undefined) return dflt;
    if (Array.isArray(raw)) return raw;
    return String(raw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  };

  /* ─────────────── binding detection (shape-based, name agnostic) ─────── */
  const isD1 = (v) => !!v && typeof v.prepare === 'function' && typeof v.batch === 'function';
  const isKV = (v) => !!v && typeof v.get === 'function' && typeof v.put === 'function' &&
    (typeof v.getWithMetadata === 'function' || typeof v.createMultipartUpload !== 'function');
  const isR2 = (v) => !!v && typeof v.get === 'function' && typeof v.put === 'function' && typeof v.list === 'function' &&
    (typeof v.createMultipartUpload === 'function' || typeof v.getWithMetadata !== 'function');
  const isQueue = (v) => !!v && typeof v.send === 'function';
  const isDO = (v) => !!v && typeof v.idFromName === 'function' && typeof v.get === 'function';
  const isAI = (v) => !!v && typeof v.run === 'function' && typeof v.fetch !== 'function';
  const isVectorize = (v) => !!v && typeof v.query === 'function' && typeof v.upsert === 'function';

  const detect = (env) => {
    const out = { d1: null, kv: null, r2: null, ai: null, queues: [], dos: {}, vectors: [], bindings: {}, names: { d1: [], kv: [], queue: [], do: [], r2: [] } };
    if (!env || typeof env !== 'object') return out;
    for (const [k, v] of Object.entries(env)) {
      if (v === null || v === undefined) continue;
      out.bindings[k] = v;
      if (isD1(v)) { out.names.d1.push(k); if (!out.d1 || /^(DB|D1|DATABASE|QVU_DB|qv)/i.test(k)) out.d1 = v; }
      else if (isDO(v)) { out.names.do.push(k); out.dos[k] = v; }
      else if (isAI(v) || (k === 'AI')) { if (!out.ai) out.ai = v; }
      else if (isVectorize(v)) out.vectors.push(k);
      else if (isKV(v) && typeof v.getWithMetadata === 'function') { out.names.kv.push(k); if (!out.kv || /^(KV|KVU|QVU_KV|CACHE|STORAGE|QD)/i.test(k)) out.kv = v; }
      else if (isR2(v)) { out.names.r2.push(k); if (!out.r2) out.r2 = v; }
      else if (isKV(v)) { out.names.kv.push(k); if (!out.kv || /^(KV|KVU|QVU_KV|CACHE|STORAGE|QD)/i.test(k)) out.kv = v; }
      else if (isQueue(v)) { out.names.queue.push(k); out.queues.push({ name: k, queue: v }); }
    }
    return out;
  };

  /* ─────────────── secrets: configured, or generated once ─────────────── */
  const secrets = async (env, ctx) => {
    const det = detect(env);
    const stored = (det.d1 && await QV.safeAsync(() => QV.d1.Kv.get(alias(env), 'qv:keys', null), null)) || {};
    const out = {
      jwt: get(env, 'JWT_SECRET', '') || stored.jwt,
      api: get(env, 'API_SECRET_TOKEN', '') || stored.api,
      bridge: get(env, 'BRIDGE_SECRET', '') || stored.bridge,
      adminPassword: get(env, 'ADMIN_PASSWORD', '') || get(env, 'PASSWORD', '') || stored.adminPassword,
      generated: [],
    };
    let changed = false;
    if (!out.jwt) { out.jwt = QV.b64.enc(QV.rand(32)); out.generated.push('JWT_SECRET'); changed = true; }
    if (!out.api) { out.api = QV.b64.enc(QV.rand(24)).replace(/[^A-Za-z0-9]/g, '').slice(0, 32); out.generated.push('API_SECRET_TOKEN'); changed = true; }
    if (!out.bridge) { out.bridge = QV.b64.enc(QV.rand(32)); out.generated.push('BRIDGE_SECRET'); changed = true; }
    if (!out.adminPassword) {
      /* never leave the node without a login: mint one, persist it, shout about it */
      out.adminPassword = QV.shortId(14) + '-' + QV.shortId(6);
      out.generated.push('ADMIN_PASSWORD');
      changed = true;
    }
    if (changed && det.d1) {
      await QV.safeAsync(() => QV.d1.Kv.set(alias(env), 'qv:keys', {
        jwt: out.jwt, api: out.api, bridge: out.bridge, adminPassword: out.adminPassword, at: Date.now(),
      }, 0), null);
      if (out.generated.includes('ADMIN_PASSWORD')) {
        QV.log.warn('env', 'ADMIN_PASSWORD was not configured — generated and stored in D1 (qv_kv → qv:keys)');
        QV.log.warn('env', 'set the ADMIN_PASSWORD secret in the dashboard to replace it');
      }
    }
    return out;
  };

  /** called by the router's watchdog: makes sure the secrets exist */
  const ensureSecrets = async (env, ctx) => secrets(env, ctx);

  /* ─────────────── alias proxy: historic binding names keep working ──────
   *  The bundled generations read `env.DB`, `env.KV`, `env.AI`, `env.BUCKET`
   *  and `env.Q`.  Whatever the operator actually named the bindings, this
   *  proxy makes those historic names resolve, without ever mutating the real
   *  environment object the runtime handed us. */
  const ALIASES = new Map();
  /* ─────────────── D1 parameter sanitiser ───────────────────────────────
   * A D1 statement only accepts null / number / bigint / string / bytes.  The
   * merged generations sometimes bind a whole Request or a nested object — the
   * statement then fails wholesale and the caller (a logger, an audit trail)
   * never notices.  Every D1 handle the alias hands out coerces those values
   * first, so a sloppy legacy call stores a readable JSON string instead of
   * losing the row.
   * ────────────────────────────────────────────────────────────────────── */
  const d1Value = (v) => QV.d1Sanitize(v);

  const safeStatement = (stmt, cache) => {
    if (!stmt || typeof stmt.bind !== 'function') return stmt;
    if (cache.has(stmt)) return cache.get(stmt);
    const wrapped = new Proxy(stmt, {
      get(target, key) {
        if (key === 'bind') return (...params) => safeStatement(target.bind(...params.map(d1Value)), cache);
        const fn = target[key];
        return typeof fn === 'function' ? fn.bind(target) : fn;
      },
    });
    cache.set(stmt, wrapped);
    return wrapped;
  };
  const safeD1 = (weak) => {
    if (!weak || typeof weak.prepare !== 'function') return weak;
    if (weak.__qvSafe) return weak;
    const cache = new WeakMap();
    const proxy = new Proxy(weak, {
      get(target, key) {
        if (key === '__qvSafe') return true;
        if (key === 'prepare') return (sql) => safeStatement(target.prepare(sql), cache);
        if (key === 'batch') return (list) => target.batch(((list || []).map(x => (x && x.__qvSafeOrig) || x)));
        const fn = target[key];
        return typeof fn === 'function' ? fn.bind(target) : fn;
      },
    });
    return proxy;
  };

  const aliasKey = (env) => {
    const d = detect(env);
    return [d.names.d1.join('|'), d.names.kv.join('|'), d.names.r2.join('|'), d.names.queue.join('|'), d.names.do.join('|')].join('::');
  };
  const alias = (env) => {
    if (!env || typeof env !== 'object') return env;
    let entry = ALIASES.get(env);
    if (entry && entry.key === aliasKey(env)) return entry.proxy;
    const det = detect(env);
    const d1 = safeD1(det.d1);
    try { if (det.bindings && 'd1' in det.bindings) det.bindings.d1 = d1; } catch (e) { /* frozen bindings are fine */ }
    const extra = {
      __cfg: det, __bindings: det.bindings,
      D1: d1, DATABASE: d1, QVU_DB: d1,
      KV: det.kv, KV_NAMESPACE: det.kv, QVU_KV: det.kv, CACHE: det.kv,
      BUCKET: det.r2, R2: det.r2,
      Q: det.queues[0]?.queue || null, QUEUE: det.queues[0]?.queue || null,
      AI: det.ai,
      ADMIN: get(env, 'ADMIN_PASSWORD', ''), PASSWORD: get(env, 'ADMIN_PASSWORD', ''),
      TOKEN: get(env, 'TELEGRAM_BOT_TOKEN', ''), BOT_TOKEN: get(env, 'TELEGRAM_BOT_TOKEN', ''),
      CHAT_ID: get(env, 'ADMIN_TELEGRAM_ID', ''), ADMIN_ID: get(env, 'ADMIN_TELEGRAM_ID', ''),
      UUID: get(env, 'CUSTOM_DOMAIN', ''), DOMAIN: get(env, 'CUSTOM_DOMAIN', ''),
      SECRET: get(env, 'JWT_SECRET', ''), API_TOKEN: get(env, 'API_SECRET_TOKEN', ''),
      __env: env,
    };
    const proxy = new Proxy(Object.create(null), {
      get(_t, key) {
        if (key in extra) return extra[key];
        try {
          const v = env[key];
          /* whatever the binding was called, the handle is always sanitised */
          if (v && det.d1 && v === det.d1) return d1;
          return v;
        } catch (e) { return undefined; }
      },
      has(_t, key) { return (key in extra) || (key in env); },
      set(_t, key, value) { try { env[key] = value; } catch (e) {} return true; },
      deleteProperty(_t, key) { try { delete env[key]; } catch (e) {} return true; },
      ownKeys() {
        let keys = [];
        try { keys = Object.keys(env); } catch (e) {}
        return [...new Set([...keys, ...Object.keys(extra)])];
      },
      getOwnPropertyDescriptor(_t, key) {
        if (key in extra) return { enumerable: true, configurable: true, value: extra[key] };
        try { return Object.getOwnPropertyDescriptor(env, key); } catch (e) { return { enumerable: true, configurable: true, value: env[key] }; }
      },
    });
    ALIASES.set(env, { key: aliasKey(env), proxy });
    return proxy;
  };

  /* ─────────────── tables that the newer modules add on top ────────────── */
  const EXTRA_DDL = [
    `CREATE TABLE IF NOT EXISTS qv_admins (telegram_id TEXT PRIMARY KEY, name TEXT, role TEXT DEFAULT 'admin', added_at INTEGER DEFAULT (unixepoch()))`,
    `CREATE TABLE IF NOT EXISTS qv_dns_log (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type INTEGER, source TEXT, ms INTEGER, ts INTEGER DEFAULT (unixepoch()))`,
    `CREATE INDEX IF NOT EXISTS ix_dnslog_ts ON qv_dns_log(ts)`,
    `CREATE INDEX IF NOT EXISTS ix_dnslog_name ON qv_dns_log(name)`,
    `ALTER TABLE qv_admins ADD COLUMN note TEXT`,
  ];

  let booted = false;
  /** first-use boot: schema, extensions, bootstrap data, pools, secrets */
  const boot = async (env, ctx) => {
    if (booted) return { cached: true };
    const steps = {};
    const det = detect(env);
    if (det.d1) {
      const aliased = alias(env);
      steps.schema = await QV.safeAsync(() => QV.d1.migrate(aliased), { error: 'migrate failed' });
      let extra = 0;
      for (const sql of EXTRA_DDL) {
        const ok = await QV.safeAsync(async () => { await det.d1.prepare(sql).run(); return true; }, false);
        if (ok) extra++;
      }
      steps.extra_tables = extra;
      steps.bootstrap = await QV.safeAsync(() => QV.d1.bootstrap(aliased, { QUOTA_GB_DEFAULT: String(get(env, 'DEFAULT_QUOTA_GB', DEFAULTS.DEFAULT_QUOTA_GB)) }), null);
      /* the tables the merged generations expect (their own writers keep them) */
      steps.legacySchema = await QV.safeAsync(() => QV.legacySchema && QV.legacySchema.ensure(aliased), null);
      /* env-configured owner ids are materialised in qv_admins, so the role
         lookup, the notification fan-out and the admin list all agree — and a
         deployment without ADMIN_TELEGRAM_ID simply stays claimable */
      steps.owner = await QV.safeAsync(() => QV.owner && QV.owner.sync(aliased, ctx), null);
      const seeded = await QV.safeAsync(() => QV.d1.Kv.get(aliased, 'qv:boot:seeded', null), null);
      if (!seeded) {
        await QV.safeAsync(() => QV.antidpi.seed(aliased), null);
        await QV.safeAsync(() => QV.d1.Kv.set(aliased, 'qv:boot:seeded', Date.now(), 0), null);
        steps.seeded = true;
      }
      if (!(await QV.safeAsync(() => QV.d1.Kv.get(aliased, 'qv:strategy', null), null))) {
        steps.strategy = await QV.safeAsync(() => QV.antidpi.analyse(aliased, ctx, { reason: 'boot' }), null);
      }
    }
    await QV.safeAsync(() => QV.env.secrets(env, ctx), null);
    booted = true;
    QV.log.info('env', 'boot sequence complete', { ...steps, d1: !!det.d1, kv: !!det.kv, ai: !!det.ai });
    return steps;
  };

  /* ──────────────── the normalised configuration object ───────────────── */
  const CACHE = new Map();
  const cacheKey = (env) => {
    try { return Object.keys(env || {}).filter(k => !/^(DB|KV|AI|BUCKET|R2)$/.test(k)).sort().join(','); }
    catch (e) { return 'default'; }
  };

  const build = async (env, ctx) => {
    const det = detect(env);
    const sec = await secrets(env, ctx);
    const doh = list(env, 'DoH_UPSTREAMS', DEFAULTS.DoH_UPSTREAMS.split(','));
    const cfg = {
      env, bindings: det.bindings, d1: det.d1, kv: det.kv, r2: det.r2, ai: det.ai,
      do: Object.values(det.dos), doNames: Object.keys(det.dos), queue: det.queues.map(q => q.name), queues: det.queues,
      vectors: det.vectors, names: det.names,
      doh, dohLocal: doh.slice(1), upstream: get(env, 'FALLBACK_UPSTREAM', DEFAULTS.FALLBACK_UPSTREAM),
      adminPassword: sec.adminPassword, apiToken: sec.api, jwtSecret: sec.jwt, bridgeSecret: sec.bridge,
      generatedSecrets: sec.generated,
      telegram: { token: get(env, 'TELEGRAM_BOT_TOKEN', ''), adminId: String(get(env, 'ADMIN_TELEGRAM_ID', '') || '') },
      owner: {
        envConfigured: !!String(get(env, 'ADMIN_TELEGRAM_ID', '') || get(env, 'ADMIN_CHAT_ID', '') || ''),
        claimTtlMin: Number(get(env, 'OWNER_CLAIM_TTL_MIN', DEFAULTS.OWNER_CLAIM_TTL_MIN)),
        maxAdmins: Number(get(env, 'OWNER_MAX_ADMINS', DEFAULTS.OWNER_MAX_ADMINS)),
        notifyQueue: Number(get(env, 'OWNER_NOTIFY_QUEUE', DEFAULTS.OWNER_NOTIFY_QUEUE)),
        notifyTries: Number(get(env, 'OWNER_NOTIFY_TRIES', DEFAULTS.OWNER_NOTIFY_TRIES)),
        lock: bool(env, 'OWNER_LOCK', false),
        pepperConfigured: !!get(env, 'OWNER_PEPPER', ''),
      },
      hosts: list(env, 'HOSTS', []).concat(list(env, 'CUSTOM_DOMAIN', [])),
      wsPath: get(env, 'WS_PATH', DEFAULTS.WS_PATH),
      nat64: { prefix: get(env, 'NAT64_PREFIX', DEFAULTS.NAT64_PREFIX), enabled: bool(env, 'DNS64_ENABLED', true) },
      limits: {
        quotaGb: Number(get(env, 'DEFAULT_QUOTA_GB', DEFAULTS.DEFAULT_QUOTA_GB)),
        maxSessions: Number(get(env, 'MAX_SESSIONS', DEFAULTS.MAX_SESSIONS)),
        maxUsers: Number(get(env, 'MAX_USERS', DEFAULTS.MAX_USERS)),
      },
      policy: {
        blockAds: bool(env, 'BLOCK_ADS', true), blockMalware: bool(env, 'BLOCK_MALWARE', true),
        allowCountries: list(env, 'ALLOW_COUNTRIES', []), denyCountries: list(env, 'DENY_COUNTRIES', ['KP']),
        strict: bool(env, 'STRICT_EVASION', false), antidi: get(env, 'ANTIDPI_MODE', 'auto'),
        probeTarpitMs: Number(get(env, 'PROBE_TARPIT_MS', DEFAULTS.PROBE_TARPIT_MS)),
        banMinutes: Number(get(env, 'BAN_MINUTES', DEFAULTS.BAN_MINUTES)),
      },
      trustAccess: bool(env, 'TRUST_CLOUDFLARE_ACCESS', false),
      logLevel: get(env, 'LOG_LEVEL', 'info'),
      timezone: get(env, 'TIMEZONE', DEFAULTS.TIMEZONE),
      features: {
        vless: true, shadowsocks: true, shadowsocks2022: true, doh: true, nat64: true, dns_tunnel: true,
        telegram: !!get(env, 'TELEGRAM_BOT_TOKEN', ''), ai: !!det.ai, r2: !!det.r2,
        durable_objects: Object.keys(det.dos).length > 0, queues: det.queues.length > 0, vectorize: det.vectors.length > 0,
        cron: true, panels: true, api: true, qr: true,
      },
      built: Date.now(),
    };
    return cfg;
  };

  let cached = null; let cachedAt = 0; let cachedKeys = '';
  const prepare = async (env, ctx) => {
    if (!env || typeof env !== 'object') {
      /* handlers must survive being called without an env (tests, health probes) */
      return cached || (cached = await build({}, ctx));
    }
    const key = cacheKey(env);
    if (cached && cachedKeys === key && Date.now() - cachedAt < 30000) {
      /* the boot sequence runs once per isolate; the alias is rebuilt cheaply */
      await boot(env, ctx);
      return cached;
    }
    const aliased = alias(env);
    await boot(env, ctx);
    cached = await build(env, ctx);
    cached.env = alias(env);
    cached.aliasEnv = aliased;
    cachedKeys = key; cachedAt = Date.now();
    return cached;
  };

  QV.env = {
    get, bool, list, detect, prepare, secrets, ensureSecrets, DEFAULTS,
    alias, boot, EXTRA_DDL,
    /* convenience: first D1 binding, even for callers that only have env */
    d1Of: (env) => safeD1(detect(env).d1),
    kvOf: (env) => detect(env).kv,
    isD1, isKV, isQueue, isDO, isAI, isR2,
  };

  /* what this deployment can actually do — /health and the panel read it */
  QV.env.features = (env) => {
    const d = QV.env.detect(env || {});
    return {
      d1: !!d.d1, kv: !!d.kv, r2: !!d.r2, queue: !!d.queue, durable_object: !!d.do, ai: !!d.ai, sockets: !!d.sockets,
      telegram: !!(env && env.TELEGRAM_BOT_TOKEN), admin_password: !!(env && env.ADMIN_PASSWORD),
      dns: true, nat64: true, shadowsocks: true, vless: true, subscription: true,
      panels: true, api: true, cron: true, fragment: true, clean_ip_scan: true, ai_local: !!QV.localAI,
    };
  };

  /* every namespace this module exported is reachable through QV.env */
})();
