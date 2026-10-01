/* ═══════════════════════════════════════════════════════════════════════════
 * A0 · ROUTER — the single entry point for every generation in the bundle
 * ═══════════════════════════════════════════════════════════════════════════
 *  fetch()          every HTTP/WebSocket path, with a decoy fallback so the
 *                   deployment never advertises what it is
 *  scheduled()      16 cron tasks: quota sweep, SNI hunt, clean-IP scan,
 *                   AI re-plan, session GC, backups, self-healing, …
 *  queue()          batch work (broadcast, AI jobs, warm-ups)
 *
 *  Route resolution order (first match wins, all legacy handlers stay alive):
 *    1. explicit routes registered by core modules (this table)
 *    2. legacy generations, in priority order (u01 → u00 → u03 → …)
 *    3. the decoy
 * ═══════════════════════════════════════════════════════════════════════════ */
(function router() {
  const { log } = QV;

  /* ─────────────────────────── helpers ─────────────────────────────────── */
  const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
  const text = (s, status = 200, ct = 'text/plain; charset=utf-8') => new Response(s, { status, headers: { 'content-type': ct } });
  const notFound = () => json({ ok: false, error: 'not found' }, 404);

  /** resolve something a legacy unit exported (lazy: units exist at runtime) */
  const U = (name) => {
    try {
      if (typeof globalThis.__QF !== 'undefined' && typeof globalThis.__QF.resolve === 'function') {
        const v = globalThis.__QF.resolve(name);
        if (v !== undefined && v !== null) return v;
      }
      const reg = globalThis.__QV_LEGACY && globalThis.__QV_LEGACY.registry;
      return reg ? reg.get(name) : null;
    } catch (e) { return null; }
  };

  const cors = (res) => {
    res.headers.set('access-control-allow-origin', '*');
    res.headers.set('access-control-allow-headers', 'content-type, authorization, x-api-token, x-admin-token, cf-access-jwt-assertion');
    res.headers.set('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.headers.set('access-control-max-age', '600');
    return res;
  };

  const started = Date.now();

  /* ─────────────────────────── ROUTES ──────────────────────────────────── */
  /** each route: { m: methods|null, re: regex, h: handler(ctx) } */
  const ROUTES = [];
  const on = (pattern, handler, methods) => {
    const re = pattern instanceof RegExp ? pattern : new RegExp('^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
    ROUTES.push({ re, h: handler, m: methods ? methods.map(x => x.toUpperCase()) : null });
  };

  const ctxOf = (request, env, ctx, match, url) => ({
    request, env: QV.env.alias(env), ctx, url, params: match ? match.slice(1) : [],
    ua: request.headers.get('user-agent') || '',
    ip: request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '0.0.0.0',
    country: request.headers.get('cf-ipcountry') || '',
    get token() {
      const a = request.headers.get('authorization') || '';
      return a.startsWith('Bearer ') ? a.slice(7) : (request.headers.get('x-api-token') || '');
    },
  });

  /* ── health & telemetry ───────────────────────────────────────────────── */
  on(/^\/(?:health|healthz|livez)$/, async (c) => {
    const cfg = await QV.env.prepare(c.env, c.ctx);
    const selftest = c.url.searchParams.get('selftest');
    const bootedAt = QV.bootedAt || started;
    const body = {
      ok: true, app: 'quantum-veil', version: QV.VERSION,
      boot_id: QV.BOOT_ID, uptime_ms: Date.now() - bootedAt, uptime_s: Math.round((Date.now() - bootedAt) / 1000),
      features: {
        d1: !!cfg.d1, kv: !!cfg.kv, ai: !!cfg.ai, do: cfg.do.length > 0, r2: !!cfg.r2, queue: cfg.queue.length > 0,
        vless: true, shadowsocks: true, doh: true, nat64: true, telegram: !!cfg.telegram,
        protocols: ['vless-ws', 'vless-httpupgrade', 'vless-xhttp', 'vless-grpc', 'shadowsocks-2022', 'shadowsocks-aead', 'doh', 'dns-over-ss-udp'],
      },
      colo: c.request.cf?.colo || null, country: c.country,
      /* cache hit ratios + the isolate's own footprint: the two numbers that
         say whether the memory hierarchy behaves (budget: 128 MB/isolate) */
      caches: QV.cacheStats(),
      memory: QV.memEstimate(),
      counters: QV.safe(() => QV.metrics.flat(), {}),
      meter_queue: QV.safe(() => QV.d1.Sessions.meterQueue(), 0),
      jobs: QV.safe(() => (QV.router.CRON_TASKS || []).length, 0),
    };
    if (selftest) body.selftest = await QV.selfcheck.run(c.env, { quick: selftest !== 'full' });
    return json(body);
  });

  /* ── subscription: every client family, one link ──────────────────────── */
  on(/^\/sub\/([A-Za-z0-9_-]{6,64})\/?$/, async (c) => {
    const legacy = U('handleSubscription');
    /* clients spell the profile request differently: target / flag / format /
       type — accept all of them, and let the UA decide when none is given */
    const want = (c.url.searchParams.get('target') || c.url.searchParams.get('flag')
      || c.url.searchParams.get('format') || c.url.searchParams.get('type') || '').toLowerCase();
    const format = want || (/(clash|mihomo|meta)/.test(c.ua) ? 'clash' : /sing-box|sfa|sfi/.test(c.ua) ? 'singbox' : 'base64');
    const m = await QV.subs.build(c.env, c.ctx, c.params[0], {
      format, origin: c.url.origin, ua: c.ua, ip: c.ip,
      /* the ASN is the whole point of the per-carrier ranking */
      asn: c.request.cf && c.request.cf.asn ? String(c.request.cf.asn) : null,
    });
    /* a revoked, expired or over-quota account is decided here; the legacy
       handler is only consulted when the core simply has no such account */
    if (!m.ok && !m.revoked && legacy) {
      const r = await QV.safeAsync(() => legacy(c.request, c.env, c.ctx), null);
      if (r) return r;
    }
    if (!m.ok) return json(m, m.revoked ? 403 : 404);
    return new Response(m.body, {
      headers: {
        'content-type': m.contentType,
        'profile-title': 'QV ' + (m.user.name || 'account'),
        'profile-update-interval': '6',
        'subscription-userinfo': `upload=${m.user.up_bytes || 0}; download=${m.user.down_bytes || m.user.used_bytes || 0}; total=${m.user.total_bytes || 0}; expire=${m.user.expires_at || 0}`,
        'cache-control': 'no-store',
      },
    });
  });

  /* ── VLESS style transports ───────────────────────────────────────────── */
  const vlessPaths = /^\/(?:ws|vless|vl|tunnel|cdn|ws-tls|httpupgrade|hu|xhttp|grpc|v2|ray|vless-ws|custom)(?:\/.*)?$/i;
  /* A malformed handshake must look like a broken web server, never like a
     crashed one: a 500 on a tunnel path is a signature an active prober will
     record, so every failure inside a tunnel handler ends as the same decoy the
     anti-DPI layer serves. */
  const tunnelGuard = async (c, fn) => {
    try {
      const r = await fn();
      if (r instanceof Response) return r;
      if (r && typeof r === 'object') return json(r);
      return QV.antidpi.tarpitFor(c.env, c.ctx, c, 300);
    } catch (e) {
      QV.metrics.count('tunnel_error', 1);
      QV.emit(c.env, 'tunnel:error', 'warn', { message: String(e && e.message), ctx: c.ctx, meta: { path: c.url.pathname } });
      return QV.antidpi.tarpitFor(c.env, c.ctx, c, 300);
    }
  };
  on(vlessPaths, async (c) => tunnelGuard(c, async () => {
    const handler = U('handleVLESSConnection') || QV.legacy.handleVLESSConnection;
    const up = (c.request.headers.get('upgrade') || '').toLowerCase();
    if (up === 'websocket') {
      if (c.params && c.params.sni) QV.antidpi.noteRequest(c.request);
      const r = await handler(c.request, c.env, c.ctx, c.ip);
      /* A 101 is *not* authentication: VLESS authenticates on the first frame
         inside the socket (the legacy handler does the user/quota checks in its
         message listener), so scoring it here would let any socket inflate the
         ranking.  It is counted as an observation only; the authenticated
         success signal is emitted by the session path itself. */
      if (r && r.status === 101 && r.webSocket) QV.count('ci_upgrade_seen');
      return r;
    }
    /* HTTP/2 style transports (xhttp / grpc / httpupgrade over plain POST) */
    if (c.request.method === 'POST') {
      const alt = U('handleVLESSPost') || U('handleXHTTP') || null;
      if (alt) { const r = await QV.safeAsync(() => alt(c.request, c.env, c.ctx), null); if (r) return r; }
      return QV.legacy.handleVLESSConnection(c.request, c.env, c.ctx, c.ip);
    }
    /* a plain GET on a tunnel path is a probe: never answer it truthfully */
    return QV.antidpi.tarpitFor(c.env, c.ctx, c, 1200);
  }));

  /* ── Shadowsocks (2022-blake3 + legacy AEAD) ──────────────────────────── */
  on(/^\/(?:ss|shadowsocks|ss-aead|ss2022|aead)(?:\/.*)?$/i, async (c) => tunnelGuard(c, async () => {
    const up = (c.request.headers.get('upgrade') || '').toLowerCase();
    if (up === 'websocket') return QV.ss.handleWS(c.request, c.env, c.ctx, c.ip);
    if (c.request.method === 'POST') return QV.ss.handleTCP(c.request, c.env, c.ctx, c.ip);
    return QV.antidpi.tarpitFor(c.env, c.ctx, c, 900);
  }));

  /* ── DNS: DoH (RFC 8484) + JSON + tunneled UDP/TCP ───────────────────── */
  on(/^\/dns-query\/?.*$/, async (c) => QV.dns.handleDoh(c, true));
  on(/^\/(?:dns\/tcp|dns-tcp)$/, async (c) => QV.dns.handleTcpOverTunnel(c));
  on(/^\/dns\/(?:wire|udp)$/, async (c) => QV.dns.handleDoh(c, false));
  on(/^\/dns\/json\/?$/, async (c) => {
    const name = c.url.searchParams.get('name') || c.url.searchParams.get('q');
    const type = (c.url.searchParams.get('type') || 'A').toUpperCase();
    if (!name) return json({ ok: false, error: 'name required' }, 400);
    const want64 = c.url.searchParams.get('dns64');
    /* an explicit dns64=1 means "map it even if a native AAAA exists" */
    const r = await QV.dns.jsonQuery(c.env, c.ctx, name, type, want64 === '1', want64 === '1');
    return json({ ok: r.ok !== false, ...r }, r.ok === false ? 502 : 200);
  });
  on(/^\/dns\/?$/, async (c) => QV.panels.render(c.env, { lang: c.url.searchParams.get('lang') }));

  /* ── Telegram webhook ─────────────────────────────────────────────────── */
  on(/^\/tg\/(?:webhook|hook)\/?$/, async (c) => QV.telegram.handleWebhook(c.request, c.env, c.ctx));
  on(/^\/tg\/setup$/, async (c) => {
    const r = await QV.telegram.ensureWebhook(c.env, c.ctx, c.url.origin);
    return json(r);
  });

  /* ── client aid endpoints (fragment, clean IPs, QR) ───────────────────── */
  on(/^\/fragment\/?$/, async (c) => {
    const p = QV.antidpi.frag(c.env, c.url.searchParams.get('asn'), c.country);
    return json({ ok: true, profile: p, hint: 'put these values in the client fragment settings' });
  });
  on(/^\/clean-ip\/?$/, async (c) => {
    const uuid = c.url.searchParams.get('u') || '';
    const asn = c.url.searchParams.get('asn') || (c.request.cf && c.request.cf.asn ? String(c.request.cf.asn) : null);
    /* the ranked view for one caller: per-ASN rows first, then global, plus the
       IPv6 forms (native or NAT64-synthesised) */
    const prefer = c.url.searchParams.get('prefer') || 'auto';
    const picked = await QV.cleanip.pick(c.env, { asn, n: Math.max(1, Number(c.url.searchParams.get('n')) || 6), uuid, prefer });
    if (c.url.searchParams.get('scan')) await QV.cleanip.edgeProbe(c.env, c.ctx, picked.v4.map(r => r.ip), { limit: 8 });
    return json({
      ok: true,
      ips: picked.v4.map(r => ({ ip: r.ip, score: r.score, samples: r.samples, scope: r.scope, family: 'v4' })),
      ipv6: picked.v6.map(r => ({ ip: r.ip, score: r.score, samples: r.samples, scope: r.scope, family: 'v6' })),
      nat64: picked.nat64.map(r => ({ ip: r.ip, source: r.source_ip, note: 'synthesised from a proven IPv4 endpoint' })),
      asn, rows: picked.rows, prefer: picked.prefer, dual: picked.dual,
      preferred: picked.preferred.map(r => ({ ip: r.ip, family: r.family || 'v4', nat64: !!r.nat64, score: r.score })),
      note: 'use one of these instead of the hostname to dodge IP-range blocks',
    });
  });
  on(/^\/qr\/?$/, async (c) => {
    const d = c.url.searchParams.get('d') || c.url.searchParams.get('data') || '';
    if (!d) return json({ ok: false, error: 'd required' }, 400);
    const svg = QV.qr.svg(d, { scale: Math.min(12, Math.max(1, Number(c.url.searchParams.get('s')) || 5)), ec: (c.url.searchParams.get('ec') || 'M').toUpperCase() });
    return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' } });
  });

  /* ── admin / user console ─────────────────────────────────────────────── */
  /* A legacy panel handler is only trusted when it actually produced a console:
     status 200, an HTML content type and a body big enough to be a page.  Older
     generations answer a bare 401 "Unauthorized" because their session format
     is gone — that answer is a dead end, so the modern console takes over. */
  const usablePanel = async (r, minLen = 2000) => {
    if (!r || !(r instanceof Response)) return null;
    if (r.status !== 200) return null;
    const ct = r.headers.get('content-type') || '';
    if (ct && !/html/i.test(ct)) return null;
    try {
      const txt = await r.clone().text();
      return txt.length >= minLen && /<html|<div|<!doctype/i.test(txt) ? r : null;
    } catch (e) { return null; }
  };
  on(/^\/(?:admin|panel|dashboard|console|qv)\/?$/, async (c) => {
    const auth = await QV.api.auth(c, { allow: 'any' });
    if (!auth.ok) return QV.panels.login();
    if (auth.role === 'admin') {
      const legacy = U('handleAdminPanel');
      if (legacy) {
        const r = await QV.safeAsync(() => legacy(c.request, c.env, c.ctx), null);
        const good = await usablePanel(r);
        if (good) return good;
      }
      return QV.panels.render(c.env, { lang: c.url.searchParams.get('lang') });
    }
    return QV.router.userPanel(c);
  });
  on(/^\/(?:me|my|account)\/?$/, async (c) => QV.router.userPanel(c, true));

  /* ── JSON API ─────────────────────────────────────────────────────────── */
  /* ── the clean-endpoint engine's public surface ───────────────────────── */
  /* These three routes sit in front of /api on purpose: they authenticate with
     a signed batch token (the subscriber's own browser), not with a session. */
  on(/^\/probe\.js$/, async () => new Response(QV.cleanip.proberJs(), {
    headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-qv': QV.VERSION },
  }));
  on(/^\/probe(?:\/([0-9a-fA-F-]{6,64}))?\/?$/, async (c) => QV.cleanip.proberPage(c.env, c.params[0] || ''));
  on(/^\/api\/ip-batch$/, async (c) => {
    const uuid = (c.url.searchParams.get('u') || '').trim();
    if (!QV.isUuid(uuid)) return json({ ok: false, error: 'uuid required' }, 400);
    /* the account must exist and be allowed — one read, six times an hour */
    const user = await QV.safeAsync(() => QV.d1.Users.get(c.env, uuid), null);
    if (!user) return json({ ok: false, error: 'unknown account' }, 404);
    const allowed = await QV.safeAsync(() => QV.d1.Users.allowed(c.env, uuid), { ok: true });
    if (allowed && !allowed.ok && allowed.reason !== 'unknown') return json({ ok: false, error: 'account disabled' }, 403);
    const d = await QV.cleanip.handout(c.env, c.ctx, uuid, {
      count: Math.min(16, Number(c.url.searchParams.get('n')) || QV.cleanip.LIMITS.batchIps),
      scope: c.url.searchParams.get('scope') || null,
    });
    return json({ ok: true, ...d }, 200);
  });
  on(/^\/api\/ip-report$/, async (c) => {
    if (c.request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
    const body = await c.request.arrayBuffer();
    const r = await QV.cleanip.submit(c.env, c.ctx, c.request, body);
    return json({ ok: r.ok, ...r }, r.status || (r.ok ? 200 : 400));
  });

  on(/^\/api(?:\/.*)?$/, async (c) => QV.api.handle(c));

  /* ── landing ──────────────────────────────────────────────────────────── */
  on(/^\/$/, async (c) => {
    if (c.url.searchParams.has('proxyip') || c.url.searchParams.has('ed') || c.url.searchParams.has('token')) return QV.router.userPanel(c, true);
    return QV.router.landing(c);
  });
  on(/^\/robots\.txt$/, () => text('User-agent: *\nDisallow: /\n'));
  on(/^\/favicon\.ico$/, () => new Response(QV.panels.favicon || new Uint8Array(0), { status: 204 }));

  /* ── register anything a core module wants exposed ───────────────────── */
  QV.routes = { list: ROUTES, on, json, text, notFound, U };

  /* ═══════════════════════ legacy delegation ═══════════════════════════ */
  /** the units export whole apps: try their fetch handlers in priority order */
  const LEGACY_ORDER = [
    'secureWorkerFetch', 'workerFetch', 'mainFetch', 'handleRequest', 'handleFetch', 'handleRequestLegacy',
    'handleAPIRequest', 'fetch', 'default',
  ];
  /* ── adaptive invocation of a legacy handler ───────────────────────────
   * The eleven editions do not share a calling convention: some take
   * (request, env, ctx), some (request, env, path), some (uuid, env, origin).
   * Reading the parameter names off the function itself and binding them by
   * meaning makes thousands of previously dead call sites work again — the
   * alternative (guessing one shape) is what left them dead in the first place.
   * ------------------------------------------------------------------- */
  const ARG_FOR = (name, c) => {
    const n = String(name || '').toLowerCase();
    if (n === 'request' || n === 'req' || n === 'event' || n === 'e') return c.request;
    if (n === 'env' || n === 'environment' || n === 'bindings' || n === 'config' || n === 'settings') return c.env;
    if (n === 'ctx' || n === 'context' || n === 'waituntil' || n === 'executioncontext') return c.ctx;
    if (n === 'path' || n === 'pathname' || n === 'route' || n === 'subpath') return c.url.pathname;
    if (n === 'url' || n === 'requesturl') return c.url;
    if (n === 'origin' || n === 'base' || n === 'host') return n === 'host' ? c.url.host : c.url.origin;
    if (n === 'uuid' || n === 'id' || n === 'user' || n === 'userid' || n === 'user_uuid' || n === 'userid_or_uuid') return c.uuid || '';
    if (n === 'ip' || n === 'clientip' || n === 'address' || n === 'remoteip') return c.ip;
    if (n === 'starttime') return Date.now();
    if (n === 'action' || n === 'command') return (c.url.searchParams.get(n === 'command' ? 'cmd' : 'action') || '');
    return undefined;
  };
  const paramsOf = (fn) => {
    try {
      const src = String(fn);
      const open = src.indexOf('(');
      if (open < 0) return [];
      let depth = 0, close = -1;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (!depth) { close = i; break; } }
      }
      if (close < 0) return [];
      const list = src.slice(open + 1, close);
      return list.split(',').map(p => p.trim().split('=')[0].trim().replace(/^[\.]{3}/, ''))
        /* an arrow/async prefix or a destructured parameter both reduce to the
           property names the handler actually reads */
        .flatMap(p => (p.startsWith('{') ? p.replace(/[{}]/g, '').split(',').map(x => x.trim().split(':').pop().trim()) : [p]))
        .filter(Boolean);
    } catch (e) { return []; }
  };
  const invokeLegacy = async (fn, c, extra = {}) => {
    const names = paramsOf(fn);
    if (!names.length) return fn(c.request, c.env, c.ctx);
    const args = names.map(n => (n in extra ? extra[n] : ARG_FOR(n, c)));
    /* a parameter the map did not recognise keeps the historic order */
    if (args.every(a => a === undefined)) return fn(c.request, c.env, c.ctx);
    return fn(...args);
  };

  const legacyFetch = async (c) => {
    const tried = [];
    const uuid = c.uuid || (c.url.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || '';
    const shaped = { ...c, uuid };
    for (const name of LEGACY_ORDER) {
      let fn = null;
      if (name === 'default') {
        for (const d of (typeof __QF !== 'undefined' && __QF.defaults ? __QF.defaults() : [])) {
          if (d && typeof d.fetch === 'function') {
            tried.push('default');
            const r = await QV.safeAsync(() => d.fetch(c.request, c.env, c.ctx), null);
            if (r instanceof Response && r.status !== 404 && r.status !== 501) return r;
          }
        }
        continue;
      }
      try { fn = U(name); } catch (e) { fn = null; }
      if (typeof fn !== 'function') continue;
      tried.push(name);
      const res = await QV.safeAsync(() => invokeLegacy(fn, shaped), null);
      if (res instanceof Response && res.status !== 404 && res.status !== 501) return res;
      if (res && typeof res === 'object' && !(res instanceof Response) && (res.body !== undefined || res.html !== undefined)) {
        return new Response(res.body || res.html, { status: res.status || 200, headers: res.headers || { 'content-type': 'text/html; charset=utf-8' } });
      }
    }
    log.debug('router', 'no legacy handler answered', { tried, path: c.url.pathname });
    return null;
  };


  /* ═══════════════════════════ handlers ════════════════════════════════ */
  const landing = async (c) => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${QV.env.get(c.env, 'LANDING_TITLE', 'Service')}</title>
<style>body{margin:0;background:#0b1020;color:#e9eefb;font:16px/1.7 system-ui,Tahoma,sans-serif;display:grid;place-items:center;min-height:100vh}
.c{max-width:640px;padding:32px;text-align:center}h1{font-size:22px;font-weight:800;margin:0 0 8px}
p{color:#93a0c4;margin:6px 0}b{color:#5b8cff}.box{margin-top:18px;border:1px solid #243154;border-radius:14px;padding:18px;background:#161f3d}</style></head>
<body><div class="c"><h1>${QV.esc(QV.env.get(c.env, 'LANDING_TITLE', 'Service'))}</h1>
<p>${QV.esc(QV.env.get(c.env, 'LANDING_SUB', 'This endpoint is a private service node.'))}</p>
<div class="box"><p>${QV.esc(QV.env.get(c.env, 'LANDING_NOTE', 'Access is issued per account. Contact your provider if you already have credentials.'))}</p></div>
<p style="margin-top:14px;font-size:12px">${new Date().getUTCFullYear()}</p></div></body></html>`;
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    });
  };

  const userPanel = async (c, wantJson) => {
    const token = c.url.searchParams.get('token') || c.url.searchParams.get('t');
    let uuid = c.url.searchParams.get('uuid') || token;
    if (!uuid && (c.url.pathname.startsWith('/api') || wantJson)) uuid = '';
    if (!uuid) {
      const auth = await QV.api.auth(c, { allow: 'any' });
      if (auth.ok && auth.user) uuid = auth.user.uuid;
    }
    if (!uuid || !QV.isUuid(uuid)) {
      const legacy = U('handleUserPanel');
      const r = legacy ? await QV.safeAsync(() => legacy(c.request, c.env, c.ctx), null) : null;
      if (r && r.status !== 404) return r;
      return QV.panels.login();
    }
    const build = await QV.subs.build(c.env, c.ctx, uuid, { format: 'uris', origin: c.url.origin });
    if (!build.ok) return json(build, 404);
    if (wantJson) return json({ ok: true, user: build.user, nodes: build.nodes, subUrl: build.subUrl });
    return QV.panels.user(c.env, build.user, { nodes: build.nodes, subUrl: build.subUrl });
  };

  /* ═════════════════════════════ main fetch ════════════════════════════ */
  const handleFetch = async (request, env, ctx = {}) => {
    const t0 = Date.now();
    QV.__markBoot();
    env = QV.env.alias(env || {});
    const url = new URL(request.url);
    if (!ctx.waitUntil) ctx.waitUntil = (p) => { QV.safeAsync(() => p, null); };
    /* every request path (tunnel, subscription, DNS, API) must find a ready
       database and seeded pools — prepare() is cached, so this is cheap */
    await QV.safeAsync(() => QV.env.prepare(env, ctx), null);
    if (!__sidesRan) ctx.waitUntil(runUnitSides(env, ctx));
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    let res;
    try {
      /* ban list + classify first: probing is answered, never ignored */
      const verdict = await QV.antidpi.gate(request, env, ctx);
      if (verdict.action === 'tarpit') res = await QV.antidpi.tarpitFor(env, ctx, ctxOf(request, env, ctx, null, url), verdict.ms || 1500);
      else if (verdict.action === 'ban') res = json({ ok: false }, 403);
      if (!res) {
        const path = url.pathname.replace(/\/+$/, '') || '/';
        let matched = null;
        for (const r of ROUTES) {
          if (r.m && !r.m.includes(request.method)) continue;
          const m = r.re.exec(path);
          if (m) { matched = { r, m }; break; }
        }
        if (matched) {
          res = await matched.r.h(ctxOf(request, env, ctx, matched.m, url));
        } else {
          res = await legacyFetch(ctxOf(request, env, ctx, null, url));
          if (!res) {
            /* path aliases the units used to own: /ws /sub /tg /api … are
             * already covered, so anything left is a probe → decoy */
            const decoy = U('handleDecoy') || U('decoyResponse');
            res = decoy ? await QV.safeAsync(() => decoy(request, env, ctx), null) : null;
            res = res || json({ ok: true, ts: Date.now() }, 200);
          }
        }
      }
      if (!(res instanceof Response)) res = json(res);
      if (request.headers.get('origin')) res = cors(res);
    } catch (e) {
      const id = QV.shortId(6);
      log.error('router', 'unhandled', { id, err: e?.stack || e?.message, path: url.pathname });
      QV.emit(env, 'router:error', 'error', { message: `${url.pathname} — ${e?.message}`, ctx, meta: { id, stack: String(e?.stack || '').slice(0, 800) } });
      res = json({ ok: false, error: 'internal error', ref: id }, 500);
    }
    const ms = Date.now() - t0;
    res.headers.set('server-timing', `app;dur=${ms}`);
    res.headers.set('x-qv', QV.VERSION);
    QV.metrics.observe('http_ms', ms, { path: url.pathname });
    QV.metrics.count('requests', 1, { status: res.status });
    QV.emit(env, 'http', 'debug', { message: request.method + ' ' + url.pathname + ' → ' + res.status, ctx, meta: { ms } });
    return res;
  };

  /* ═══════════════════════════ cron / queue ════════════════════════════ */
  const CRON_TASKS = [
    { id: 'meter-flush', every: 60, budgetMs: 8000, run: async (env, ctx) => QV.d1.Sessions.flushMeters(env, ctx) },
    { id: 'quota-sweep', every: 60, budgetMs: 8000, run: async (env, ctx) => QV.subs.enforceQuotas(env, ctx) },
    { id: 'session-gc', every: 300, budgetMs: 10000, run: async (env, ctx) => QV.d1.Sessions.reap(env, 600) },
    { id: 'event-gc', every: 900, budgetMs: 10000, run: async (env, ctx) => QV.d1.Events.trim ? QV.d1.Events.trim(env, 4000) : null },
    { id: 'ip-unban', every: 300, budgetMs: 8000, run: async (env, ctx) => QV.antidpi.sweepBans(env) },
    { id: 'dns-cache-gc', every: 600, budgetMs: 6000, run: async (env) => QV.dns.sweepCache(env) },
    { id: 'state-snapshot', every: 300, budgetMs: 12000, run: async (env, ctx) => QV.router.snapshotActiveUsers(env, ctx, { limit: 50 }) },
    { id: 'sni-health', every: 1800, budgetMs: 20000, run: async (env, ctx) => QV.antidpi.checkSNIHealth(env, ctx, { limit: 12 }) },
    { id: 'sni-hunt', every: 3600, budgetMs: 20000, run: async (env, ctx) => QV.antidpi.hunt(env, ctx, { count: 6 }) },
    /* the endpoint engine: reports stream in from browsers all the time; these
       steps only aggregate them, age the scores, and keep the pool stocked */
    { id: 'ip-agg', every: 60, budgetMs: 8000, run: async (env, ctx) => QV.cleanip.aggregate(env, ctx) },
    { id: 'ip-refill', every: 300, budgetMs: 15000, run: async (env, ctx) => QV.cleanip.refill(env, ctx) },
    { id: 'ip-edge', every: 900, budgetMs: 15000, run: async (env, ctx) => { const p = await QV.cleanip.plan(env, ctx, { count: 12 }); const r = await QV.cleanip.edgeProbe(env, ctx, p.list.map(x => x.ip), { limit: 12 }); return { probed: r.length, reachable: r.filter(x => x.tcp).length, view: 'edge' }; } },
    { id: 'ip-ranges', every: 21600, budgetMs: 20000, run: async (env, ctx) => { const r = await QV.cleanip.ranges(env, ctx, { refresh: true }); return { providers: r.providers.length, live: r.live, fallback: r.fallback, v4: r.v4.length, v6: r.v6.length }; } },
    { id: 'ip-scan', every: 3600, budgetMs: 20000, run: async (env, ctx) => QV.antidpi.scanCleanIPs(env, ctx, { limit: 8 }) },
    { id: 'ai-replan', every: 3600, budgetMs: 20000, run: async (env, ctx) => QV.antidpi.analyse(env, ctx, { reason: 'cron' }) },
    /* outcome half of the strategy loop: keep a good strategy, roll a bad one
       back to the previous version (bounded to one evaluation per 30 min) */
    { id: 'strategy-eval', every: 1800, budgetMs: 8000, run: async (env, ctx) => QV.antidpi.evaluateStrategy(env, ctx) },
    { id: 'ai-refresh', every: 21600, budgetMs: 20000, run: async (env, ctx) => QV.ai.refresh(env, ctx) },
    { id: 'health-probe', every: 1800, budgetMs: 15000, run: async (env, ctx) => QV.ai.probe(env, ctx) },
    { id: 'telegram-poll', every: 120, budgetMs: 8000, run: async (env, ctx) => QV.telegram.pollOnce(env, ctx) },
    { id: 'metrics-rollup', every: 900, budgetMs: 10000, run: async (env) => QV.metrics.rollup(env) },
    { id: 'jobs-gc', every: 900, budgetMs: 5000, run: async (env) => QV.d1.Jobs.gc(env) },
    { id: 'backup', every: 86400, budgetMs: 25000, run: async (env, ctx) => QV.d1.exportAll(env, { toKv: true, ctx }) },
    { id: 'self-heal', every: 3600, budgetMs: 20000, run: async (env, ctx) => QV.router.selfHeal(env, ctx) },
    { id: 'selfcheck', every: 21600, budgetMs: 20000, run: async (env) => QV.selfcheck.run(env, { quick: true }) },
  ];

  /* the KV snapshots the hot path reads as its second tier: refreshed only for
     accounts that were alive recently, so the write rate stays tiny */
  const snapshotActiveUsers = async (env, ctx, opts = {}) => {
    const limit = Math.min(100, opts.limit || 50);
    const rows = (await QV.d1.all(env, `SELECT uuid FROM qv_users WHERE enabled = 1 AND last_seen > ?
      ORDER BY last_seen DESC LIMIT ?`, Math.floor(Date.now() / 1000) - 900, limit)) || [];
    let written = 0;
    for (const r of rows) {
      const st = await QV.d1.Users.state(env, r.uuid, { fresh: true });
      if (!st) continue;
      if (await QV.d1.Users.snapshot(env, r.uuid, st)) written++;
    }
    return { users: rows.length, snapshots: written };
  };

  const scheduled = async (event, env, ctx) => {
    QV.__markBoot();
    env = QV.env.alias(env || {});
    const cron = event?.cron || '* * * * *';
    let minute = 0, hour = 0;
    try { const parts = cron.split(' '); minute = parts[0] === '*' ? -1 : parseInt(parts[0], 10); hour = parts[1] === '*' ? -1 : parseInt(parts[1], 10); } catch (e) {}
    const results = {};
    const nowMin = Math.floor(Date.now() / 60000);
    /* Stagger: task n runs on the tick where (nowMin + n) divides its period,
       so nineteen jobs never fire in the same minute and the D1 write bursts
       spread out.  A single runner holds each job thanks to a D1 lock. */
    const due = CRON_TASKS.filter((t, i) => {
      if (cron === '* * * * *') {
        const periodMin = Math.max(1, Math.round(t.every / 60));
        if (periodMin === 1) return true;
        return (nowMin + (i % periodMin)) % periodMin === 0;
      }
      return true;
    });
    await QV.safeAsync(() => QV.d1.Jobs.ensure(env), null);
    for (const task of due) {
      const t0 = Date.now();
      /* one runner per window: a retried cron, a manual trigger and a second
         isolate cannot run the same job twice (KV locks are not consistent) */
      let locked = true;
      if (cron === '* * * * *') {
        locked = await QV.safeAsync(() => QV.d1.Jobs.claim(env, task.id, Math.max(60, Math.round(task.every / 60) * 60)), true);
      }
      if (!locked) { results[task.id] = { skipped: 'locked' }; continue; }
      let err = null;
      try {
        const out = await QV.withTimeout(task.run(env, ctx), task.budgetMs || 20000, task.id);
        results[task.id] = { ms: Date.now() - t0, out: typeof out === 'object' && out !== null ? out : String(out) };
      } catch (e) {
        err = e;
        results[task.id] = { ms: Date.now() - t0, error: e?.message || String(e) };
        log.warn('cron', task.id + ' failed', { err: e?.message });
      } finally {
        if (cron === '* * * * *') await QV.safeAsync(() => QV.d1.Jobs.release(env, task.id, Date.now() - t0, err), null);
      }
    }
    log.info('cron', 'sweep complete', { cron, tasks: Object.keys(results).length, minute, hour });
    return results;
  };

  const queue = async (batch, env, ctx) => {
    QV.__markBoot();
    env = QV.env.alias(env || {});
    const jobs = Array.isArray(batch) ? batch : (batch.messages || []).map(m => m.body ?? m);
    const out = [];
    for (const job of jobs) {
      try {
        const kind = job && job.kind;
        if (kind === 'broadcast') out.push(await QV.telegram.broadcast(env, ctx, job.text, job.filter));
        else if (kind === 'ai') out.push(await QV.ai.run(env, job.prompt, job.options));
        else if (kind === 'dns-warm') out.push(await QV.dns.warm(env, ctx, job.names || []));
        else if (kind === 'hunt') out.push(await QV.antidpi.hunt(env, ctx, job));
        else out.push({ skipped: true, kind });
        if (batch.ackAll !== true && job && job.id && batch.ack) batch.ack(job.id);
      } catch (e) { out.push({ error: e?.message }); }
    }
    return out;
  };

  /* ═══════════════════════ self-healing watchdog ═══════════════════════ */
  const selfHeal = async (env, ctx) => {
    const report = { fixed: [], failed: [] };
    const attempt = async (name, fn) => {
      try { const r = await fn(); report.fixed.push({ name, r }); }
      catch (e) { report.failed.push({ name, err: e?.message }); }
    };
    if (!(await QV.d1.Kv.get(env, 'qv:schema:v', 0))) await attempt('schema', () => QV.d1.migrate(env));
    if (!(await QV.d1.Users.count(env))) await attempt('bootstrap-admin', () => QV.d1.bootstrap(env));
    if (!(await QV.d1.Sni.top(env, 1)).length) await attempt('seed-sni', () => QV.antidpi.seedSni(env));
    if (!(await QV.d1.Ip.top(env, 1)).length) await attempt('seed-ips', () => QV.antidpi.seedIps(env));
    if (!(await QV.d1.Kv.get(env, 'qv:strategy', null))) await attempt('strategy', () => QV.antidpi.analyse(env, ctx, { reason: 'bootstrap' }));
    const kb = await QV.d1.Kv.get(env, 'qv:keys', null);
    if (!kb || !kb.jwt) await attempt('secrets', () => QV.env.ensureSecrets(env, ctx));
    return report;
  };

  /* ── unit side effects: the legacy bundles carry top-level console banners, a
 *  CommonJS export block and three awaited self-tests.  The assembler lifted
 *  those statements into guarded runners (module scope in workerd may not do
 *  I/O); they execute exactly once per isolate, off the request's critical
 *  path, and any failure is recorded instead of thrown. */
let __sidesRan = false;
const runUnitSides = async (env, ctx) => {
  if (__sidesRan) return { skipped: true };
  __sidesRan = true;
  const sides = (typeof globalThis.__QF_SIDES__ !== 'undefined' && globalThis.__QF_SIDES__) || [];
  const out = { total: sides.length, ok: 0, failed: 0 };
  for (const item of sides) {
    const r = await QV.safeAsync(() => QV.withTimeout(item.run(), 4000, 'unit-side:' + item.unit), undefined);
    if (r === undefined && QV.unitFaults && QV.unitFaults.some(f => f.unit === item.unit)) out.failed++;
    else out.ok++;
  }
  if (out.failed) QV.log.warn('router', 'legacy unit side effects reported errors', { ...out, faults: (QV.unitFaults || []).slice(-5) });
  else QV.log.info('router', 'legacy unit side effects executed', out);
  QV.metrics.count('unit.sides', out.total);
  return out;
};

/* filled by the unit-side runners; the router must be able to read it even
   before the first unit has woken up */
QV.unitFaults = QV.unitFaults || [];

QV.router = { handleFetch, runUnitSides, scheduled, queue, CRON_TASKS, selfHeal, snapshotActiveUsers, landing, userPanel, ROUTES, on, U, json, text, notFound, cors, ctxOf };
})();
