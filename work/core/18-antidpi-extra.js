/* ═══════════════════════════════════════════════════════════════════════════
 * A3c · ANTI-DPI GLUE — the request gate, ban sweeping, pool maintenance
 * ═══════════════════════════════════════════════════════════════════════════
 *   gate()        one call per request: classify → tarpit / ban / allow,
 *                 with telemetry and automatic pool learning
 *   save()        persist a strategy patch edited from the API or the bot
 *   overview()    the flat status shape the console and API consume
 *   sweepBans()   release expired bans, decay counters
 *   seedSni/seedIps  thin aliases over the seeding suite
 *   noteRequest() count inbound requests per IP for the classifier
 * ═══════════════════════════════════════════════════════════════════════════ */
(function antidpiGlue() {
  const A = QV.antidpi;

  /* in-isolate request counters (cheap; the durable part lives in D1) */
  const recent = new Map();          // ip → { n, first, paths:Set }
  const MAX_TRACK = 5000;
  const noteRequest = (request, ip) => {
    const key = ip || request?.headers?.get?.('cf-connecting-ip') || '0.0.0.0';
    let rec = recent.get(key);
    if (!rec) {
      if (recent.size > MAX_TRACK) recent.clear();
      rec = { n: 0, first: Date.now(), paths: new Set() };
      recent.set(key, rec);
    }
    rec.n++;
    try { if (rec.paths.size < 24) rec.paths.add(new URL(request.url).pathname); } catch (e) {}
    return rec;
  };
  const requestStats = (ip) => recent.get(ip) || { n: 0, first: Date.now(), paths: new Set() };

  /* ─────────────────────────── the gate ────────────────────────────────── */
  const gate = async (request, env, ctx) => {
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '0.0.0.0';
    const rec = noteRequest(request, ip);
    const verdict = A.classify(request, ip);
    const policy = (env && env.__policy) || {};

    /* country policy */
    const country = request.headers.get('cf-ipcountry') || '';
    if (policy.denyCountries && policy.denyCountries.length && policy.denyCountries.includes(country)) {
      return { action: 'ban', reason: 'country-blocked', country };
    }

    /* Real clients, health checks, the console and the API all look like
       "many paths from one IP" — only *unknown* paths count as scanning, and a
       WebSocket upgrade is never treated as a probe. */
    const KNOWN = /^\/(health|livez|healthz|api|sub|qr|me|admin|panel|console|fragment|clean-ip|dns|dns-query|dns-tcp|tg|ws|ss|robots\.txt|favicon\.ico|\/?$)/;
    const unknownHits = [...rec.paths].filter(p => !KNOWN.test(p)).length;
    const burst = Date.now() - rec.first < 60000 && rec.n > 150 && unknownHits > 25;
    const scanner = burst || unknownHits > 20;
    const upgraded = (request.headers.get('upgrade') || '').toLowerCase() === 'websocket';
    const privileged = !!(request.headers.get('x-api-token') || request.headers.get('authorization') || request.headers.get('cookie'));
    if (verdict.action === 'ban' || scanner || (verdict.action === 'tarpit' && !upgraded && !privileged)) {
      const why = verdict.reason || (scanner ? 'path-burst' : 'probe');
      await A.onProbe(env, ctx, request, why);
      if ((verdict.score || 0) >= 70 || burst) {
        A.markBlocked(env, ip);
        return { action: 'ban', reason: why, score: verdict.score || 0 };
      }
      return { action: 'tarpit', reason: why, ms: (policy.probeTarpitMs || A.DEFAULT_STRATEGY.tarpit.delayMs || 1500) };
    }
    if (upgraded && (verdict.action === 'tunnel' || verdict.action === 'tarpit')) return { action: 'allow', reason: 'upgrade' };
    if (verdict.action === 'allow') {
      const ua = request.headers.get('user-agent') || '';
      if (/^(?:Go-http-client|curl|wget|python-requests|axios|okhttp)/i.test(ua) && !/upgrade/i.test(request.headers.get('upgrade') || '')) {
        return { action: 'allow', reason: 'api-client' };
      }
    }
    return verdict;
  };

  /* ─────────────────────────── tarpit helper ───────────────────────────── */
  /** the router wants (env, ctx, c, ms): the base tarpit only needs `ms` */
  const tarpitFor = async (env, ctx, c, ms) => A.tarpit(ms);

  /* ─────────────────────────── strategy editing ────────────────────────── */
  const save = async (env, patch = {}) => {
    const cur = await A.load(env);
    const next = {
      ...cur,
      ...('strict' in patch ? { strict: !!patch.strict } : {}),
      ...((patch.shape || patch.active_shape) ? { shape: String(patch.shape || patch.active_shape) } : {}),
      fragment: {
        ...(cur.fragment || {}),
        ...(patch.fragment || {}),
      },
      generation: (cur.generation || cur.version || 0) + 1,
      updated_by: patch.updated_by || 'api',
      updated_at: Date.now(),
    };
    await QV.d1.Kv.set(env, 'qv:strategy', next, 0);
    A.state.strategy = next;
    QV.emit(env, 'strategy:save', 'info', { message: 'generation ' + next.generation });
    return overview(env, next);
  };

  /* ─────────────────────────── flat status ─────────────────────────────── */
  const overview = async (env, known) => {
    const strategy = known || await A.load(env);
    const frag = typeof A.fragmentProfile === 'function' && strategy.fragment
      ? strategy.fragment
      : { mode: strategy.fragment?.mode || 'auto', size: strategy.fragment?.size || 12, interval: strategy.fragment?.interval || 8 };
    const sni = (await QV.safeAsync(() => QV.d1.one(env, `SELECT COUNT(*) AS n FROM qv_sni_pool`), null)) || { n: 0 };
    const ips = (await QV.safeAsync(() => QV.d1.one(env, `SELECT COUNT(*) AS n FROM qv_ip_pool`), null)) || { n: 0 };
    return {
      active_shape: strategy.shape || strategy.active_shape || 'ws-tls',
      shapes: A.shapes,
      strict: !!strategy.strict,
      fragment: {
        mode: frag.mode || 'auto', size: frag.size ?? 32,
        interval: frag.interval ?? frag.delayMs ?? 12, jitter: frag.jitterMs ?? 25,
        payload: frag.payload || '', client_hint: frag.client_hint || null,
      },
      carrier: strategy.carrier || null,
      generation: strategy.generation || strategy.version || 1,
      tarpit: strategy.tarpit,
      sni_count: sni.n || 0,
      ip_count: ips.n || 0,
      telemetry: A.state.telemetry,
      banned_ips: A.state.bannedIps ? A.state.bannedIps.size : 0,
      version: strategy.version || null,
      updated_at: strategy.updated_at || strategy.at || null,
      raw: strategy,
    };
  };

  /* ─────────────────────────── maintenance ─────────────────────────────── */
  const sweepBans = async (env) => {
    const before = A.state.bannedIps ? A.state.bannedIps.size : 0;
    const now = Date.now();
    if (A.state.bannedIps) for (const [ip, until] of A.state.bannedIps) if (!until || until < now) A.state.bannedIps.delete(ip);
    for (const [ip, rec] of recent) if (now - rec.first > 600000) recent.delete(ip);
    const rows = await QV.safeAsync(() => QV.d1.all(env, `SELECT ip, cooldown_until, blacklisted FROM qv_ip_pool WHERE blacklisted = 1 OR (cooldown_until IS NOT NULL AND cooldown_until < unixepoch()) LIMIT 500`), []) || [];
    let released = 0;
    for (const r of rows) {
      if (r.blacklisted === 1) { released++; await QV.safeAsync(() => QV.d1.run(env, `UPDATE qv_ip_pool SET blacklisted = 0 WHERE ip = ?`, r.ip), null); }
    }
    return { local_before: before, local_after: A.state.bannedIps ? A.state.bannedIps.size : 0, released, tracked: recent.size };
  };

  const seedSni = (env) => A.seed(env);
  const seedIps = (env) => A.seed(env);

  /* ─────────────── a full fragment profile the client can paste ────────── */
  const profileForClient = (env, asn, country) => {
    const carrier = A.activeCarrier ? A.activeCarrier(asn, country) : { key: 'generic', name: 'generic', profile: {} };
    const base = (A.state.strategy && A.state.strategy) || A.DEFAULT_STRATEGY;
    /* A.fragmentProfile(env, asn, country) knows the live strategy */
    let prof = null;
    try { prof = A.fragmentProfile(env, asn, country); } catch (e) { prof = null; }
    const frag = (prof && prof.fragment) || base.fragment || {};
    const size = frag.size ?? 32, delay = frag.delayMs ?? frag.interval ?? 12, jitter = frag.jitterMs ?? 25;
    return {
      mode: frag.mode || 'sni-split', size, interval: delay, jitter,
      mtu: (carrier.profile && carrier.profile.mtu) || 1400,
      carrier: carrier.key, carrierName: carrier.name,
      padding: (prof && prof.padding) || base.padding,
      pacing: (prof && prof.pacing) || base.pacing,
      tls: (prof && prof.tls) || base.tls,
      payload: `#frag=${frag.mode || 'sni-split'}&s=${size}&d=${delay}&j=${jitter}`,
      client_hint: (prof && prof.client_hint) || 'enable TLS fragmentation in the client (SNI split, 32-64 bytes, 10-20 ms)',
      strategy: (prof && prof.strategy) || base.shape || 'ws-tls',
    };
  };

  Object.assign(A, {
    gate, tarpitFor, save, overview, sweepBans, seedSni, seedIps,
    noteRequest, requestStats, profileForClient, recentRequests: recent,
    /* signature-stable helper used by the router / bot / API */
    frag: profileForClient,
  });
})();
