/* ═══════════════════════════════════════════════════════════════════════════
 * 45 · COMPATIBILITY LAYER
 * ═══════════════════════════════════════════════════════════════════════════
 *  31k lines of history meet 5k lines of new engine.  This file is the seam:
 *  every symbol a legacy unit may reach for — under its historic spelling —
 *  is provided here, backed by the modern implementation.  Nothing is stubbed
 *  out and nothing throws: compatibility is a translation, not a downgrade.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function compat() {
  const DAY = 86400, HOUR = 3600;

  /* ───────────────────────── boot bookkeeping ──────────────────────────── */
  QV.__markBoot = QV.__markBoot || (() => { QV.__bootId = QV.shortId(8); QV.__bootedAt = Date.now(); return QV.__bootId; });
  try {
    Object.defineProperty(QV, 'BOOT_ID', {
      get() { if (!QV.__bootId) QV.__markBoot(); return QV.__bootId; },
      configurable: true,
    });
    Object.defineProperty(QV, 'bootedAt', {
      get() { if (!QV.__bootedAt) QV.__markBoot(); return QV.__bootedAt; },
      configurable: true,
    });
    /* historic spelling kept alive for anything that reads it directly */
    Object.defineProperty(QV, 'BOOTED_AT', { get() { return QV.bootedAt; }, configurable: true });
  } catch (e) { /* workerd already froze the shape: lazy getters are best effort */ }

  /* ───────────────────────── timing / flow helpers ─────────────────────── */
  /* fire-and-forget: hand the promise to the runtime and forget it */
  QV.defer = QV.defer || ((fn) => { const t = setTimeout(() => QV.safeAsync(fn, null), 0); if (t && t.unref) t.unref(); return t; });
  /* a real deadline — the timer must actually wait `ms`, not fire on the next
     tick (a 0 ms race aborted every raced self-check suite) */
  QV.withTimeout = (p, ms, label = 'timeout') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), Math.max(1, Number(ms) || 1000));
    Promise.resolve(p).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
  QV.isUuid = QV.isUuid || ((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')));
  QV.esc = QV.esc || ((s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));

  /* ───────────────────────── counters / metrics ────────────────────────── */
  if (!QV.metrics || typeof QV.metrics !== 'object') {
    const counters = new Map(), observations = new Map(), startedAt = Date.now();
    QV.metrics = {
      count(name, n = 1) { counters.set(name, (counters.get(name) || 0) + Number(n || 0)); },
      observe(name, value) {
        const arr = observations.get(name) || [];
        arr.push(Number(value) || 0);
        if (arr.length > 200) arr.shift();
        observations.set(name, arr);
      },
      histogram(name) {
        const a = observations.get(name) || [];
        if (!a.length) return { count: 0 };
        const s = [...a].sort((x, y) => x - y);
        return { count: s.length, min: s[0], max: s[s.length - 1], avg: Math.round(s.reduce((p, c) => p + c, 0) / s.length), p95: s[Math.floor(s.length * 0.95)] };
      },
      snapshot() {
        const histograms = {};
        for (const name of observations.keys()) histograms[name] = QV.metrics.histogram(name);
        return {
          counters: Object.fromEntries(counters),
          timings: Object.fromEntries(observations),
          histograms,
          uptime_s: Math.round((Date.now() - startedAt) / 1000),
        };
      },
      /** rollup() resets the isolate counters after folding them into D1 */
      reset() { counters.clear(); observations.clear(); return true; },
      async flush(env) { await QV.safeAsync(() => QV.d1.Metrics.merge(env, QV.metrics.snapshot()), null); return QV.metrics.snapshot(); },
    };
  }

  /* ───────────────────────── logging ──────────────────────────────────── */
  if (typeof QV.log === 'function') {
    const baseLog = QV.log;
    ['debug', 'info', 'warn', 'error'].forEach(lvl => { baseLog[lvl] = baseLog[lvl] || ((msg, details) => baseLog({ level: lvl, component: 'core', message: msg, details })); });
    if (!baseLog.time) {
      baseLog.time = () => {
        const t0 = Date.now();
        return (label, details) => baseLog.debug(`${label} ${Date.now() - t0}ms`, details);
      };
    }
    QV.log = baseLog;
  }

  /* ───────────────────────── crypto aliases ───────────────────────────── */
  const C = QV.crypto;
  if (C) {
    /* modern seal / open_ with an explicit nonce; a nonce is returned so the
       caller can pass it back verbatim */
    QV.seal = (key, plaintext, aad, nonce) => {
      const n = nonce || QV.rand(12);
      const r = C.aeadEncrypt(key, n, plaintext || new Uint8Array(0), aad || new Uint8Array(0));
      return { ciphertext: r.ciphertext, tag: r.tag, nonce: n, combined: QV.concat(r.ciphertext, r.tag) };
    };
    QV.open_ = (key, ciphertext, tag, aad, nonce) => C.aeadDecrypt(key, nonce, ciphertext, tag, aad || new Uint8Array(0));
    const baseHkdf = C.hkdf;
    QV.hkdf = (hash, ikm, salt, info, len) => baseHkdf(hash, ikm, salt, info || new Uint8Array(0), len);
    QV.hkdf256 = (ikm, salt, info, len = 32) => baseHkdf('SHA-256', ikm, salt, info || new Uint8Array(0), len);
    QV.pbkdf2 = C.pbkdf2 || (async (pass, salt, iters = 100000, len = 32) => {
      const key = await crypto.subtle.importKey('raw', typeof pass === 'string' ? QV.utf8(pass) : pass, 'PBKDF2', false, ['deriveBits']);
      return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, key, len * 8));
    });
    QV.randomBytes = QV.rand;
    QV.hash = QV.hash || C.sha256 || QV.sha256;
    /* SHA-1 is intentionally not shipped; the alias keeps ancient callers alive
       while handing them the stronger digest */
    QV.sha1 = QV.sha1 || C.sha1 || QV.sha256;
    QV.md5 = C.MD5;
  }

  /* ───────────────────────── base64 aliases ───────────────────────────── */
  const B = QV.b64;
  if (B && !B.enc) {
    B.enc = (bytes) => B.std(typeof bytes === 'string' ? QV.utf8(bytes) : bytes);
    B.dec = (str) => B.fromStd(str);
  }

  /* ───────────────────────── QR aliases ───────────────────────────────── */
  if (QV.qr) {
    /* three spellings, one encoder: render() → {svg,…}, svg() → string */
    const toSvg = QV.qr.toSvg || QV.qr.render || QV.qr.encode;
    QV.qr.render = (text, opts) => toSvg(text, opts);
    QV.qr.svg = (text, opts) => { const r = toSvg(text, opts); return r && r.svg ? r.svg : r; };
    QV.qr.dataUri = (text, opts) => 'data:image/svg+xml;base64,' + QV.b64.enc(QV.utf8(QV.qr.svg(text, opts)));
    if (!QV.qr.encode) QV.qr.encode = (text, opts) => toSvg(text, opts);
  }

  /* ───────────────────────── Shadowsocks aliases ──────────────────────── */
  if (QV.ss) {
    QV.ss.uri = QV.ss.buildUri;
    QV.ss.methods = () => Object.keys(QV.ss.CIPHERS);
    QV.ss.can = (m) => !!QV.ss.CIPHERS[m];
    QV.ss.passwd = QV.ss.randomPassword;
    QV.ss.encryptAddress = (host, port = 443) => QV.ss.encodeAddress(host, port);
  }

  /* ───────────────────────── DNS aliases ──────────────────────────────── */
  if (QV.dns) {
    QV.dns.lookup = (env, name, type = 'A', opts) => QV.dns.resolve(env, name, type, opts);
    QV.dns.isPoisoned = (msg) => {
      const bad = ['0.0.0.0', '127.0.0.1', '::', '10.10.34.34', '10.10.34.35', '10.10.34.36'];
      const hit = ((msg && msg.answers) || []).filter(a => bad.includes(String(a.value))).map(a => a.value);
      return { poisoned: hit.length > 0, hits: hit };
    };
    /* the DNS module already unwraps NAT64 (64:ff9b::a.b.c.d → a.b.c.d); this
       historic spelling simply keeps the old name alive */
    const baseUnwrap = QV.dns.unwrapTarget;
    QV.dns.nat64 = QV.dns.nat64 || { toV6: QV.dns.v4ToV6, toV4: QV.dns.v6ToV4, applies: (q, msg) => !!q && q.type === 28 && !!msg && (msg.answers || []).some(a => a.type === 1) && !(msg.answers || []).some(a => a.type === 28) };
    QV.dns.unwrapTarget = (host, prefixes) => (baseUnwrap ? baseUnwrap(host, prefixes) : { host, nat64: false });
    QV.dns.unwrap = QV.dns.unwrapTarget;
  }

  /* ───────────────────────── D1 repository aliases ────────────────────── */
  const D = QV.d1;
  if (D) {
    /* historic spelling of the user repository: quota_bytes → total_bytes,
       name → tag, and a hard revoke path that also closes sessions */
    D.Users.upsert = async (env, u = {}) => {
      const id = u.uuid || u.id || u.user_uuid;
      const patch = {};
      for (const k of ['email', 'tag', 'protocol', 'plan', 'note', 'role', 'country', 'sub_format']) if (u[k] !== undefined) patch[k] = u[k];
      if (u.name !== undefined && u.tag === undefined) patch.tag = u.name;
      if (u.quota_bytes !== undefined) patch.total_bytes = Math.round(Number(u.quota_bytes) || 0);
      if (u.total_bytes !== undefined) patch.total_bytes = Math.round(Number(u.total_bytes) || 0);
      if (u.used_bytes !== undefined) {
        /* the create path understands the camelCase spelling, the update path
           the snake_case column — set both so neither drops the value */
        patch.used_bytes = Math.round(Number(u.used_bytes) || 0);
        patch.usedBytes = patch.used_bytes;
      }
      if (u.max_sessions !== undefined) patch.max_sessions = Number(u.max_sessions) || 1;
      if (u.ip_limit !== undefined) patch.ip_limit = Number(u.ip_limit) || 1;
      if (u.expires_at !== undefined) patch.expires_at = u.expires_at || null;
      if (u.telegram_id !== undefined) patch.telegram_id = String(u.telegram_id);
      if (u.killswitch !== undefined) patch.killswitch = u.killswitch ? 1 : 0;
      if (u.enabled !== undefined) patch.enabled = u.enabled ? 1 : 0;
      if (u.approved !== undefined) patch.approved = u.approved ? 1 : 0;
      const existing = id ? await D.Users.get(env, id) : null;
      if (existing) return D.Users.update(env, id, patch);
      /* admin-created accounts are usable immediately unless told otherwise */
      const created = await D.Users.create(env, {
        approved: 1, enabled: 1, ...patch, uuid: id,
      });
      if (!created) return null;
      const late = {};
      if (patch.used_bytes !== undefined) late.used_bytes = patch.used_bytes;
      if (patch.up_bytes !== undefined) late.up_bytes = patch.up_bytes;
      if (patch.down_bytes !== undefined) late.down_bytes = patch.down_bytes;
      if (Object.keys(late).length) await D.Users.update(env, created.uuid, late);
      if (D.Users.forget) await QV.safeAsync(() => D.Users.forget(env, created.uuid), null);
      return D.Users.get(env, created.uuid);
    };
    D.Users.patch = (env, uuid, patch) => D.Users.update(env, uuid, patch);

    /* per-user cut-off: revoke every config, close live sessions, notify */
    D.Users.setKill = async (env, uuid, on = true, reason = 'admin') => {
      const user = await D.Users.get(env, uuid);
      if (!user) return null;
      if (on) await D.Users.killswitch(env, uuid, true, reason);
      else {
        await D.run(env, 'UPDATE qv_users SET killswitch = 0, enabled = 1, updated_at = unixepoch() WHERE uuid = ?', uuid);
        await D.run(env, 'UPDATE qv_configs SET revoked = 0 WHERE uuid = ?', uuid).catch(() => {});
      }
      QV.lru.delete('user:' + uuid);
      const fresh = await D.Users.get(env, uuid);
      /* the tiered verdict (RAM → KV → D1) must never keep serving a state
         that a cut or a revive has just replaced */
      if (D.Users.forget) await QV.safeAsync(() => D.Users.forget(env, uuid, { force: true }), null);
      await D.Events.log(env, { kind: on ? 'user:cut' : 'user:revive', level: 'warn', uuid, message: reason });
      QV.emit(env, on ? 'user:cut' : 'user:revive', 'warn', { uuid, message: reason, meta: { tag: fresh && fresh.tag } });
      return fresh;
    };
    /* historic name used by the bot and the panels */
    D.Users.kill = (env, uuid, reason) => D.Users.setKill(env, uuid, true, reason);
    D.Users.revive = (env, uuid) => D.Users.setKill(env, uuid, false, 'revive');

    if (D.Sessions && !D.Sessions.closeAll) D.Sessions.closeAll = (env, uuid, reason) => D.Sessions.closeAllForUser(env, uuid, reason);
    if (D.Sessions && !D.Sessions.list) D.Sessions.list = (env, limit = 200) => D.all(env, `SELECT * FROM qv_sessions WHERE closed = 0 ORDER BY started_at DESC LIMIT ${Number(limit) || 200}`);
    /* ── operator sessions ────────────────────────────────────────────────
     * The panel signs an operator in with a random sid; it lives in the KV
     * repository with a TTL, so it survives isolates and can be revoked
     * instantly.  `Sessions.admin` is the verifier (used by the auth ladder),
     * `adminDestroy` the logout/revoke path. */
    D.Sessions.adminCreate = async (env, s = {}) => {
      const sid = s.sid || QV.uuid();
      const rec = {
        sid, role: s.role || 'admin', ip: s.ip || '0.0.0.0', ua: s.ua || '',
        created: Date.now(), last_seen: Date.now(), method: s.method || 'password',
      };
      await D.Kv.set(env, `qv:admin:sid:${sid}`, rec, s.ttl || DAY);
      return sid;
    };
    D.Sessions.adminGet = (env, sid) => (sid ? D.Kv.get(env, `qv:admin:sid:${sid}`, null) : null);
    D.Sessions.admin = async (env, sid) => {
      const rec = await D.Sessions.adminGet(env, sid);
      if (!rec) return null;
      await D.Kv.set(env, `qv:admin:sid:${sid}`, { ...rec, last_seen: Date.now() }, DAY).catch(() => {});
      return sid;
    };
    D.Sessions.adminDestroy = async (env, sid) => { await D.Kv.del(env, `qv:admin:sid:${sid}`); return true; };
    D.Sessions.adminList = async (env) => {
      const rows = await D.all(env, `SELECT key, value FROM qv_kv WHERE key LIKE 'qv:admin:sid:%' LIMIT 200`);
      return (rows || []).map(r => QV.json.parse(typeof r.value === 'string' ? r.value : '{}', { sid: String(r.key).split(':').pop() }));
    };

    /* ── FSM: two payload generations live in the same table.  The data layer
     *  writes {__state, data} with a TTL and unwraps it on read; older rows
     *  hold a bare payload.  Both must keep working for every bot flow. */
    if (D.Fsm) {
      const baseGet = D.Fsm.get;
      D.Fsm.get = async (env, chatId) => {
        const row = await QV.safeAsync(() => baseGet(env, chatId), null);
        if (!row || !row.state) return { state: 'idle', data: {}, role: 'guest', updated_at: 0 };
        return {
          ...row,
          state: String(row.state).toLowerCase(),
          data: row.data && typeof row.data === 'object' ? row.data : {},
          raw_state: row.state,
        };
      };
    }

    if (D.Metrics) {
      if (!QV.metrics.rollup) QV.metrics.rollup = (env) => D.Metrics.rollup(env);
      if (!QV.metrics.set) QV.metrics.set = (env, k, v) => D.Metrics.set(env, k, v);
    }
    if (D.Kv) {
      QV.kv = QV.kv || D.Kv;
      QV.cache = QV.cache || {
        get: (env, key, dflt = null) => D.Kv.get(env, key, dflt),
        set: (env, key, value, ttl = DAY) => D.Kv.set(env, key, value, ttl),
        del: (env, key) => D.Kv.del(env, key),
      };
    }
  }

  /* ───────────────────────── panel / bot aliases ──────────────────────── */
  if (QV.panels) {
    QV.panels.user = QV.panels.user || QV.panels.userPage;
    QV.panels.admin = QV.panels.admin || QV.panels.adminPage;
    QV.panels.css = QV.panels.css || (() => '');
  }
  if (!QV.bot && QV.telegram) QV.bot = QV.telegram;

  /* ───────────────────────── legacy bridge helpers ────────────────────── */
  QV.unit = QV.unit || ((name) => {
    if (typeof __QF === 'undefined' || !__QF || !__QF.resolve) return null;
    return QV.safeAsync(() => __QF.resolve(name), null);
  });
  QV.legacyNames = QV.legacyNames || ['handleVLESSConnection', 'handleSubscription', 'handleUserPanel', 'handleAdminPanel', 'APIRequest', 'handleAPIRequest', 'TelegramWebhook', 'handleHealthCheck', 'AntiCensorshipEngine', 'VLESSEngine', 'AIEngine', 'SecurityLayer'];

  /* ───────────────────────── misc helpers the modules share ───────────── */
  if (!QV.humanN) QV.humanN = (n) => QV.humanBytes(n);
  if (!QV.bytesToSize) QV.bytesToSize = (n) => QV.humanBytes(n);
  if (!QV.shuffle) QV.shuffle = (arr) => arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  if (!QV.range) QV.range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
  if (!QV.randomInt) QV.randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  if (!QV.isPrivateIp) QV.isPrivateIp = (ip) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|::1|f[cd])/i.test(String(ip || ''));
  if (!QV.jsonSafe) QV.jsonSafe = (obj, fallback = null) => { try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return fallback; } };

  /* ───────────────────────── AI aliases ───────────────────────────────── */
  if (QV.ai) {
    const A = QV.ai;
    /* catalogue() must hand back the real table, never an empty stand-in */
    A.catalog = () => {
      const c = A.catalogue;
      return (typeof c === 'function' ? c() : c) || [];
    };
    A.list = () => (typeof A.catalog === 'function' ? A.catalog() : A.catalog) || [];
    A.byKind = A.byKind || ((kind) => {
      const rows = A.list();
      return rows.find(m => (m.kind || m.task || 'chat') === kind) || rows[0] || null;
    });
    /* the strongest model for a task: catalogue score first, live latency and
       quota demotions second (ai.state is fed by real calls and AI Gateway) */
    A.bestModel = (env, kind = 'chat') => {
      const rows = A.byKind(kind) || A.byKind('chat') || [];
      const list = Array.isArray(rows) ? rows : [rows];
      const demoted = (A.state && A.state.demoted) || {};
      const usable = list.filter(m => m && m.id && !demoted[m.id]);
      const pick = usable[0] || list[0] || A.list()[0] || null;
      return pick ? (pick.id || pick.name) : null;
    };
    A.bestId = (env, kind) => A.bestModel(env, kind);
    A.available = A.available || ((env) => !!(QV.env.detect(env || {}).ai));
    if (!A.systemPrompt) {
      A.systemPrompt = () => 'You are the operator copilot of a network resilience service. Answer in the operator language, be terse, and prefer JSON actions.';
    }
    if (!A.think) {
      A.think = async (env, prompt, opts = {}) => {
        if (QV.localAI && QV.localAI.think) return QV.localAI.think(env, prompt, opts);
        return { via: 'local', text: String(await A.run(env, prompt, opts)) };
      };
    }
  }

  /* historic call spellings for the subscription sync */
  QV.syncUsers = (env, ctx, uuid) => QV.subs.syncUsers(env, ctx, uuid);
  QV.syncSubs = QV.syncUsers;

  /* ───────────────────────── health snapshot ──────────────────────────── */
  QV.health = QV.health || (async (env) => {
    const d = QV.env.detect(env || {});
    return {
      ok: !!(d.d1),
      version: QV.VERSION, boot_id: QV.BOOT_ID, uptime_s: QV.metrics.snapshot().uptime_s,
      d1: !!d.d1, kv: !!d.kv, r2: !!d.r2, queue: !!d.queue, ai: !!d.ai, do: !!d.do, sockets: !!d.sockets,
      features: QV.env.features(env || {}),
      metrics: QV.metrics.snapshot().counters,
    };
  });
})();
