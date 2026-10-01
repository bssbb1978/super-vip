/* ═══════════════════════════════════════════════════════════════════════════
 * A3 · DATA LAYER EXTENSIONS — bootstrap, metrics, events, audit, wrappers
 * ═══════════════════════════════════════════════════════════════════════════
 *  The header ships the raw schema + repositories.  Here they are *extended*
 *  (never replaced): extra columns for the Telegram/approval flow, richer
 *  user queries, quota-aware sweeps, a metrics roll-up, event/audit helpers,
 *  and a full export used by the daily backup job.
 *  Every wrapper delegates to the original implementation first, so no
 *  behaviour of the bundled generations is lost.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function extendDataLayer() {
  const D = QV.d1;
  const HOUR = 3600, DAY = 86400;

  /* ---- 0. accept both `env` and a raw D1 binding -------------------------
   * The core sometimes holds only the binding (env.__bindings.d1), while the
   * legacy generations pass the worker env.  Resolve the handle once here so
   * every repository works with either shape.                                */
  const dbOf = (env) => (env && typeof env.prepare === 'function' && typeof env.batch === 'function')
    ? env
    : (env && env.DB) || null;
  /** the original helpers read `env.DB`, so a bare binding must be wrapped */
  const asEnv = (env) => (env && typeof env.prepare === 'function' && typeof env.batch === 'function')
    ? { DB: env }
    : env;
  const wrapDb = (fn) => (env, ...rest) => fn(asEnv(env), ...rest);
  const baseOne = D.one, baseAll = D.all, baseRun = D.run, baseBatch = D.batch;
  D.one = wrapDb(baseOne);
  D.all = wrapDb(baseAll);
  D.run = wrapDb(baseRun);
  D.batch = wrapDb(baseBatch);
  D.db = dbOf;
  D.asEnv = asEnv;

  /* ---- 1. additive migrations (safe on existing databases) -------------- */
  const EXTRA_COLUMNS = [
    /* cron/task locks live in D1: KV is eventually consistent and its write
       quota is far too small to be used as a lock table */
    /* clean-endpoint engine: aggregates only, never raw client reports */
    `CREATE TABLE IF NOT EXISTS qv_ip_scores (
       scope TEXT NOT NULL, ip TEXT NOT NULL, family TEXT DEFAULT 'v4', provider TEXT, asn TEXT,
       samples REAL DEFAULT 0, ok REAL DEFAULT 0, tls_ok REAL DEFAULT 0, ws_ok REAL DEFAULT 0,
       rtt_ms REAL, rtt_p95 REAL, jitter REAL, score REAL DEFAULT 0, confidence REAL DEFAULT 0,
       state TEXT DEFAULT 'active', fails INTEGER DEFAULT 0, backoff INTEGER DEFAULT 0,
       cooldown_until INTEGER DEFAULT 0, last_ok INTEGER DEFAULT 0, last_probe INTEGER DEFAULT 0,
       edge_score REAL DEFAULT 0, suspect INTEGER DEFAULT 0, country TEXT, meta TEXT, updated_at INTEGER DEFAULT 0,
       PRIMARY KEY (scope, ip))`,
    'CREATE INDEX IF NOT EXISTS ix_ip_scores_rank ON qv_ip_scores(scope, state, score)',
    /* the engine reads `WHERE scope = ? ORDER BY score DESC LIMIT 400`:
       (scope,state,score) cannot order that scan without a state equality,
       this one can (and covers the hand-out ordering too) */
    'CREATE INDEX IF NOT EXISTS ix_ip_scores_scope_score ON qv_ip_scores(scope, score DESC)',
    `CREATE TABLE IF NOT EXISTS qv_ip_ranges (
       provider TEXT PRIMARY KEY, family TEXT, count INTEGER DEFAULT 0, source TEXT, fetched_at INTEGER)`,
    /* 5-minute (scope, bucket) deltas — the only way to see a *change* in
       success rate (cumulative counters cannot); written by the flush path,
       read by detectBlocks() */
    `CREATE TABLE IF NOT EXISTS qv_ip_windows (
       scope TEXT NOT NULL, bucket INTEGER NOT NULL,
       samples REAL DEFAULT 0, ok REAL DEFAULT 0, ws_ok REAL DEFAULT 0, tls_ok REAL DEFAULT 0, fails REAL DEFAULT 0,
       PRIMARY KEY (scope, bucket))`,
    'CREATE INDEX IF NOT EXISTS ix_ip_windows_bucket ON qv_ip_windows(bucket)',
    /* last validated live ranges per provider: a failed fetch must never erase
       a good list (additive column; NULL means "never had a live list") */
    'ALTER TABLE qv_ip_ranges ADD COLUMN payload TEXT',
    `CREATE TABLE IF NOT EXISTS qv_jobs (
       id TEXT PRIMARY KEY, until INTEGER DEFAULT 0, started_at INTEGER DEFAULT 0,
       runs INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, last_ms INTEGER DEFAULT 0, last_at INTEGER DEFAULT 0)`,
    'ALTER TABLE qv_users ADD COLUMN telegram_id TEXT',
    'ALTER TABLE qv_users ADD COLUMN approved INTEGER DEFAULT 0',
    'ALTER TABLE qv_users ADD COLUMN approved_at INTEGER',
    'ALTER TABLE qv_users ADD COLUMN role TEXT DEFAULT \'user\'',
    'ALTER TABLE qv_users ADD COLUMN country TEXT',
    'ALTER TABLE qv_users ADD COLUMN last_device TEXT',
    'ALTER TABLE qv_users ADD COLUMN sub_format TEXT DEFAULT \'auto\'',
    'ALTER TABLE qv_users ADD COLUMN backup_kv INTEGER DEFAULT 0',
    'ALTER TABLE qv_fsm ADD COLUMN ttl INTEGER',
    'ALTER TABLE qv_sni_pool ADD COLUMN family TEXT',
    'ALTER TABLE qv_ip_pool ADD COLUMN asn TEXT',
    'ALTER TABLE qv_configs ADD COLUMN fragment INTEGER DEFAULT 0',
    'CREATE INDEX IF NOT EXISTS ix_users_tg ON qv_users(telegram_id)',
    'CREATE INDEX IF NOT EXISTS ix_users_pending ON qv_users(enabled, approved)',
  ];

  const baseMigrate = D.migrate;
  D.migrate = async (env) => {
    const db = dbOf(env);
    const r = await baseMigrate(db ? { DB: db } : env);
    for (const sql of EXTRA_COLUMNS) await QV.safeAsync(() => db.prepare(sql).run());
    return r;
  };

  /* ---- 2. first-run bootstrap ------------------------------------------ */
  D.bootstrap = async (env, cfg = {}) => {
    if (!dbOf(env)) return { ok: false, reason: 'no D1' };
    const existing = await D.one(env, 'SELECT COUNT(*) AS c FROM qv_users');
    if ((existing?.c || 0) > 0) {
      /* still make sure an admin row exists */
      const admins = await D.one(env, 'SELECT COUNT(*) AS c FROM qv_users WHERE role = ?', 'admin');
      if ((admins?.c || 0) === 0) await D.Users.create(env, { uuid: 'admin', role: 'admin', enabled: true, approved: true, note: 'bootstrap-admin' });
      return { ok: true, existing: existing.c };
    }
    const admin = await D.Users.create(env, {
      uuid: 'admin', role: 'admin', enabled: true, approved: true,
      total_bytes: parseInt(cfg.QUOTA_GB_DEFAULT || '500', 10) * 1024 ** 3,
      note: 'bootstrap-admin',
    });
    const demo = await D.Users.create(env, {
      uuid: QV.genUuid(), role: 'user', enabled: false, approved: false,
      total_bytes: 30 * 1024 ** 3, note: 'example — enable or delete',
    });
    await D.Events.log(env, { kind: 'deploy', level: 'info', message: `bootstrap: ${QV.VERSION}`, meta: { admin: admin?.uuid, demo: demo?.uuid } });
    return { ok: true, created: { admin: admin?.uuid, demo: demo?.uuid } };
  };

  /* ---- 3. Kv: alias + bare-binding tolerance -------------------------- */
  const baseKvGet = D.Kv.get, baseKvPut = D.Kv.put, baseKvDel = D.Kv.del;
  D.Kv.get = (env, key, dflt) => baseKvGet(asEnv(env), key, dflt);
  D.Kv.put = (env, key, value, ttl) => baseKvPut(asEnv(env), key, value, ttl);
  D.Kv.del = (env, key) => baseKvDel(asEnv(env), key);
  D.Kv.set = (env, key, value, ttl) => D.Kv.put(env, key, value, ttl);
  if (!D.Kv.remove) D.Kv.remove = (env, key) => D.Kv.del(env, key);

  /* ---- 4. Users extensions --------------------------------------------- */
  const baseCreate = D.Users.create;
  const baseUpdate = D.Users.update;
  const baseList = D.Users.list;
  const baseSweep = D.Users.sweep;

  D.Users.create = async (env, u = {}) => {
    const created = await baseCreate(env, {
      uuid: u.uuid && u.uuid !== 'undefined' ? u.uuid : undefined,
      email: u.email, tag: u.tag, protocol: u.protocol, plan: u.plan,
      total_bytes: u.total_bytes ?? u.quotaBytes ?? 0,
      max_sessions: u.max_sessions ?? u.sessionLimit ?? 3,
      ip_limit: u.ip_limit ?? u.ipLimit ?? 2,
      expires_at: u.expires_at ?? (u.expiryAt ? Math.floor(u.expiryAt / 1000) : null),
      note: u.note, sni: u.sni,
    });
    if (!created) return null;
    const patch = {};
    if (u.telegramId !== undefined) patch.telegram_id = String(u.telegramId);
    if (u.role) patch.role = u.role;
    if (u.country) patch.country = u.country;
    if (u.approved !== undefined) patch.approved = u.approved ? 1 : 0;
    if (u.enabled !== undefined) patch.enabled = u.enabled ? 1 : 0;
    if (u.killswitch !== undefined) patch.killswitch = u.killswitch ? 1 : 0;
    if (u.usedBytes !== undefined) patch.used_bytes = u.usedBytes;
    if (Object.keys(patch).length) {
      await D.run(env, `UPDATE qv_users SET ${Object.keys(patch).map(k => k + ' = ?').join(', ')} WHERE uuid = ?`,
        ...Object.values(patch), created.uuid);
    }
    const fresh = await D.Users.get(created.uuid);
    STATE_CACHE.delete(created.uuid);
    await D.Events.log(env, { kind: 'user:create', level: 'info', message: fresh?.uuid, uuid: fresh?.uuid });
    return fresh;
  };

  D.Users.update = async (env, uuid, patch = {}) => {
    if (!uuid) return null;
    const mapped = { ...patch };
    if (patch.quotaBytes !== undefined) mapped.total_bytes = Math.round(Number(patch.quotaBytes) || 0);
    if (patch.sessionLimit !== undefined) mapped.max_sessions = Number(patch.sessionLimit) || 1;
    if (patch.expiryAt !== undefined) mapped.expires_at = patch.expiryAt ? Math.floor(Number(patch.expiryAt) / 1000) : null;
    if (patch.telegramId !== undefined) mapped.telegram_id = String(patch.telegramId);
    if (patch.usedBytes !== undefined) mapped.used_bytes = Math.round(Number(patch.usedBytes) || 0);
    /* baseUpdate only persists lowercase snake_case columns, so non-column
       helpers (quotaGb, approvedAt, …) are dropped automatically. */
    if (patch.enabled !== undefined) mapped.enabled = patch.enabled ? 1 : 0;
    if (patch.approved !== undefined) mapped.approved = patch.approved ? 1 : 0;
    if (patch.killswitch !== undefined) mapped.killswitch = patch.killswitch ? 1 : 0;
    if (patch.note !== undefined) mapped.note = patch.note;
    if (patch.role !== undefined) mapped.role = patch.role;
    if (patch.country !== undefined) mapped.country = patch.country;
    if (patch.plan !== undefined) mapped.plan = patch.plan;
    if (patch.tag !== undefined) mapped.tag = patch.tag;
    delete mapped.quotaGb;
    const out = await baseUpdate(env, uuid, mapped);
    await D.Users.forget(env, uuid);
    return out;
  };

  /** any write to an account invalidates its cached verdict everywhere */
  /* the delete path has to forget the account too (the row is gone, so a
     cached verdict would otherwise keep an account alive for a few seconds) */
  const baseRemove = D.Users.remove;
  D.Users.remove = async (env, uuid) => {
    const r = await baseRemove(env, uuid);
    STATE_CACHE.delete(uuid);
    if (SNAP_AT) SNAP_AT.delete(uuid);
    return r;
  };

  D.Users.forget = async (env, uuid, opts = {}) => {
    if (!uuid) return false;
    STATE_CACHE.delete(uuid);
    /* re-read the row and refresh the KV snapshot the second tier serves */
    const fresh = await QV.safeAsync(() => D.Users.get(env, uuid), null);
    if (fresh) STATE_CACHE.set(uuid, projectState(fresh));
    if (opts.snapshot !== false && fresh) await QV.safeAsync(() => D.Users.snapshot(env, uuid, projectState(fresh), { force: !!opts.force }), null);
    return true;
  };

  D.Users.list = async (env, opts = {}) => {
    if (typeof opts === 'number') return baseList(env, opts);
    const { limit = 200, offset = 0, pending = false, enabled = null, role = null, q = null } = opts || {};
    const where = [];
    const params = [];
    if (pending) { where.push('approved = 0'); where.push('role != ?'); params.push('admin'); }
    if (enabled !== null) { where.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (role) { where.push('role = ?'); params.push(role); }
    if (q) { where.push('(uuid LIKE ? OR note LIKE ? OR telegram_id LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const sql = `SELECT * FROM qv_users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    return D.all(env, sql, ...params, limit, offset);
  };

  D.Users.count = async (env, opts = {}) => {
    const rows = await D.Users.list(env, { ...opts, limit: 100000, offset: 0 });
    return rows.length;
  };

  D.Users.findByTelegram = async (env, telegramId) => {
    if (!telegramId) return null;
    return D.one(env, 'SELECT * FROM qv_users WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 1', String(telegramId));
  };

  D.Users.byUuidOrTelegram = async (env, idOrTg) => D.Users.get(env, idOrTg) || D.Users.findByTelegram(env, idOrTg);

  D.Users.approve = async (env, uuid, on = true) => {
    const u = await D.Users.update(env, uuid, { approved: on, enabled: on, approvedAt: Date.now() });
    await D.Audit.log(env, { actor: 'system', action: on ? 'approve' : 'reject', target: uuid });
    return u;
  };

  /** quota watchdog v2: expiry, exhaustion, and near-limit warnings */
  D.Users.sweep = async (env, opts = {}) => {
    const base = await baseSweep(env);
    const warnAt = 0.85;
    const near = await D.all(env, `SELECT uuid, used_bytes, total_bytes FROM qv_users
        WHERE enabled = 1 AND total_bytes > 0 AND used_bytes >= total_bytes * ?`, warnAt);
    for (const u of near) {
      const pct = Math.round((u.used_bytes / u.total_bytes) * 100);
      if (pct >= 100) continue;                       // handled by baseSweep
      const lastWarn = await D.Kv.get(env, `warn:quota:${u.uuid}`, 0);
      if (Date.now() - Number(lastWarn || 0) < 6 * HOUR * 1000) continue;
      await D.Kv.set(env, `warn:quota:${u.uuid}`, Date.now(), DAY);
      const user = await D.Users.get(env, u.uuid);
      if (user?.telegram_id) await QV.telegram.send(env, user.telegram_id,
        `⚠️ ${pct}% ${'مصرف'} — ${QV.humanBytes(u.used_bytes)} / ${QV.humanBytes(u.total_bytes)}`).catch(() => {});
      QV.emit(env, 'quota:near', 'info', { uuid: u.uuid, message: `${pct}% used`, meta: { used: u.used_bytes, total: u.total_bytes } });
    }
    const stale = await D.all(env, 'SELECT uuid FROM qv_users WHERE approved = 1 AND enabled = 1 AND (last_seen IS NULL OR last_seen < unixepoch() - ?)', 30 * DAY);
    return { ...base, nearLimit: near.length, idle30d: stale.length, quotaExceeded: base.over, expired: base.expired };
  };

  /* ---- 5. Sessions extensions ------------------------------------------ */
  D.Sessions.listByUser = (env, uuid, limit = 20) =>
    D.all(env, 'SELECT * FROM qv_sessions WHERE uuid = ? ORDER BY last_alive DESC LIMIT ?', uuid, limit).then(rows => rows.map(r => ({ ...r, active: !r.closed })));

  D.Sessions.closeAllForUser = async (env, uuid, reason = 'revoked') => {
    const rows = await D.all(env, 'SELECT id FROM qv_sessions WHERE uuid = ? AND closed = 0', uuid);
    for (const r of rows) await D.run(env, 'UPDATE qv_sessions SET closed = 1, close_reason = ? WHERE id = ?', reason, r.id);
    if (rows.length) QV.emit(env, 'sessions:closed', 'info', { uuid, message: `${rows.length} sessions closed (${reason})` });
    return rows.length;
  };

  /** one call that credits usage everywhere it matters: the session row, the
   *  account totals and the rolling counters the panels read. */
  D.Sessions.meter = async (env, uuid, up = 0, down = 0, sessionId = null) => {
    const upN = Math.max(0, Number(up) || 0);
    const downN = Math.max(0, Number(down) || 0);
    const delta = upN + downN;
    /* the quota counts everything the account moved, in both directions */
    await D.run(env, `UPDATE qv_users SET used_bytes = used_bytes + ?, up_bytes = up_bytes + ?, down_bytes = down_bytes + ?,
                        last_seen = unixepoch(), updated_at = unixepoch() WHERE uuid = ?`, delta, upN, downN, uuid);
    if (sessionId) {
      await D.run(env, `UPDATE qv_sessions SET bytes_up = bytes_up + ?, bytes_down = bytes_down + ?, last_alive = unixepoch() WHERE id = ?`,
        upN, downN, sessionId);
    }
    await D.Metrics.incr(env, 'traffic', delta);
    QV.lru.delete('user:' + uuid);
    return { uuid, added: delta, up: upN, down: downN };
  };

  D.Sessions.gc = (env, olderThanSec = 900) => D.run(env,
    'UPDATE qv_sessions SET closed = 1, close_reason = COALESCE(close_reason, ?) WHERE closed = 0 AND last_alive < unixepoch() - ?', 'stale', olderThanSec);

  D.Sessions.addBytes = (env, id, up = 0, down = 0) => D.run(env,
    'UPDATE qv_sessions SET bytes_up = bytes_up + ?, bytes_down = bytes_down + ?, last_alive = unixepoch() WHERE id = ?', up, down, id).then(async () => {
      const row = await D.one(env, 'SELECT uuid, bytes_up, bytes_down FROM qv_sessions WHERE id = ?', id);
      if (row?.uuid) await D.Users.addUsage(env, row.uuid, up + down);
      return row;
    });

  /* ---- 6. Users usage accounting --------------------------------------- */
  D.Users.addUsage = (env, uuid, bytes) => D.run(env,
    'UPDATE qv_users SET used_bytes = used_bytes + ?, last_seen = unixepoch() WHERE uuid = ?', bytes, uuid)
    .then(() => { QV.lru.delete('user:' + uuid); return true; });

  /* ---- 7. FSM (persisted dialog state with ttl) ------------------------ */
  /* The bot answers in the same isolate that served the webhook most of the
     time, so the state machine is read through RAM first: a chat turn then
     costs one D1 write and no read at all.  The cache is the shared shape
     (bounded, TTL, evictable) — not a second, private map. */
  const FSM_CACHE = QV.cache('fsm', { max: 2000, maxBytes: 1 * 1024 * 1024, ttl: 15000 });
  const fsmShape = (state, data, role, ttlAbs) => ({ state, data, role, ttl: ttlAbs || 0 });

  D.Fsm.get = async (env, chatId) => {
    const key = String(chatId);
    const hit = FSM_CACHE.get(key);
    if (hit) {
      QV.count('fsm_cache_hit');
      if (hit.ttl && hit.ttl < Date.now()) { FSM_CACHE.delete(key); return { state: 'idle', data: {} }; }
      return { state: hit.state, data: hit.data, role: hit.role };
    }
    const row = await D.one(env, 'SELECT * FROM qv_fsm WHERE chat_id = ?', key);
    if (!row) { FSM_CACHE.set(key, fsmShape('idle', {}, 'admin', 0)); return { state: 'idle', data: {} }; }
    let data = QV.json.parse(row.payload, {});
    if (row.ttl && row.ttl < Date.now()) { await D.Fsm.clear(env, chatId); return { state: 'idle', data: {} }; }
    const shaped = (data && data.__state)
      ? fsmShape(data.__state, data.data || {}, row.role, row.ttl)
      : fsmShape(String(row.state || 'idle').toLowerCase() === 'idle' ? 'idle' : row.state, data, row.role, row.ttl);
    FSM_CACHE.set(key, shaped);
    return { state: shaped.state, data: shaped.data, role: shaped.role };
  };
  D.Fsm.set = (env, chatId, state, data = {}, ttlSec = HOUR) => {
    const payload = { __state: state, data: { ...data } };
    const ttl = ttlSec ? Date.now() + ttlSec * 1000 : null;
    FSM_CACHE.set(String(chatId), fsmShape(state, { ...data }, 'admin', ttl));
    return D.run(env, `INSERT INTO qv_fsm (chat_id,state,payload,role,updated_at,ttl) VALUES (?,?,?,?,unixepoch(),?)
                       ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state, payload=excluded.payload, updated_at=unixepoch(), ttl=excluded.ttl`,
      String(chatId), state, JSON.stringify(payload), 'admin', ttl);
  };
  D.Fsm.clear = async (env, chatId) => {
    FSM_CACHE.set(String(chatId), fsmShape('idle', {}, 'admin', 0));
    await D.run(env, `INSERT INTO qv_fsm (chat_id,state,payload,updated_at,ttl) VALUES (?,'idle','{}',unixepoch(),NULL)
                      ON CONFLICT(chat_id) DO UPDATE SET state='idle', payload='{}', ttl=NULL, updated_at=unixepoch()`, String(chatId));
  };

  /* ---- 8. Metrics ------------------------------------------------------ */
  /* Counters live in isolate RAM and are folded into D1 by the roll-up job.
     KV is *not* used for counters — a per-call KV write is exactly what the
     free plan's write quota cannot survive.  A rate-limited mirror keeps the
     value visible to other isolates without one write per call. */
  const METRIC_MIRROR = QV.cache('metricMirror', { max: 2000, maxBytes: 512 * 1024, ttl: 60000 });
  D.Metrics = {
    set: async (env, name, value) => {
      QV.metrics.observe('metric.set.' + name, Number(value) || 0);
      if (!METRIC_MIRROR.get(name)) { METRIC_MIRROR.set(name, 1, 60000); await D.Kv.set(env, `metric:${name}`, value, DAY); }
      return value;
    },
    /** add to a rolling counter (RAM-first, mirrored at most once a minute) */
    incr: async (env, name, by = 1, ttl = DAY) => {
      const amount = Number(by) || 0;
      QV.metrics.count('incr.' + name, amount);
      const local = (METRIC_MIRROR.get('v:' + name) || 0) + amount;
      METRIC_MIRROR.set('v:' + name, local, 600000);
      if (!METRIC_MIRROR.get(name)) {
        METRIC_MIRROR.set(name, 1, 60000);
        const cur = await D.Kv.get(env, `metric:${name}`, 0);
        await D.Kv.set(env, `metric:${name}`, Number(cur || 0) + local, ttl);
      }
      return local;
    },
    read: async (env, name) => (await D.Kv.get(env, `metric:${name}`, 0)) || 0,
    async merge(env, snapshot) {
      const bucket = Math.floor(Date.now() / 1000 / 60) * 60;      // per-minute buckets
      for (const [key, value] of Object.entries(snapshot.counters || {})) {
        const [metric, labels] = key.includes(':') ? [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)] : [key, '{}'];
        await D.run(env, `INSERT INTO qv_metrics (bucket,metric,value,labels) VALUES (?,?,?,?)
                          ON CONFLICT(bucket,metric,labels) DO UPDATE SET value = value + excluded.value`,
          bucket, metric, value, labels);
      }
      for (const [metric, h] of Object.entries(snapshot.histograms || {})) {
        await D.run(env, `INSERT INTO qv_metrics (bucket,metric,value,labels) VALUES (?,?,?,?)
                          ON CONFLICT(bucket,metric,labels) DO UPDATE SET value = (value + excluded.value)/2`, bucket, metric + '.avg', h.avg || 0, '{}');
      }
      return true;
    },
    async rollup(env) {
      await D.Metrics.merge(env, QV.metrics.snapshot());
      QV.metrics.reset();
      return true;
    },
    async summary(env) {
      const [users, active, sess, bytes, aiCalls, sni, attacks, strat] = await Promise.all([
        D.one(env, 'SELECT COUNT(*) c FROM qv_users'),
        D.one(env, 'SELECT COUNT(*) c FROM qv_users WHERE enabled = 1'),
        D.one(env, 'SELECT COUNT(*) c FROM qv_sessions WHERE closed = 0 AND last_alive > unixepoch() - 300'),
        D.one(env, 'SELECT SUM(used_bytes) s FROM qv_users'),
        D.one(env, 'SELECT COUNT(*) c FROM qv_ai_log WHERE ts > unixepoch() - 86400'),
        D.one(env, 'SELECT COUNT(*) c, SUM(CASE WHEN blocked = 0 AND score > 0 THEN 1 ELSE 0 END) h FROM qv_sni_pool'),
        D.one(env, `SELECT COUNT(*) c FROM qv_events WHERE kind LIKE '%attack%' OR kind LIKE '%probe%'`),
        D.Kv.get(env, 'qv:strategy', null),
      ]);
      const lastSweep = await D.Kv.get(env, 'metric:lastSweep', null);
      return {
        users: users?.c || 0, active: active?.c || 0, sessions: sess?.c || 0,
        bytes: bytes?.s || 0, aiCalls: aiCalls?.c || 0,
        sniTotal: sni?.c || 0, sniHealthy: sni?.h || 0,
        attacks: attacks?.c || 0,
        strategy: strat ? `v${strat.version} · ${strat.shape || 'auto'}` : 'default',
        lastSweep: lastSweep ? new Date(lastSweep.iso).toISOString().slice(11, 19) : '—',
        metrics: QV.metrics.snapshot(),
      };
    },
  };

  /* ═══ 8b. HOT-PATH USER STATE — isolate RAM → KV snapshot → D1 ═══════════
   * A running tunnel checks its owner's state every N packets.  That read must
   * never touch D1: the state lives in isolate RAM for a few seconds, falls
   * back to a KV snapshot that the metering path keeps warm, and only then
   * asks D1.  Revocation invalidates the entry immediately, so a kill-switch
   * is effective on the very next check.
   * ══════════════════════════════════════════════════════════════════════ */
  const STATE_CACHE = QV.cache('userState', { max: 5000, maxBytes: 2 * 1024 * 1024, ttl: 7000 });
  const STATE_TRUST_MS = 45000;      // how long a KV snapshot may be believed
  const QUOTA_TRUST_MS = 10000;      // how long a quota block may be believed without a re-read
  const SNAP_AT = QV.cache('userSnapAt', { max: 5000, maxBytes: 256 * 1024, ttl: 600000 });
  const projectState = (u, at = Date.now()) => ({
    uuid: u.uuid, enabled: u.enabled, killswitch: u.killswitch,
    used_bytes: Number(u.used_bytes || 0), total_bytes: Number(u.total_bytes || 0),
    expires_at: Number(u.expires_at || 0), max_sessions: Number(u.max_sessions || 0), at,
  });

  D.Users.state = async (env, uuid, opts = {}) => {
    if (!uuid) return null;
    if (!opts.fresh) {
      const hit = STATE_CACHE.get(uuid);
      if (hit) return hit;
    }
    let st = null;
    if (!opts.fresh) {
      const snap = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:ustate:' + uuid, null), null);
      /* A snapshot is a cache, not a verdict: it is only trusted while it is
         young.  A blocked account is always enforced from the snapshot (a
         kill-switch must fail closed), but a *quota* block whose snapshot is
         older than QUOTA_TRUST_MS is re-checked against D1 first — a revived
         account must not stay cut just because a KV copy is lagging. */
      if (snap && typeof snap === 'object' && snap.uuid === uuid && (Date.now() - (snap.at || 0)) < STATE_TRUST_MS) {
        const quotaBlock = !snap.killswitch && snap.enabled && snap.total_bytes > 0 && snap.used_bytes >= snap.total_bytes;
        const expired = snap.expires_at && snap.expires_at * 1000 < Date.now();
        if ((quotaBlock || expired) && Date.now() - (snap.at || 0) > QUOTA_TRUST_MS) st = null;
        else st = snap;
      }
    }
    if (!st) {
      const u = await QV.safeAsync(() => D.Users.get(env, uuid), null);
      if (!u) return null;
      st = projectState(u);
    }
    /* bytes metered since the last flush belong to this account already */
    const pend = D.Sessions.pendingFor ? D.Sessions.pendingFor(uuid) : null;
    if (pend && (pend.up || pend.down)) st = { ...st, used_bytes: (st.used_bytes || 0) + pend.up + pend.down };
    STATE_CACHE.set(uuid, st);
    return st;
  };
  /** is this account allowed to hold a tunnel right now? (pure RAM in the common case) */
  D.Users.allowed = async (env, uuid) => {
    const st = await D.Users.state(env, uuid);
    if (!st) return { ok: false, reason: 'unknown' };
    if (!st.enabled) return { ok: false, reason: 'disabled', state: st };
    if (st.killswitch) return { ok: false, reason: 'killswitch', state: st };
    if (st.expires_at && st.expires_at * 1000 < Date.now()) return { ok: false, reason: 'expired', state: st };
    if (st.total_bytes > 0 && st.used_bytes >= st.total_bytes) return { ok: false, reason: 'quota', state: st };
    return { ok: true, state: st };
  };
  D.Users.invalidate = (uuid) => STATE_CACHE.delete(uuid);
  /** write the KV snapshot the second tier reads — rate-limited per user */
  D.Users.snapshot = async (env, uuid, patch = null, opts = {}) => {
    if (!uuid) return false;
    const st = patch || STATE_CACHE.get(uuid) || (await QV.safeAsync(() => D.Users.state(env, uuid, { fresh: true }), null));
    if (!st) return false;
    const last = SNAP_AT.get(uuid) || 0;
    /* the refresh is rate-limited per key (KV write budget); an operator action
       forces one so a revive is visible to every region immediately */
    if (!patch && !opts.force && Date.now() - last < 60000) return false;
    SNAP_AT.set(uuid, Date.now());
    await QV.safeAsync(() => QV.d1.Kv.set(env, 'qv:ustate:' + uuid, { ...st, at: Date.now() }, 300), null);
    return true;
  };
  /** cut one account now: RAM cache, KV snapshot and D1 in one step */
  const baseSetKill = D.Users.setKill;
  D.Users.setKill = async (env, uuid, on = true, reason = 'operator') => {
    const r = await baseSetKill(env, uuid, on, reason);
    /* a cut or a revive must be effective at once in every isolate */
    await D.Users.forget(env, uuid, { force: true });
    return r;
  };

  /* ═══ 8c. DEFERRED METER FLUSH — never a D1 write per packet ════════════
   * Bytes are summed in isolate RAM; the aggregate is written with a single
   * batched statement set on session close, on a size threshold and on the
   * cron tick.  The map itself is bounded.                                */
  const METERS = new Map();          // uuid -> { up, down, sid, at }
  const METER_MAX = 2000;
  const METER_FLUSH_BYTES = 512 * 1024;

  const meterAdd = (env, uuid, up, down, sid, ctx) => {
    if (!uuid) return { queued: false };
    const e = METERS.get(uuid) || { up: 0, down: 0, sid: null, at: Date.now() };
    e.up += Math.max(0, up | 0); e.down += Math.max(0, down | 0);
    if (sid) e.sid = sid;
    e.at = Date.now();
    METERS.set(uuid, e);
    if (METERS.size > METER_MAX) {
      const first = METERS.keys().next().value;
      if (first !== undefined && first !== uuid) METERS.delete(first);
    }
    /* the state cache must see the traffic even before it is durable */
    const st = STATE_CACHE.get(uuid);
    if (st) STATE_CACHE.set(uuid, { ...st, used_bytes: (st.used_bytes || 0) + Math.max(0, up | 0) + Math.max(0, down | 0) });
    if (e.up + e.down >= METER_FLUSH_BYTES) return { queued: true, flush: D.Sessions.flushMeters(env, ctx) };
    return { queued: true };
  };

  D.Sessions.pendingFor = (uuid) => { const e = METERS.get(uuid); return e ? { up: e.up, down: e.down } : null; };
  D.Sessions.meterDeferred = meterAdd;

  /* one flush per account per couple of seconds is plenty: a client that
     reconnects in a loop cannot turn metering into a write storm */
  const FLUSH_GUARD = QV.cache('meterGuard', { max: 5000, maxBytes: 256 * 1024, ttl: 5000 });

  D.Sessions.flushMeters = async (env, ctx, opts = {}) => {
    const only = opts.uuid || null;
    if (only && !opts.force && FLUSH_GUARD.get(only)) return { flushed: 0, skipped: 'recent' };
    const take = only ? 1 : Math.min(METERS.size, opts.limit || 200);
    if (!take) return { flushed: 0, bytes: 0 };
    const items = [];
    if (only) { const e = METERS.get(only); if (e) items.push([only, e]); }
    else for (const [uuid, e] of METERS) { if (items.length >= take) break; items.push([uuid, e]); }
    if (!items.length) return { flushed: 0, bytes: 0 };
    for (const [uuid] of items) METERS.delete(uuid);
    for (const [uuid] of items) FLUSH_GUARD.set(uuid, 1, 5000);
    const db = D.db(env);
    if (!db) {                                   /* no database: keep the numbers */
      for (const [uuid, e] of items) { const prev = METERS.get(uuid); if (prev) { prev.up += e.up; prev.down += e.down; } else METERS.set(uuid, e); }
      return { flushed: 0, requeued: items.length };
    }
    const now = Math.floor(Date.now() / 1000);
    const stmts = items.map(([uuid, e]) => db.prepare(
      `UPDATE qv_users SET used_bytes = used_bytes + ?, up_bytes = up_bytes + ?, down_bytes = down_bytes + ?,
        last_seen = ?, updated_at = ? WHERE uuid = ?`)
      .bind(e.up + e.down, e.up, e.down, now, now, uuid));
    const okW = await QV.safeAsync(() => db.batch(stmts), null);
    if (!okW) { for (const [uuid, e] of items) { const prev = METERS.get(uuid); if (prev) { prev.up += e.up; prev.down += e.down; } else METERS.set(uuid, e); } return { flushed: 0, error: 'batch failed' }; }
    /* per-session counters, same batched round trip */
    const sess = new Map();
    for (const [uuid, e] of items) if (e.sid) { const p = sess.get(e.sid) || { up: 0, down: 0 }; p.up += e.up; p.down += e.down; sess.set(e.sid, p); }
    if (sess.size) await QV.safeAsync(() => db.batch([...sess].map(([sid, p]) => db.prepare(
      `UPDATE qv_sessions SET bytes_up = bytes_up + ?, bytes_down = bytes_down + ?, last_alive = ? WHERE id = ?`)
      .bind(p.up, p.down, now, sid))), null);
    /* keep the cross-region snapshot fresh for the accounts that moved */
    for (const [uuid] of items) {
      if (STATE_CACHE.get(uuid)) await QV.safeAsync(() => D.Users.snapshot(env, uuid), null);
    }
    const bytes = items.reduce((a, [, e]) => a + e.up + e.down, 0);
    QV.metrics.count('metered_bytes', bytes);
    const recheck = (await D.all(env, `SELECT uuid, used_bytes, total_bytes, killswitch FROM qv_users
      WHERE uuid IN (${items.map(() => '?').join(',')})`, ...items.map(([u]) => u))) || [];
    const cut = [];
    for (const row of recheck) {
      if (row.total_bytes > 0 && row.used_bytes >= row.total_bytes && !row.killswitch) {
        STATE_CACHE.delete(row.uuid);
        await QV.safeAsync(() => D.Users.setKill(env, row.uuid, true, 'quota'), null);
        cut.push(row.uuid);
        QV.emit(env, 'quota:cut', 'warn', { uuid: row.uuid, ctx, message: 'quota exhausted — configs cut', meta: { used: row.used_bytes, total: row.total_bytes } });
      }
    }
    if (ctx?.waitUntil) ctx.waitUntil(Promise.resolve(true));
    return { flushed: items.length, bytes, cut };
  };
  D.Sessions.meterQueue = () => METERS.size;

  /* ═══ 8d. TASK LOCKS (D1, TTL) — one runner per job, per window ═════════
   * KV is explicitly not used for locks: an eventually consistent store can
   * hand the same lock to two isolates.  A conditional UPDATE is atomic.  */
  D.Jobs = {
    async ensure(env) {
      await QV.safeAsync(() => D.run(env, `CREATE TABLE IF NOT EXISTS qv_jobs (
        id TEXT PRIMARY KEY, until INTEGER DEFAULT 0, started_at INTEGER DEFAULT 0,
        runs INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, last_ms INTEGER DEFAULT 0, last_at INTEGER DEFAULT 0)`), null);
    },
    async claim(env, id, ttlSec = 120) {
      const now = Math.floor(Date.now() / 1000);
      await QV.safeAsync(() => D.run(env, `INSERT INTO qv_jobs (id, until, runs, started_at) VALUES (?, 0, 0, 0) ON CONFLICT(id) DO NOTHING`, id), null);
      const r = await QV.safeAsync(() => D.run(env, `UPDATE qv_jobs SET until = ?, started_at = ?, runs = runs + 1 WHERE id = ? AND until <= ?`, now + ttlSec, now, id, now), null);
      const changed = r ? (r.meta?.changes ?? r.changes ?? 0) : 0;
      if (changed > 0) { try { QV.count('job_claim'); } catch (e) {} return true; }
      QV.count('job_skip');
      return false;
    },
    async release(env, id, ms = 0, error = null) {
      await QV.safeAsync(() => D.run(env, `UPDATE qv_jobs SET until = 0, last_ms = ?, last_at = ?, errors = errors + ? WHERE id = ?`,
        ms | 0, Math.floor(Date.now() / 1000), error ? 1 : 0, id), null);
    },
    async list(env) { return (await D.all(env, `SELECT * FROM qv_jobs ORDER BY id`)) || []; },
    async gc(env, olderThanSec = 86400) {
      await QV.safeAsync(() => D.run(env, `DELETE FROM qv_jobs WHERE last_at < ? AND until <= ?`,
        Math.floor(Date.now() / 1000) - olderThanSec, Math.floor(Date.now() / 1000)), null);
      return { ok: true };
    },
  };

  /* ---- 9. Events / Audit ---------------------------------------------- */
  D.Events = {
    log: (env, e = {}) => {
      const sev = e.level || e.severity || 'info';
      if (sev === 'warn') QV.log.warn('event', e.kind || '', { message: e.message });
      else if (sev === 'error') QV.log.error('event', e.kind || '', { message: e.message });
      return D.run(env, 'INSERT INTO qv_events (kind,severity,uuid,ip,country,message,meta) VALUES (?,?,?,?,?,?,?)',
        e.kind || 'generic', sev, e.uuid ?? null, e.ip ?? null, e.country ?? null, e.message ?? null, JSON.stringify(e.meta || {})).catch(() => {});
    },
    recent: (env, limit = 50, kind = null) => kind
      ? D.all(env, 'SELECT * FROM qv_events WHERE kind LIKE ? ORDER BY ts DESC LIMIT ?', `%${kind}%`, limit)
      : D.all(env, 'SELECT * FROM qv_events ORDER BY ts DESC LIMIT ?', limit),
    gc: (env, days = 7) => D.run(env, 'DELETE FROM qv_events WHERE ts < unixepoch() - ?', days * DAY),
    stats: (env) => D.all(env, `SELECT kind, COUNT(*) c FROM qv_events WHERE ts > unixepoch() - 86400 GROUP BY kind ORDER BY c DESC LIMIT 20`),
  };

  D.Audit = {
    log: (env, a = {}) => D.run(env, 'INSERT INTO qv_audit (actor,action,target,detail,ip) VALUES (?,?,?,?,?)',
      a.actor || 'system', a.action || 'unknown', a.target ?? null, JSON.stringify(a.meta || a.detail || {}), a.ip ?? null).catch(() => {}),
    recent: (env, limit = 100) => D.all(env, 'SELECT * FROM qv_audit ORDER BY ts DESC LIMIT ?', limit),
    gc: (env, days = 30) => D.run(env, 'DELETE FROM qv_audit WHERE ts < unixepoch() - ?', days * DAY),
  };

  /* ---- 10. full export (backup) ---------------------------------------- */
  D.exportAll = async (env) => {
    const tables = ['qv_users', 'qv_configs', 'qv_sessions', 'qv_sni_pool', 'qv_ip_pool', 'qv_kv', 'qv_metrics'];
    const out = { version: QV.VERSION, iso: new Date().toISOString(), tables: {}, stats: {} };
    for (const t of tables) {
      const rows = await D.all(env, `SELECT * FROM ${t} LIMIT 5000`);
      out.tables[t] = rows;
      out.stats[t] = rows.length;
    }
    out.stats.users = out.tables.qv_users.length;
    out.stats.configs = out.tables.qv_configs.length;
    return out;
  };

  D.importAll = async (env, dump) => {
    if (!dump?.tables) return { ok: false, reason: 'bad dump' };
    let n = 0;
    for (const u of dump.tables.qv_users || []) {
      await D.run(env, `INSERT INTO qv_users (uuid,email,tag,protocol,plan,enabled,killswitch,total_bytes,used_bytes,max_sessions,ip_limit,expires_at,note)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uuid) DO NOTHING`,
        u.uuid, u.email, u.tag, u.protocol, u.plan, u.enabled, u.killswitch, u.total_bytes, u.used_bytes, u.max_sessions, u.ip_limit, u.expires_at, u.note);
      n++;
    }
    return { ok: true, imported: n };
  };
})();
