/* ═══════════════════════════════════════════════════════════════════════════
 * A4 · JSON API — everything the console, the bot and scripts talk to
 * ═══════════════════════════════════════════════════════════════════════════
 *  Auth ladder (all three accepted at once, so no client breaks):
 *    1. `x-api-token` / `Authorization: Bearer`  — the API_SECRET_TOKEN secret
 *    2. admin session cookie `qv_sid`            — set by POST /api/login
 *    3. per-user JWT                             — issued to users, scoped
 *  Admin routes are gated by role; user routes are scoped to their own uuid,
 *  so one account can never read another's traffic or configs.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function api() {
  const ok = (data, extra = {}) => new Response(JSON.stringify({ ok: true, data, ts: Date.now(), ...extra }), {
    status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  const fail = (error, status = 400, extra = {}) => new Response(JSON.stringify({ ok: false, error, ...extra }), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  const body = async (req) => { try { return await req.json(); } catch (e) { return {}; } };
  const cookieGet = (req, name) => {
    const raw = req.headers.get('cookie') || '';
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
  };

  /* ───────────────────────────── authorisation ─────────────────────────── */
  const auth = async (c, opts = {}) => {
    const cfg = await QV.env.prepare(c.env, c.ctx);
    const allow = opts.allow || 'admin';
    const deny = (why) => ({ ok: false, role: 'anon', reason: why });
    const token = c.token || cookieGet(c.request, 'qv_sid') || '';

    /* 1 · static api token (rotatable secret) */
    const apiToken = cfg.apiToken || QV.env.get(c.env, 'API_SECRET_TOKEN', '');
    if (token && apiToken && QV.bytesEqual(QV.utf8(token), QV.utf8(apiToken))) {
      return { ok: true, role: 'admin', via: 'api-token', env: c.env };
    }
    /* 1b · optional Cloudflare Access JWT (if the operator put Access in front) */
    if (c.request.headers.get('cf-access-jwt-assertion') && cfg.trustAccess) {
      return { ok: true, role: 'admin', via: 'cf-access' };
    }
    /* 2 · admin session cookie */
    if (token) {
      const sid = await QV.d1.Sessions.admin(env0(c), token);
      if (sid) return { ok: true, role: sid.role || 'admin', via: 'session', sid: token };
    }
    /* 3 · user JWT (uuid + exp), signed with the JWT secret */
    if (token && cfg.jwtSecret) {
      const claims = await QV.jwtVerify(token, cfg.jwtSecret).catch(() => null);
      if (claims && (claims.role === 'user' || claims.uuid)) {
        const user = await QV.d1.Users.get(env0(c), claims.uuid || claims.sub);
        if (user && user.enabled && !user.killswitch) return { ok: true, role: 'user', via: 'jwt', user };
      }
    }
    if (allow === 'any') return deny('anonymous');
    return deny('unauthorised');
  };
  const env0 = (c) => c.env;

  const login = async (c) => {
    const cfg = await QV.env.prepare(c.env, c.ctx);
    const b = await body(c.request);
    const pw = String(b.password || b.token || '');
    const expected = cfg.adminPassword || QV.env.get(c.env, 'ADMIN_PASSWORD', '');
    const ip = c.ip || '0.0.0.0';
    const bucket = QV.tokenBucket('login:' + ip, 12, 4);
    if (!bucket.take()) {
      QV.emit(c.env, 'auth:throttle', 'warn', { message: `login throttled for ${ip}`, ctx: c.ctx });
      return fail('too many attempts, slow down', 429, { retryAfter: 60 });
    }
    if (!expected) return fail('ADMIN_PASSWORD secret is not configured', 500);
    if (!pw || !QV.bytesEqual(QV.utf8(pw), QV.utf8(expected))) {
      QV.emit(c.env, 'auth:fail', 'warn', { message: `bad admin password from ${ip}`, ctx: c.ctx });
      return fail('invalid credentials', 401);
    }
    const sid = QV.uuid();
    await QV.d1.Sessions.adminCreate(c.env, { sid, ip, ua: c.request.headers.get('user-agent') || '', role: 'admin', ttl: 86400 });
    const res = ok({ token: sid, role: 'admin', expires_in: 86400 });
    res.headers.append('set-cookie', `qv_sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
    QV.emit(c.env, 'auth:ok', 'info', { message: `admin signed in from ${ip}`, ctx: c.ctx });
    return res;
  };

  /* ───────────────────────────── dispatch ─────────────────────────────── */
  const handle = async (c) => {
    const path = c.url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
    const seg = path ? path.split('/') : [];
    const method = c.request.method.toUpperCase();
    const cfg = await QV.env.prepare(c.env, c.ctx);

    if (seg[0] === 'login') return method === 'POST' ? login(c) : fail('POST only', 405);
    if (seg[0] === 'logout') {
      const sid = c.token || cookieGet(c.request, 'qv_sid');
      if (sid) await QV.d1.Sessions.adminDestroy(c.env, sid);
      const res = ok({ loggedOut: true });
      res.headers.append('set-cookie', 'qv_sid=; Path=/; Max-Age=0');
      return res;
    }
    /* public, side-effect-free endpoints (latency + fragment hints) */
    if (seg[0] === 'public') {
      if (seg[1] === 'latency') return ok({ server_ts: Date.now(), colo: c.request.cf?.colo || null, country: c.country });
      if (seg[1] === 'fragment') return ok(QV.antidpi.frag(c.env, c.url.searchParams.get('asn'), c.country));
      if (seg[1] === 'clean-ip') {
        const quick = c.url.searchParams.get('quick') === '1';
        return ok({ ips: quick ? await QV.d1.Ip.top(c.env, 8) : await QV.antidpi.scanCleanIPs(c.env, c.ctx, { limit: 8 }) });
      }
      if (seg[1] === 'dns') {
        const name = c.url.searchParams.get('name') || 'cloudflare.com';
        return ok(await QV.dns.jsonQuery(c.env, c.ctx, name, (c.url.searchParams.get('type') || 'A').toUpperCase()));
      }
      if (seg[1] === 'probe') {
        const t0 = Date.now();
        const rs = await QV.safeAsync(() => QV.fetchWithRetry(cfg.doh[0], {
          method: 'POST', headers: { 'content-type': 'application/dns-message' },
          body: QV.dns.build({ id: QV.rand16(), questions: [{ name: 'example.com', type: 1 }] }),
        }, { retries: 0, timeoutMs: 4000 }), null);
        return ok({ egress: !!rs, ms: Date.now() - t0, reachable: !!rs && rs.ok, status: rs ? rs.status : 0 });
      }
    }

    /* ── usage ingestion ─────────────────────────────────────────────────
     * The tunnel path meters its own bytes, but an edge node, a client or an
     * external collector can also report usage here.  The account's counters,
     * its live sessions and — when the quota is exhausted — its configs are
     * updated in one step, so a cut-off happens the moment the limit is hit. */
    if (seg[0] === 'meter') {
      if (method !== 'POST') return fail('POST only', 405);
      const who0 = await auth(c, { allow: 'any' });
      if (!who0.ok) return fail('unauthorised', 401);
      const b = await body(c.request);
      const target = b.uuid || b.user || who0.user?.uuid;
      if (!target) return fail('uuid required', 400);
      if (who0.role !== 'admin' && who0.user?.uuid !== target) return fail('not your account', 403);
      const up = Math.max(0, Math.round(Number(b.up ?? b.up_bytes ?? 0)));
      const down = Math.max(0, Math.round(Number(b.down ?? b.down_bytes ?? 0)));
      const res = await QV.d1.Sessions.meter(c.env, target, up, down, b.session_id || null);
      const fresh = await QV.d1.Users.get(c.env, target);
      const quota = fresh ? (fresh.total_bytes || fresh.quota_bytes || 0) : 0;
      const over = !!fresh && quota > 0 && fresh.used_bytes >= quota && !fresh.killswitch;
      if (over) await QV.d1.Users.setKill(c.env, target, true, 'quota');
      QV.emit(c.env, over ? 'quota:cut' : 'usage', over ? 'warn' : 'debug', {
        uuid: target, ctx: c.ctx, message: over ? 'quota exhausted — configs cut' : 'usage reported',
        meta: { up, down, used: fresh && fresh.used_bytes, total: quota },
      });
      return ok({ ...res, item: sanitizeUser(await QV.d1.Users.get(c.env, target)), cut: over });
    }

    /* everything below needs a session */
    const who = await auth(c, { allow: 'any' });
    if (!who.ok) return fail('unauthorised', 401);
    const isAdmin = who.role === 'admin';
    const needAdmin = () => (isAdmin ? null : fail('admin only', 403));

    switch (seg[0]) {
      /* ── identity ────────────────────────────────────────────────────── */
      case 'me': {
        if (isAdmin) return ok({ role: 'admin', via: who.via, version: QV.VERSION, features: Object.keys(cfg.features || {}).filter(k => cfg.features[k]) });
        return ok({ role: 'user', user: sanitizeUser(who.user), token: '' });
      }
      case undefined: return ok({ api: true, version: QV.VERSION, routes: ['login','logout','me','stats','users','sessions','strategy','sni','ips','endpoints','dns','ai','events','cron','jobs','cache','ss','shape','selftest','backup','hosts','sub','tg'] });

      /* ── dashboard ───────────────────────────────────────────────────── */
      case 'stats': {
        const g = needAdmin(); if (g) return g;
        return ok(await stats(c.env));
      }

      /* ── users ───────────────────────────────────────────────────────── */
      case 'users': {
        const id = seg[1];
        if (!isAdmin) {
          if (!id || id !== who.user.uuid) return fail('forbidden', 403);
          return ok({ item: sanitizeUser(who.user) });
        }
        if (!id) {
          if (method === 'GET') {
            const items = await QV.d1.all(c.env, `SELECT * FROM qv_users ORDER BY created_at DESC LIMIT 500`);
            return ok({ items: (items || []).map(sanitizeUser) });
          }
          if (method === 'POST') {
            const b = await body(c.request);
            const uuid = b.uuid && QV.isUuid(b.uuid) ? b.uuid : QV.uuid();
            const item = {
              uuid, tag: String(b.name || 'user-' + uuid.slice(0, 6)).slice(0, 64),
              total_bytes: Math.round(Number(b.quota_bytes ?? (Number(b.quota_gb || 100) * 1073741824)) || 0),
              expires_at: b.expires_at ? Math.floor(Number(b.expires_at)) : (b.days ? Math.floor(Date.now() / 1000) + Number(b.days) * 86400 : 0),
              max_sessions: Number(b.max_sessions ?? 3), telegram_id: b.telegram_id || null, enabled: 1,
            };
            await QV.d1.Users.upsert(c.env, item);
            if (b.note) await QV.d1.Kv.set(c.env, 'qv:note:' + uuid, String(b.note).slice(0, 500), 0);
            QV.emit(c.env, 'user:create', 'info', { uuid, message: `user ${item.name} created`, ctx: c.ctx });
            return ok({ item: sanitizeUser(await QV.d1.Users.get(c.env, uuid)), sub: `/sub/${uuid}` });
          }
          return fail('method not allowed', 405);
        }
        /* /api/users/:uuid */
        const user = await QV.d1.Users.get(c.env, id);
        if (!user) return fail('not found', 404);
        if (method === 'GET') return ok({ item: sanitizeUser(user), note: await QV.d1.Kv.get(c.env, 'qv:note:' + id, '') });
        if (method === 'PATCH' || method === 'PUT') {
          const b = await body(c.request);
          const patch = {};
          for (const k of ['tag', 'note', 'email', 'plan', 'expires_at', 'max_sessions', 'enabled', 'killswitch', 'used_bytes', 'ip_limit']) {
            if (b[k] !== undefined) patch[k] = typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k];
          }
          if (b.name !== undefined) patch.tag = String(b.name).slice(0, 64);
          const qb = b.quota_bytes ?? (b.quota_gb !== undefined ? Number(b.quota_gb) * 1073741824 : undefined);
          if (qb !== undefined) patch.total_bytes = Math.round(Number(qb));
          if (b.days !== undefined) patch.expires_at = Math.floor(Date.now() / 1000) + Number(b.days) * 86400;
          if (b.reset_usage) patch.used_bytes = 0;
          if (b.used_bytes !== undefined) patch.used_bytes = Math.max(0, Math.round(Number(b.used_bytes) || 0));
          if (b.up_bytes !== undefined) patch.up_bytes = Math.max(0, Math.round(Number(b.up_bytes) || 0));
          if (b.down_bytes !== undefined) patch.down_bytes = Math.max(0, Math.round(Number(b.down_bytes) || 0));
          if (b.revive) await QV.d1.Kv.set(c.env, 'qv:revive:' + id, true, 86400 * 7);
          if (b.killswitch === 0 || b.killswitch === false) await QV.d1.Kv.set(c.env, 'qv:revive:' + id, true, 86400 * 7);
          const kill = patch.killswitch;
          delete patch.killswitch;
          if (Object.keys(patch).length) await QV.d1.Users.patch(c.env, id, patch);
          if (kill !== undefined) await QV.d1.Users.setKill(c.env, id, !!kill, 'operator');
          const fresh = await QV.d1.Users.get(c.env, id);
          QV.syncUsers(c.env).catch(() => {});
          QV.emit(c.env, 'user:update', 'info', { uuid: id, message: 'fields: ' + Object.keys(patch).join(','), ctx: c.ctx });
          return ok({ item: sanitizeUser(fresh) });
        }
        if (method === 'DELETE') {
          await QV.d1.Users.remove(c.env, id);
          await QV.d1.Sessions.closeAll(c.env, id, 'deleted');
          QV.syncUsers(c.env).catch(() => {});
          QV.emit(c.env, 'user:delete', 'warn', { uuid: id, message: 'account removed', ctx: c.ctx });
          return ok({ deleted: true, uuid: id });
        }
        return fail('method not allowed', 405);
      }

      /* ── sessions ────────────────────────────────────────────────────── */
      case 'sessions': {
        const g = needAdmin(); if (g) return g;
        if (!seg[1]) return ok({ items: await QV.d1.all(c.env, `SELECT * FROM qv_sessions WHERE closed = 0 ORDER BY last_alive DESC LIMIT 300`) });
        if (method === 'DELETE') { await QV.d1.Sessions.close(c.env, seg[1], 'operator', 0, 0); return ok({ kicked: seg[1] }); }
        return fail('method not allowed', 405);
      }

      /* ── anti-DPI ────────────────────────────────────────────────────── */
      case 'strategy': {
        if (method === 'GET') return ok(await QV.antidpi.overview(c.env));
        const g = needAdmin(); if (g) return g;
        if (method === 'POST') {
          const b = await body(c.request);
          const next = await QV.antidpi.save(c.env, b);
          QV.emit(c.env, 'strategy:update', 'info', { message: 'via API', ctx: c.ctx, meta: b });
          return ok(next);
        }
        return fail('method not allowed', 405);
      }
      case 'sni': {
        if (method === 'GET') return ok({ items: await QV.d1.Sni.top(c.env, 200), pool_size: (await QV.d1.Sni.top(c.env, 1000)).length });
        const g = needAdmin(); if (g) return g;
        const b = await body(c.request);
        const action = b.action || c.url.searchParams.get('action') || 'hunt';
        if (action === 'hunt') { const found = await QV.antidpi.hunt(c.env, c.ctx, { count: b.count || 8 }); return ok({ found: found.length, items: found }); }
        if (action === 'health') { const r = await QV.antidpi.checkSNIHealth(c.env, c.ctx, { limit: b.limit || 15 }); return ok(r); }
        if (action === 'add') { await QV.d1.Sni.upsert(c.env, { sni: String(b.sni || ''), score: 10 }); return ok({ added: b.sni }); }
        if (action === 'delete') { await QV.d1.Sni.remove(c.env, String(b.sni || '')); return ok({ deleted: b.sni }); }
        return fail('unknown action', 400);
      }
      case 'ips': {
        /* the ranked view the engine measured; the historic pool is the tail */
        const asn = c.url.searchParams.get('asn') || (c.request.cf?.asn ? String(c.request.cf.asn) : null);
        if (method === 'GET') {
          const prefer = c.url.searchParams.get('prefer') || 'auto';
          const picked = await QV.cleanip.pick(c.env, { asn, n: 12, uuid: who.user?.uuid, prefer });
          return ok({
            items: [...picked.v4, ...picked.v6].map(r => ({
              ip: r.ip, family: r.family || 'v4', score: r.score, samples: r.samples, state: r.state,
              rtt_ms: r.rtt_ms, tls_ok: r.tls_ok, ws_ok: r.ws_ok, asn: r.asn, scope: r.scope,
            })),
            nat64: picked.nat64, asn, rows: picked.rows, prefer: picked.prefer, dual: picked.dual,
            preferred: picked.preferred.map(r => ({ ip: r.ip, family: r.family || 'v4', nat64: !!r.nat64, score: r.score })),
            note: 'scores come from browser measurements on the subscribers networks, not from the edge',
          });
        }
        const g = needAdmin(); if (g) return g;
        const b = await body(c.request);
        const action = b.action || 'scan';
        if (action === 'scan') {
          const planRes = await QV.cleanip.plan(c.env, c.ctx, { count: b.limit || 12 });
          const edge = await QV.cleanip.edgeProbe(c.env, c.ctx, planRes.list.map(x => x.ip), { limit: b.limit || 12 });
          return ok({ found: edge.filter(r => r.tcp).length, items: edge, view: 'edge', note: 'edge reachability only; subscriber reports drive the ranking' });
        }
        if (action === 'add') { await QV.d1.Ip.upsert(c.env, { ip: b.ip, score: 10, latency_ms: b.latency_ms || 0 }); return ok({ added: b.ip }); }
        if (action === 'audit') return ok(await QV.cleanip.audit(c.env, c.ctx));
        if (action === 'flush') return ok(await QV.cleanip.flushReports(c.env, c.ctx, { limit: 300 }));
        if (action === 'label') return ok(await QV.cleanip.label(c.env, c.ctx));
        if (action === 'blocks') {
          /* the verdict runs first so the snapshot reflects this pass */
          const verdict = await QV.cleanip.detectBlocks(c.env, c.ctx);
          return ok({ verdict, blocks: QV.cleanip.blockSnapshot(), limits: QV.cleanip.BLOCK });
        }
        if (action === 'evaluate') return ok(await QV.antidpi.evaluateStrategy(c.env, c.ctx, { force: true }));
        if (action === 'feedback') return ok(await QV.cleanip.feedback(c.env, b.uuid || who.user?.uuid, b.host || b.ip, b.ok !== false, b.asn, b.ep || null, { weight: 1, provider: 'operator', trusted: true }));
        return fail('unknown action', 400);
      }
      /* the engine's full picture, for the panel and for a scripted check */
      case 'endpoints': {
        const g = needAdmin(); if (g) return g;
        if (method === 'POST') {
          const b = await body(c.request);
          if (b.refresh) return ok(await QV.cleanip.ranges(c.env, c.ctx, { refresh: true }));
          if (b.aggregate) return ok(await QV.cleanip.aggregate(c.env, c.ctx));
          if (b.refill) return ok(await QV.cleanip.refill(c.env, c.ctx));
          return fail('nothing to do', 400);
        }
        return ok(await QV.cleanip.audit(c.env, c.ctx));
      }

      /* ── DNS ─────────────────────────────────────────────────────────── */
      case 'dns': {
        if (method === 'GET') return ok(await QV.dns.stats(c.env));
        const b = await body(c.request);
        if (b.name) {
          const r = await QV.dns.jsonQuery(c.env, c.ctx, b.name, (b.type || 'A').toUpperCase(), !!b.dns64);
          return r.ok === false ? fail(r.error || 'resolution failed', 502, r) : ok(r);
        }
        const g = needAdmin(); if (g) return g;
        if (b.action === 'flush') { const n = await QV.dns.flush(c.env); return ok({ flushed: n }); }
        if (b.action === 'warm') return ok({ warmed: await QV.dns.warm(c.env, c.ctx, b.names || []) });
        return fail('unknown action', 400);
      }

      /* ── AI ──────────────────────────────────────────────────────────── */
      case 'ai': {
        if (method === 'GET') {
          const hist = await QV.d1.Kv.get(c.env, 'qv:ai:history', []);
          return ok({
            active_model: QV.ai.bestModel(c.env, 'chat'),
            available_models: QV.ai.catalog().length,
            remote_models: (await QV.d1.Kv.get(c.env, 'qv:ai:remote', [])).length,
            health: await QV.d1.Kv.get(c.env, 'qv:ai:health', {}),
            ranking: QV.ai.byKind('chat', 8).map(m => ({ id: m.id, score: Math.round(m.score) })),
            history: hist.slice(-14),
          });
        }
        const b = await body(c.request);
        const action = b.action || 'chat';
        if (action === 'chat') {
          const g = needAdmin(); if (g) return g;
          const answer = await QV.ai.chat(c.env, [{ role: 'system', content: QV.ai.systemPrompt(c.env) }, { role: 'user', content: String(b.prompt || '').slice(0, 4000) }], { ctx: c.ctx });
          const hist = ((await QV.d1.Kv.get(c.env, 'qv:ai:history', [])) || []).slice(-13);
          hist.push({ role: 'user', content: String(b.prompt || '').slice(0, 500), ts: Date.now() });
          hist.push({ role: 'assistant', content: String(answer).slice(0, 800), ts: Date.now() });
          await QV.d1.Kv.set(c.env, 'qv:ai:history', hist, 0);
          return ok({ answer });
        }
        if (action === 'replan') { const g = needAdmin(); if (g) return g; return ok(await QV.antidpi.analyse(c.env, c.ctx, { reason: 'api' })); }
        if (action === 'translate') return ok({ text: await QV.ai.translate(c.env, String(b.text || ''), b.to || 'fa', b.from || 'auto') });
        if (action === 'summarise') { const g = needAdmin(); if (g) return g; return ok({ summary: await QV.ai.summarise(c.env, JSON.stringify(b.data || {}).slice(0, 6000)) }); }
        if (action === 'classify') { const g = needAdmin(); if (g) return g; return ok(await QV.ai.classifyText(c.env, String(b.text || ''), b.labels || [])); }
        return fail('unknown action', 400);
      }

      /* ── ops ─────────────────────────────────────────────────────────── */
      case 'events': {
        const g = needAdmin(); if (g) return g;
        const limit = Math.min(500, Number(c.url.searchParams.get('limit')) || 120);
        const type = c.url.searchParams.get('type');
        const items = type
          ? await QV.d1.all(c.env, `SELECT ts, kind AS type, severity AS level, ip, country, message, meta FROM qv_events WHERE kind = ? ORDER BY ts DESC LIMIT ${limit}`, type)
          : await QV.d1.all(c.env, `SELECT ts, kind AS type, severity AS level, ip, country, message, meta FROM qv_events ORDER BY ts DESC LIMIT ${limit}`);
        return ok({ items: items || [] });
      }
      case 'cron': {
        const g = needAdmin(); if (g) return g;
        if (method !== 'POST') return ok({ tasks: QV.router.CRON_TASKS.map(t => ({ id: t.id, every_sec: t.every })) });
        const b = await body(c.request);
        const only = b.only || null;
        const tasks = QV.router.CRON_TASKS.filter(t => !only || t.id === only);
        const results = {};
        await QV.safeAsync(() => QV.d1.Jobs.ensure(c.env), null);
        for (const t of tasks) {
          const t0 = Date.now();
          /* the same lock the scheduler takes: a manual run never collides with
             a cron tick that is already working on the same job */
          const locked = b.force ? true : await QV.safeAsync(() => QV.d1.Jobs.claim(c.env, t.id, Math.max(60, Math.round(t.every / 60) * 60)), true);
          if (!locked) { results[t.id] = { skipped: 'locked', ms: 0 }; continue; }
          let err = null;
          try { results[t.id] = { ms: 0, result: await QV.withTimeout(t.run(c.env, c.ctx), b.force ? 30000 : (t.budgetMs || 20000), t.id) }; }
          catch (e) { err = e; results[t.id] = { error: e?.message }; }
          results[t.id].ms = Date.now() - t0;
          await QV.safeAsync(() => QV.d1.Jobs.release(c.env, t.id, Date.now() - t0, err), null);
        }
        return ok({ ran: Object.values(results).filter(r => !r.skipped).length, results });
      }
      case 'ss': {
        const g = needAdmin(); if (g) return g;
        return ok(await QV.ss.audit(c.env));
      }
      case 'shape': {
        const g = needAdmin(); if (g) return g;
        const cur = QV.ss.shapeCfg(c.env);
        if (method === 'POST') {
          const b = await body(c.request);
          const cfg = await QV.env.prepare(c.env, c.ctx);
          const saved = (await QV.d1.Kv.get(c.env, 'qv:shape', {})) || {};
          for (const k of ['on', 'maxPiece', 'jitterMs', 'jitterFrames']) if (b[k] !== undefined) saved[k] = b[k];
          await QV.d1.Kv.set(c.env, 'qv:shape', saved, 0);
          QV.emit(c.env, 'shape:set', 'info', { message: JSON.stringify(saved), ctx: c.ctx });
          return ok({ shape: saved, env: cfg ? true : false });
        }
        return ok({ active: cur, note: 'env QV_SHAPE / QV_SHAPE_PIECE / QV_SHAPE_JITTER override the stored value' });
      }
      case 'jobs': {
        const g = needAdmin(); if (g) return g;
        await QV.safeAsync(() => QV.d1.Jobs.ensure(c.env), null);
        if (method === 'POST') {
          const b = await body(c.request);
          /* every scheduled job is inspectable and testable from here: run the
             whole sweep, one job, take/release its lock, or just read the
             ledger.  Same code path as the scheduler, same locks. */
          if (b.run === 'all' || b.all) return ok(await QV.router.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, c.env, { waitUntil: () => {} }));
          if (b.claim) {
            const got = await QV.d1.Jobs.claim(c.env, String(b.claim), Number(b.ttl || 120));
            return ok({ id: String(b.claim), claimed: got, held_until: got ? Math.floor(Date.now() / 1000) + Number(b.ttl || 120) : 0 });
          }
          if (b.release) { await QV.d1.Jobs.release(c.env, String(b.release), 0, null); return ok({ id: String(b.release), released: true }); }
          if (b.gc) return ok(await QV.d1.Jobs.gc(c.env));
          return fail('nothing to do: pass run / claim / release / gc', 400);
        }
        return ok({ items: await QV.d1.Jobs.list(c.env), queue: QV.d1.Sessions.meterQueue(), caches: QV.cacheStats(), memory: QV.memEstimate() });
      }
      case 'cache': {
        const g = needAdmin(); if (g) return g;
        if (method === 'DELETE') { QV.cacheReset(); QV.lru.clear(); return ok({ cleared: true }); }
        return ok({ items: QV.cacheStats(), memory: QV.memEstimate(), lru: QV.lru.stats() });
      }
      case 'selftest': {
        const g = needAdmin(); if (g) return g;
        return ok(await QV.selfcheck.run(c.env, { quick: c.url.searchParams.get('full') !== '1', timeoutMs: 12000 }));
      }
      case 'selftest-log': {
        const g = needAdmin(); if (g) return g;
        return ok(await QV.d1.Kv.get(c.env, 'qv:selfcheck:last', null));
      }
      case 'backup': {
        const g = needAdmin(); if (g) return g;
        if (method === 'PUT' || method === 'POST' && c.url.searchParams.get('restore')) {
          const b = await body(c.request);
          const counts = await QV.d1.importAll(c.env, b);
          QV.emit(c.env, 'backup:restore', 'warn', { message: 'restored ' + JSON.stringify(counts), ctx: c.ctx });
          return ok({ counts });
        }
        const snapshot = await QV.d1.exportAll(c.env, {});
        if (c.url.searchParams.get('download') === '1') {
          return new Response(JSON.stringify(snapshot, null, 1), {
            headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="qv-backup-${new Date().toISOString().slice(0, 10)}.json"` },
          });
        }
        return ok(snapshot);
      }
      case 'hosts': {
        const g = needAdmin(); if (g) return g;
        if (method === 'GET') return ok({ hosts: await QV.subs.hostsFor(c.env, c.ctx), ws_path: QV.env.get(c.env, 'WS_PATH', '/ws') });
        const b = await body(c.request);
        const list = (b.hosts || []).map(s => String(s).trim()).filter(Boolean);
        await QV.d1.Kv.set(c.env, 'qv:hosts', list, 0);
        return ok({ hosts: list });
      }
      case 'sub': {
        const uuid = seg[1] || (who.user && who.user.uuid);
        if (!uuid) return fail('uuid required', 400);
        if (!isAdmin && who.user && who.user.uuid !== uuid) return fail('forbidden', 403);
        const b = method === 'POST' ? await body(c.request) : {};
        const format = b.format || c.url.searchParams.get('format') || 'uris';
        const built = await QV.subs.build(c.env, c.ctx, uuid, { format, origin: c.url.origin });
        if (!built.ok) return fail(built.error, 404, built);
        if (c.url.searchParams.get('raw') === '1') {
          return new Response(built.body, { headers: { 'content-type': built.contentType, 'cache-control': 'no-store' } });
        }
        return ok({ url: built.subUrl, format, nodes: built.uris ? built.uris.length : undefined, hints: built.hints, preview: String(built.body).slice(0, 400) });
      }
      case 'tg': {
        const g = needAdmin(); if (g) return g;
        if (method === 'GET') return ok(await QV.telegram.status(c.env));
        const b = await body(c.request);
        if (b.action === 'setup') { const r = await QV.telegram.ensureWebhook(c.env, c.ctx, c.url.origin); return ok(r); }
        if (b.action === 'send') { const r = await QV.telegram.send(c.env, b.chat_id || QV.env.get(c.env, 'ADMIN_TELEGRAM_ID', ''), b.text, b.keyboard); return ok(r); }
        if (b.action === 'broadcast') { const r = await QV.telegram.broadcast(c.env, c.ctx, b.text, b.filter || {}); return ok(r); }
        if (b.action === 'unset') { await QV.telegram.deleteWebhook(c.env); return ok({ webhook: 'removed' }); }
        return fail('unknown action', 400);
      }
      /* ── the bot's state machine, observable and resettable ──────────── */
      case 'fsm': {
        const only = c.url.searchParams.get('chat');
        const rows = only
          ? await QV.d1.all(c.env, `SELECT * FROM qv_fsm WHERE chat_id = ? OR chat_id = ?`, only, 'tg:' + only)
          : await QV.d1.all(c.env, `SELECT * FROM qv_fsm ORDER BY updated_at DESC LIMIT ${Number(c.url.searchParams.get('limit')) || 50}`);
        const items = (rows || []).map(r => ({
          key: r.chat_id,
          chat_id: String(r.chat_id || '').replace(/^tg:/, ''),
          state: r.state, role: r.role, updated_at: r.updated_at, ttl: r.ttl,
          data: QV.json.parse(typeof r.payload === 'string' ? r.payload : '{}', {}),
        }));
        if (method === 'DELETE') {
          if (!only) return fail('chat required', 400);
          await QV.d1.Fsm.clear(c.env, only);
          return ok({ cleared: only });
        }
        return ok({ items, count: items.length });
      }
      case 'audit': {
        const g = needAdmin(); if (g) return g;
        return ok({ items: await QV.d1.all(c.env, `SELECT * FROM qv_audit ORDER BY ts DESC LIMIT 200`) || [] });
      }
      case 'metrics': {
        const g = needAdmin(); if (g) return g;
        return ok(await QV.metrics.snapshot(c.env));
      }
      default: return fail('no such endpoint: ' + path, 404);
    }
  };

  /* ─────────────────────────── helpers ────────────────────────────────── */
  const sanitizeUser = (u) => u && ({
    uuid: u.uuid, name: u.name, enabled: !!u.enabled, killswitch: !!u.killswitch,
    quota_bytes: u.total_bytes || 0, used_bytes: u.used_bytes || 0,
    usage_pct: u.total_bytes ? Math.min(100, Math.round((u.used_bytes / u.total_bytes) * 100)) : null,
    total_bytes: u.total_bytes || 0, up_bytes: u.up_bytes || 0, down_bytes: u.down_bytes || 0, note: u.note || null,
    expires_at: u.expires_at, max_sessions: u.max_sessions, telegram_id: u.telegram_id,
    created_at: u.created_at, updated_at: u.updated_at,
  });

  const stats = async (env) => {
    const one = async (sql, ...args) => (await QV.d1.one(env, sql, ...args)) || {};
    const users = await one(`SELECT COUNT(*) AS total, SUM(enabled = 1) AS enabled, SUM(killswitch = 1) AS cut, SUM(used_bytes) AS used FROM qv_users`);
    const sessions = await one(`SELECT COUNT(*) AS total, SUM(closed = 0) AS active FROM qv_sessions`);
    const traffic = await one(`SELECT SUM(bytes_up + bytes_down) AS bytes_total FROM qv_sessions WHERE last_alive > ?`, Math.floor(Date.now() / 1000) - 86400);
    const totalUsed = await one(`SELECT SUM(used_bytes) AS bytes_total FROM qv_users`);
    const cfg = await QV.env.prepare(env, null);
    return {
      users_total: users.total || 0, users_enabled: users.enabled || 0, users_cut: users.cut || 0,
      sessions_total: sessions.total || 0, sessions_active: sessions.active || 0,
      bytes_24h: traffic.bytes_total || 0, bytes_total: totalUsed.bytes_total || 0,
      sni_count: (await QV.d1.one(env, `SELECT COUNT(*) AS n FROM qv_sni_pool`) || { n: 0 }).n || 0,
      ip_count: (await QV.d1.one(env, `SELECT COUNT(*) AS n FROM qv_ip_pool`) || { n: 0 }).n || 0,
      strategy: await QV.antidpi.overview(env),
      health: { d1: !!cfg.d1, kv: !!cfg.kv, ai: !!cfg.ai, telegram: !!cfg.telegram, r2: !!cfg.r2, queue: cfg.queue.length > 0 },
      version: QV.VERSION, uptime_ms: Date.now() - (QV.bootedAt || Date.now()),
    };
  };

  QV.api = { handle, auth, login, ok, fail, body, sanitizeUser, stats, cookieGet };
})();
