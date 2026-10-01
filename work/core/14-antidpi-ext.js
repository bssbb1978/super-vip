/* ═══════════════════════════════════════════════════════════════════════════
 * A4b · ANTI-DPI EXTENSIONS — seeding, hunting, clean-IP scan, classification
 * ═══════════════════════════════════════════════════════════════════════════
 *  Additive only: the engine in 10-antidpi.js keeps every original function;
 *  here we graft on the operations that the router, the cron jobs and the
 *  Telegram control plane call:
 *    seed()            populate D1 pools on first run
 *    hunt()            discover new SNI candidates (AI + live TLS probing)
 *    checkSNIHealth()  re-score the pool, quarantine dead/blocked entries
 *    scanCleanIPs()    rank Cloudflare edge IPs a censored client can reach
 *    classify()        verdict per request: allow / tarpit / ban / tunnel
 *    onProbe()         telemetry + tarpit bookkeeping for probe handling
 * ═══════════════════════════════════════════════════════════════════════════ */
(function extendAntiDpi() {
  const A = QV.antidpi;
  const DAY = 86400;

  /* keep a handle on originals we are decorating */
  const baseFragmentProfile = A.fragmentProfile;
  const baseDescribe = A.describe;

  /* ---------- seeding ---------------------------------------------------- */
  A.seed = async (env) => {
    if (!env?.DB) return { ok: false, reason: 'no D1' };
    let n = 0;
    for (const [pool, list] of Object.entries(A.sniPools)) {
      for (const sni of list) {
        await QV.safeAsync(() => QV.d1.Sni.upsert(env, { sni, provider: pool, country: 'XX', score: A.scoreSni(sni), success: 0, fail: 0, tags: [pool] }));
        n++;
      }
    }
    /* seed the clean-IP pool from the well-known Cloudflare ranges */
    const ranges = (env.CLEAN_IP_CANDIDATES || '172.64.0.0/13,104.16.0.0/13,162.159.0.0/16,188.114.96.0/20')
      .split(',').map(s => s.trim()).filter(Boolean);
    let ips = 0;
    for (const cidr of ranges) {
      for (const ip of sampleCidr(cidr, 6)) {
        await QV.safeAsync(() => QV.d1.Ip.upsert(env, { ip, label: 'seed', score: 50, success: 0, fail: 0 }));
        ips++;
      }
    }
    await A.load(env);
    QV.log.info('antidpi', 'pools seeded', { sni: n, ips });
    return { ok: true, sni: n, ips, strategy: A.state.strategy.version };
  };

  const sampleCidr = (cidr, count = 4) => {
    const [base, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr || '24', 10);
    const oct = base.split('.').map(Number);
    const baseInt = ((oct[0] << 24) >>> 0) + (oct[1] << 16) + (oct[2] << 8) + oct[3];
    const span = bits >= 32 ? 1 : Math.min(2 ** (32 - bits), 65536);
    const out = [];
    for (let i = 0; i < count; i++) {
      const v = (baseInt + Math.floor(Math.random() * span)) >>> 0;
      out.push([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.'));
    }
    return [...new Set(out)];
  };

  /* ---------- SNI discovery --------------------------------------------- */
  const CANDIDATE_SEEDS = [
    'www.cloudflare.com', 'dash.cloudflare.com', 'developers.cloudflare.com', 'one.one.one.one',
    'speed.cloudflare.com', 'community.cloudflare.com', 'blog.cloudflare.com', 'workers.cloudflare.com',
    'www.microsoft.com', 'www.office.com', 'login.microsoftonline.com', 'www.azure.com',
    'www.apple.com', 'support.apple.com', 'developer.apple.com', 'gs.apple.com',
    'www.amazon.com', 'www.samsung.com', 'www.lg.com', 'www.sony.com',
    'cdn.jsdelivr.net', 'www.jsdelivr.com', 'unpkg.com', 'cdnjs.cloudflare.com',
    'www.wikipedia.org', 'commons.wikimedia.org', 'www.mozilla.org', 'gitlab.com',
    'www.aparat.com', 'www.digikala.com', 'www.filimo.com', 'www.zoomit.ir',
  ];

  /**
   * hunt — three sources of truth, all verified before they enter the pool:
   *   1. static high-reputation candidates (above)
   *   2. the model's own suggestions, filtered against the allowed-domain rule
   *   3. live TLS reachability from this very edge (a real ClientHello)
   * Results are stored in qv_sni_pool with a measured score.
   */
  A.hunt = async (env, ctx, opts = {}) => {
    const count = opts.count || 8;
    const found = [];
    const candidates = new Set(CANDIDATE_SEEDS);

    /* 2. ask the model for fresh, popular, non-blocked-in-Iran hostnames */
    if (env?.AI) {
      const prompt = `List ${count} real, extremely popular hostnames (exact SNI values) that are (a) served by large CDNs, (b) NOT blocked in Iran today, (c) suitable as a decoy TLS SNI. Reply as JSON {"sni":["...","..."]}. No commentary.`;
      const res = await QV.safeAsync(() => QV.ai.json(env, prompt, { kind: 'chat', maxTokens: 400 }));
      for (const s of (res?.data?.sni || [])) {
        const v = String(s).toLowerCase().trim();
        if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v) && !/vpn|proxy|filter|free|dns|tor|psiphon/.test(v)) candidates.add(v);
      }
    }

    /* 3. probe each candidate with a genuine handshake */
    const list = [...candidates];
    const batchSize = 8;
    for (let i = 0; i < list.length && found.length < count * 2; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (sni) => {
        const t0 = Date.now();
        try {
          const res = await QV.fetchWithRetry(`https://${sni}/cdn-cgi/trace`, { method: 'GET' }, { retries: 0, timeoutMs: 4500 });
          const text = await res.text().catch(() => '');
          const ok = res.ok && /(^|\n)colo=/.test(text);
          const latency = Date.now() - t0;
          const colo = (text.match(/colo=(\w+)/) || [])[1] || null;
          return { sni, ok, latency, colo, status: res.status };
        } catch (e) {
          return { sni, ok: false, latency: Date.now() - t0, error: e?.message };
        }
      }));
      for (const r of results) {
        if (!r.ok) { await QV.safeAsync(() => QV.d1.Sni.upsert(env, { sni: r.sni, score: -5, fail: 1 })); continue; }
        const score = QV.clamp(A.scoreSni(r.sni) + (r.latency < 300 ? 25 : r.latency < 700 ? 15 : 5), 0, 100);
        await QV.safeAsync(() => QV.d1.Sni.upsert(env, { sni: r.sni, provider: 'hunt', country: r.colo || 'XX', score, latency_ms: r.latency, success: 1, fail: 0, tags: ['hunted', r.colo || 'edge'] }));
        found.push({ sni: r.sni, score, latencyMs: r.latency, edge: r.colo });
      }
    }
    found.sort((a, b) => b.score - a.score);
    A.state.telemetry.hunted = (A.state.telemetry.hunted || 0) + found.length;
    QV.emit(env, 'sni:hunt', 'info', { message: `+${found.length} verified SNI`, ctx, meta: { top: found.slice(0, 3).map(f => f.sni) } });
    return found;
  };

  /** re-score the whole pool: dead entries lose points, blocked ones are quarantined */
  A.checkSNIHealth = async (env, ctx) => {
    const pool = await QV.safeAsync(() => QV.d1.Sni.top(env, 60), []);
    let ok = 0, dead = 0;
    for (const row of pool) {
      const t0 = Date.now();
      let alive = false;
      try {
        const res = await fetch(`https://${row.sni}/cdn-cgi/trace`, { method: 'GET', signal: AbortSignal.timeout(4000) });
        alive = res.ok;
      } catch (e) { alive = false; }
      const latency = Date.now() - t0;
      if (alive) {
        ok++;
        await QV.safeAsync(() => QV.d1.Sni.upsert(env, { sni: row.sni, score: QV.clamp((row.score || 0) + 2, 0, 100), latency_ms: latency, success: 1, fail: 0 }));
      } else {
        dead++;
        const score = (row.score || 0) - 8;
        await QV.safeAsync(() => QV.d1.Sni.upsert(env, { sni: row.sni, score, latency_ms: null, success: 0, fail: 1 }));
        if (score < -20) await QV.safeAsync(() => QV.d1.Sni.block(env, row.sni));
      }
    }
    QV.emit(env, 'sni:health', 'info', { message: `${ok} alive / ${dead} dead`, ctx, meta: { checked: pool.length } });
    return { checked: pool.length, alive: ok, dead };
  };

  /* ---------- clean-IP scanning ----------------------------------------- */
  /**
   * A censored client cannot always reach the worker on 1.1.1.1-like addresses;
   * the classic Iranian workaround is a "clean IP" from a Cloudflare range that
   * is not currently blackholed.  We rank candidates by (a) route health from
   * the edge itself and (b) historical success recorded per IP in D1.
   */
  /**
   * Kept for every historic caller (cron, /api/ips, the Telegram command, the
   * legacy pick()).  It now asks the measurement engine for its ranking and
   * only falls back to the old edge-only probe when the engine is absent.
   */
  const scanCleanIPsV2 = async (env, ctx, opts = {}) => {
    const n = Math.max(1, Math.min(64, opts.limit || 12));
    const picked = await QV.cleanip.pick(env, { asn: opts.asn || null, n, uuid: opts.uuid || null });
    const rows = [...picked.v4, ...picked.v6];
    if (!rows.length) return scanCleanIPsV1(env, ctx, opts);          /* nothing measured yet */
    const list = rows.map(r => ({
      ip: r.ip, score: r.score, latencyMs: r.rtt_ms ?? null, family: r.family || 'v4',
      reachable: true, source: r.scope === 'asn' ? 'client-report' : 'client-report-global',
      samples: r.samples, state: r.state,
    }));
    A.state.cleanIps = list;
    /* the coarse pool other surfaces read stays in step with the ranking */
    await QV.safeAsync(() => QV.cleanip.syncPool(env), null);
    return list;
  };
  const scanCleanIPsV1 = async (env, ctx, opts = {}) => {
    const limit = opts.limit || 24;
    const ranges = (env.CLEAN_IP_CANDIDATES || '172.64.0.0/13,104.16.0.0/13,162.159.0.0/16,188.114.96.0/20')
      .split(',').map(s => s.trim()).filter(Boolean);
    const known = await QV.safeAsync(() => QV.d1.Ip.top(env, 100), []);
    const candidates = new Map();
    for (const k of known) candidates.set(k.ip, { ip: k.ip, score: k.score || 0, latencyMs: k.latency_ms, source: 'history' });
    for (const cidr of ranges) for (const ip of sampleCidr(cidr, 3)) if (!candidates.has(ip)) candidates.set(ip, { ip, score: 40, source: 'sample' });

    const list = [...candidates.values()].slice(0, Math.max(limit, 12));
    await Promise.all(list.map(async (c) => {
      const t0 = Date.now();
      try {
        const port = await connectPort(c.ip, 443, 3500);
        c.latencyMs = Date.now() - t0;
        c.reachable = port;
        if (port) c.score = QV.clamp(60 + (c.latencyMs < 150 ? 30 : c.latencyMs < 400 ? 18 : 6), 0, 100);
        else c.score = Math.max(0, c.score - 15);
      } catch (e) {
        c.reachable = false; c.latencyMs = Date.now() - t0; c.score = Math.max(0, c.score - 20);
      }
      c.family = 'v4';
      await QV.safeAsync(() => QV.d1.Ip.upsert(env, { ip: c.ip, label: c.source, score: c.score, latency_ms: c.latencyMs, success: c.reachable ? 1 : 0, fail: c.reachable ? 0 : 1 }));
    }));
    const scored = list.sort((a, b) => (b.reachable ? 1 : 0) - (a.reachable ? 1 : 0) || b.score - a.score).slice(0, limit);
    A.state.cleanIps = scored;
    return scored;
  };
  /* the public name is the delegating one; the edge-only scan stays reachable
     as A.scanCleanIPsEdge for the self-test and for a cold start */
  A.scanCleanIPs = scanCleanIPsV2;
  A.scanCleanIPsEdge = scanCleanIPsV1;

  /** TCP reachability test using the Workers socket API (already imported) */
  const connectPort = async (host, port, timeoutMs = 3000) => {
    try {
      const sock = connect({ hostname: host, port });
      const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs));
      await Promise.race([sock.opened, timer]);
      try { await sock.close(); } catch (e) { /* ignore */ }
      return true;
    } catch (e) { return false; }
  };

  /* ---------- per-request classification --------------------------------- */
  /**
   * Verdicts:
   *   tunnel   → the request is a legitimate carrier upgrade (or a known route)
   *   allow    → ordinary HTTP we serve normally
   *   tarpit   → automation/scanner: waste its time, log it, never hint
   *   ban      → repeat offender: reject before any work
   */
  A.classify = (request, ip) => {
    const ua = (request.headers.get('user-agent') || '').toLowerCase();
    const upgrade = (request.headers.get('upgrade') || '').toLowerCase() === 'websocket';
    const path = new URL(request.url).pathname.toLowerCase();

    const ipBanned = A.state.bannedIps.get(ip);
    if (ipBanned && ipBanned > Date.now()) return { action: 'ban', reason: 'repeat-offender' };
    if (ipBanned) A.state.bannedIps.delete(ip);

    const tunnelish = /^\/(ws|vless|tunnel|ss|ss-aead|shadowsocks|cdn|graphql|httpupgrade|xhttp|grpc|ed|vmess|trojan|hy2)/.test(path);
    if (upgrade) {
      A.state.telemetry.handshakes++;
      return { action: 'tunnel', reason: 'upgrade', transport: tunnelish ? path : 'unknown' };
    }
    if (tunnelish) return { action: 'tarpit', reason: 'tunnel-path-without-upgrade' };

    const scanner = !ua || /curl|wget|python|go-http|java|nikto|nmap|masscan|zgrab|sqlmap|nuclei|httpx|libwww|scrapy|okhttp/.test(ua);
    const attackPath = /\/(\.env|\.git|wp-|xmlrpc|phpmyadmin|admin\.php|shell|cgi-bin|boaform|HNAP1|GponForm|eval|actuator|console|solr|jenkins)/.test(path);
    if (attackPath) {
      A.state.telemetry.probes++;
      A.state.bannedIps.set(ip, Date.now() + 6 * 3600 * 1000);
      return { action: 'ban', reason: 'attack-path', path };
    }
    if (scanner && !/mozilla|chrome|safari|firefox/.test(ua)) {
      A.state.telemetry.probes++;
      return { action: 'tarpit', reason: 'automation-ua' };
    }
    const fakeBrowser = /mozilla|chrome|safari|firefox/.test(ua) && !request.headers.get('accept-language');
    if (fakeBrowser) { A.state.telemetry.probes++; return { action: 'tarpit', reason: 'browser-without-locale' }; }
    return { action: 'allow', reason: 'normal' };
  };

  A.onProbe = async (env, ctx, request, why) => {
    A.state.telemetry.probes++;
    const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
    const url = new URL(request.url);
    await QV.safeAsync(() => QV.d1.Events.log(env, {
      kind: 'probe', level: 'warn', ip, message: why || 'probe',
      meta: { path: url.pathname, ua: request.headers.get('user-agent') || '', country: request.headers.get('cf-ipcountry') },
    }));
    if (A.state.telemetry.probes % 10 === 0) QV.emit(env, 'attack:probe', 'warn', { ip, ctx, message: `probe #${A.state.telemetry.probes}: ${why}`, meta: { path: url.pathname } });
    await QV.safeAsync(() => QV.d1.Ip.cooldown(env, ip, 900));
    return true;
  };

  /* ---------- decorated public surface ---------------------------------- */
  /** fragmentProfile(env?, asn?, country?) — env-aware, D1-strategy-aware */
  A.fragmentProfile = (a, b, c) => {
    const isEnv = a && (a.__cfg || a.DB || a.ai || (a.__bindings));
    if (isEnv) {
      const strat = A.state.strategy || {};
      const carrier = A.activeCarrier(b, c);
      return {
        strategy: strat.shape || 'ws-tls',
        carrier: carrier.key,
        carrierName: carrier.name,
        fragment: strat.fragment || { mode: 'sni-split', size: 32, delayMs: 12, jitterMs: 25 },
        padding: strat.padding || { min: 16, max: 180, align: 16 },
        pacing: strat.pacing || { chunkBytes: 16384, delayMs: 0, adaptive: true },
        tls: strat.tls || { alpn: ['h2', 'http/1.1'] },
        rotation: strat.rotation || { sniEverySec: 900 },
        client_hint: 'v2rayNG/NekoBox: enable Fragment (mode: SNI split, length 32-64) · Hiddify: enable TLS fragmentation (1-3 packets, 10-20 ms delay) · Streisand: TLS fragment.',
      };
    }
    return baseFragmentProfile(a, b, c);
  };

  A.describe = () => ({ ...baseDescribe(), cleanIps: (A.state.cleanIps || []).slice(0, 8), strategy: A.state.strategy });

  /** strategy summary for dashboards */
  A.status = async (env) => {
    const s = await A.load(env);
    const pool = await QV.safeAsync(() => QV.d1.Sni.top(env, 100), []);
    return {
      strategy: s,
      telemetry: A.state.telemetry,
      sni: { total: pool.length, healthy: pool.filter(p => p.score > 0).length, top: pool.slice(0, 5).map(p => ({ sni: p.sni, score: Math.round(p.score) })) },
      bannedIps: A.state.bannedIps.size,
      cleanIps: (A.state.cleanIps || []).length,
    };
  };
})();
