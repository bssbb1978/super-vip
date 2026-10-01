/* ═══════════════════════════════════════════════════════════════════════════
 * A3 · ANTI-DPI ENGINE  (adaptive, AI-driven, self-learning)
 * ═══════════════════════════════════════════════════════════════════════════
 *  Layers of defence against Deep Packet Inspection + active probing:
 *
 *   1. SNI pool        — curated, AI-expanded, health-scored (D1 backed)
 *   2. IP pool          — clean-IP scanner results, scored, cooled-down
 *   3. Fingerprint      — per-session JA3-ish shaping of the TLS metadata we
 *                         influence (cipher order hints, ALPN, extension order,
 *                         session-ticket emission) delivered to the client
 *   4. Fragmentation    — client-side fragment profiles (SNI split, padding,
 *                         jitter) chosen per carrier/ASN, never static
 *   5. Active-probing   — detects replay/probe attempts, tarpits them and
 *                         rotates the edge profile automatically
 *   6. AI strategy      — every N minutes Workers-AI reviews live telemetry and
 *                         rewrites the active strategy (JSON), which is stored
 *                         in D1 and instantly consumed by the router
 *   7. Iran-specific    — TCI/Irancell/MCI ASN profiles, IR-DPI heuristics,
 *                         "clean IP" ranking and protocol fallbacks
 *      (Shadowsocks / WS / XHTTP / gRPC-ish transports are offered as
 *       alternate "shapes" so a single domain survives long-term blocking)
 */
QV.antidpi = (() => {
  /* ---------- curated SNI pools ----------------------------------------- */
  const sniPools = {
    default: [
      'www.cloudflare.com', 'cloudflare.com', 'dash.cloudflare.com', 'developers.cloudflare.com',
      'cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'unpkg.com', 'www.bing.com', 'www.microsoft.com',
      'www.apple.com', 'support.apple.com', 'www.samsung.com', 'www.nvidia.com', 'www.amd.com',
      'www.intel.com', 'www.dell.com', 'www.lenovo.com', 'www.hp.com', 'www.sony.com',
      'www.xbox.com', 'www.playstation.com', 'store.steampowered.com', 'www.epicgames.com',
      'www.riotgames.com', 'www.ubisoft.com', 'www.ea.com', 'www.rockstargames.com',
    ],
    ir: [ /* carrier portals that are never blocked inside Iran */
      'www.tci.ir', 'tci.ir', 'irancell.ir', 'www.mci.ir', 'mci.ir', 'www.shatel.ir',
      'www.aparat.com', 'www.digikala.com', 'www.torob.com', 'www.snapp.ir', 'www.cafebazaar.ir',
      'www.varzesh3.com', 'www.zoomit.ir', 'www.bankmellat.ir', 'www.shaparak.ir',
    ],
    gaming: ['www.epicgames.com', 'store.steampowered.com', 'www.riotgames.com', 'www.blizzard.com', 'account.riotgames.com'],
    cdn: ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'ajax.aspnetcdn.com', 'code.jquery.com', 'fonts.gstatic.com'],
    ai: ['chatgpt.com', 'www.perplexity.ai', 'claude.ai', 'gemini.google.com', 'developers.cloudflare.com'],
  };

  /* ---------- DPI/latency profiles per carrier (Iran focus) ------------- */
  const carriers = [
    { key: 'tci', name: 'TCI / مخابرات', asns: ['AS58224'], profile: { fragment: 'sni-split', mtu: 1250, jitter: [8, 60], pad: [20, 220], ttl: 64 } },
    { key: 'irancell', name: 'Irancell', asns: ['AS44244'], profile: { fragment: 'mid-split', mtu: 1300, jitter: [4, 40], pad: [10, 160], ttl: 128 } },
    { key: 'mci', name: 'MCI / همراه اول', asns: ['AS197207'], profile: { fragment: 'sni-split', mtu: 1280, jitter: [6, 50], pad: [16, 200], ttl: 64 } },
    { key: 'rightel', name: 'Rightel', asns: ['AS57218'], profile: { fragment: 'random', mtu: 1350, jitter: [3, 30], pad: [8, 120], ttl: 128 } },
    { key: 'shatel', name: 'Shatel / شاتل', asns: ['AS31549'], profile: { fragment: 'tls-record', mtu: 1400, jitter: [5, 45], pad: [12, 180], ttl: 64 } },
    { key: 'other', name: 'generic', asns: [], profile: { fragment: 'random', mtu: 1400, jitter: [2, 25], pad: [4, 90], ttl: 64 } },
  ];

  /* ---------- transport "shapes" (survive blocking of one pattern) ------- */
  const shapes = [
    { key: 'ws-tls', ranking: 100, note: 'WebSocket over TLS — default' },
    { key: 'grpc-tls', ranking: 96, note: 'gRPC-ish framing over TLS' },
    { key: 'xhttp', ranking: 94, note: 'streamed HTTP (chunked) split upload/download' },
    { key: 'httpupgrade', ranking: 92, note: 'HTTP Upgrade = websocket-like but distinct on the wire' },
    { key: 'ss-aead', ranking: 88, note: 'Shadowsocks AEAD 2022 (no TLS fingerprint to match)' },
    { key: 'quic-ish', ranking: 70, note: 'UDP-shaped fallback (experimental)' },
  ];

  /* ---------- default strategy (rewritten by AI) ------------------------ */
  const DEFAULT_STRATEGY = {
    version: 1,
    updated_at: 0,
    shape: 'ws-tls',
    sni_pool: 'default',
    ip_policy: 'clean-first',
    fragment: { mode: 'sni-split', size: 32, delayMs: 12, jitterMs: 25 },
    pacing: { chunkBytes: 16384, delayMs: 0, adaptive: true },
    padding: { min: 16, max: 180, align: 16 },
    tls: { alpn: ['h2', 'http/1.1'], minVersion: 'TLSv1.3', ticket: true, alpnHint: true },
    tarpit: { enabled: true, delayMs: 8000, for: ['probe', 'scan', 'replay'] },
    rotation: { sniEverySec: 900, ipEverySec: 1800, shapeEverySec: 3600 },
    iran: { preferDomesticSni: true, avoidPorts: [53, 80, 8080, 8443], preferTls13: true },
    reason: 'bootstrap default',
  };

  /* ---------- in-memory state ------------------------------------------- */
  const state = {
    strategy: { ...DEFAULT_STRATEGY },
    lastAiRun: 0,
    telemetry: { probes: 0, replays: 0, tlsResets: 0, handshakes: 0, blockedSnis: 0, since: Date.now() },
    bannedIps: new Map(),
    rotatedAt: { sni: 0, ip: 0, shape: 0 },
  };

  /* ---------- helpers ---------------------------------------------------- */
  const activeCarrier = (asn, country) => {
    if (country && country !== 'IR') return carriers[carriers.length - 1];
    const hit = carriers.find(c => asn && c.asns.includes(asn));
    return hit || carriers[carriers.length - 1];
  };

  const profileFor = (asn, country) => {
    const c = activeCarrier(asn, country);
    return { carrier: c.key, carrierName: c.name, ...c.profile, strategy: state.strategy.fragment };
  };

  const scoreSni = (sni) => {
    let s = 50;
    if (/\.ir$/i.test(sni)) s += 25;
    if (/^(www\.)?(tci|mci|irancell|shatel|aparat|digikala)\./i.test(sni)) s += 20;
    if (/cloudflare|jsdelivr|app|apple|microsoft|bing/i.test(sni)) s += 12;
    if (/google|gstatic|youtube/i.test(sni)) s -= 6;          // frequently SNI-filtered
    if (/telegram|t\.me/i.test(sni)) s -= 10;
    return QV.clamp(s, 0, 100);
  };

  const pickSni = async (env, opts = {}) => {
    const poolName = opts.pool || state.strategy.sni_pool;
    const pool = sniPools[poolName] || sniPools.default;
    /* prefer real telemetry from D1 when available */
    const dbTop = await QV.safeAsync(() => QV.d1.Sni.top(env, 25), []);
    const merged = [...new Set([...(dbTop || []).map(r => r.sni), ...pool, ...sniPools.ir])];
    const scored = merged
      .map(s => ({ sni: s, score: scoreSni(s) + (dbTop.find(r => r.sni === s)?.score || 0) * 0.2 }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const topN = scored.slice(0, Math.max(6, Math.ceil(scored.length * 0.25)));
    const chosen = QV.pick(topN.length ? topN : scored).sni;
    state.rotatedAt.sni = Date.now();
    return { sni: chosen, alternatives: scored.slice(0, 12).map(x => x.sni), pool: poolName };
  };

  /* ---------- probing / replay detection -------------------------------- */
  const isProbe = (request, ip) => {
    const ua = (request.headers.get('user-agent') || '').toLowerCase();
    const path = new URL(request.url).pathname;
    const looksLikeScanner =
      !ua || /curl|wget|python|go-http|nikto|nmap|masscan|zgrab|sqlmap|nuclei|zgrab2|httpx/.test(ua) ||
      /\/(\.env|\.git|wp-|phpmyadmin|admin\.php|shell|cgi-bin|boaform|HNAP1|GponForm)/i.test(path);
    const hasUpgrade = (request.headers.get('upgrade') || '').toLowerCase() === 'websocket';
    const accept = request.headers.get('accept') || '';
    /* a browser-shaped probe that never negotiates the upgrade is suspicious */
    const fakeBrowser = /mozilla|chrome|safari/i.test(ua) && !hasUpgrade && !accept.includes('text/html');
    const verdict = looksLikeScanner || fakeBrowser;
    if (verdict) { state.telemetry.probes++; if (ip) state.bannedIps.set(ip, Date.now() + 6 * 3600 * 1000); }
    return verdict;
  };

  const tarpit = async (ms) => {
    await QV.sleep(Math.min(ms || state.strategy.tarpit.delayMs, 15000));
    return new Response('<!doctype html><title>404</title><h1>Not Found</h1>', {
      status: 404, headers: { 'content-type': 'text/html', 'server': 'cloudflare', 'cache-control': 'no-store' },
    });
  };

  const markBlocked = async (env, sni) => {
    state.telemetry.blockedSnis++;
    await QV.safeAsync(() => QV.d1.Sni.block(env, sni));
    QV.log.warn('antidpi', `SNI blocked upstream, quarantined: ${sni}`);
  };

  /* ---------- fragmentation profiles ------------------------------------ */
  const fragmentProfile = (asn, country, seedInput = '') => {
    const p = profileFor(asn, country);
    const jitter = QV.clamp(Math.floor(Math.random() * p.jitter[1]) + p.jitter[0], 1, 250);
    const pad = QV.clamp(Math.floor(Math.random() * p.pad[1]) + p.pad[0], 0, 900);
    const size = QV.clamp(p.mtu - Math.floor(Math.random() * 120), 64, 1500);
    return {
      carrier: p.carrierName, mode: p.fragment, mtu: p.mtu, splitSize: size,
      delayMs: jitter, padding: pad, ttl: p.ttl,
      payload: `#frag=${p.fragment}&s=${size}&d=${jitter}&p=${pad}&ttl=${p.ttl}`,
      strategy: state.strategy.fragment,
    };
  };

  /* ---------- strategy validation (never trust the model's JSON) ---------- */
  const FRAG_MODES = new Set(['sni-split', 'mid-split', 'tls-record', 'random', 'none']);
  const clampInt = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  };
  const shapeKeys = () => new Set(shapes.map(x => x.key));
  const poolKeys = () => new Set(Object.keys(sniPools));

  /**
   * The model returns text; this turns it into a *bounded* strategy.  Shape and
   * pool are allow-listed, every number is clamped to a range a real client can
   * follow, strings are stripped of control characters, and anything unknown is
   * dropped rather than merged — a hallucinated `padding.max = 10**9` or a
   * `shape` that does not exist can therefore never reach the wire.
   */
  const sanitizeStrategy = (raw, base = DEFAULT_STRATEGY) => {
    const out = { ...DEFAULT_STRATEGY, ...(base || {}) };
    const r = (raw && typeof raw === 'object') ? raw : {};
    if (typeof r.shape === 'string' && shapeKeys().has(r.shape)) out.shape = r.shape;
    if (typeof r.sni_pool === 'string' && poolKeys().has(r.sni_pool)) out.sni_pool = r.sni_pool;
    const f = (r.fragment && typeof r.fragment === 'object') ? r.fragment : null;
    if (f) {
      const cur = out.fragment || DEFAULT_STRATEGY.fragment || {};
      out.fragment = {
        ...cur,
        mode: (typeof f.mode === 'string' && FRAG_MODES.has(f.mode)) ? f.mode : (cur.mode || 'sni-split'),
        size: clampInt(f.size, 8, 1200, cur.size ?? 32),
        delayMs: clampInt(f.delayMs ?? f.interval, 0, 250, cur.delayMs ?? 12),
        jitterMs: clampInt(f.jitterMs, 0, 250, cur.jitterMs ?? 25),
      };
    }
    if (r.pacing && typeof r.pacing === 'object') {
      const cur = out.pacing || {};
      out.pacing = { chunkBytes: clampInt(r.pacing.chunkBytes, 512, 65536, cur.chunkBytes ?? 16384),
        delayMs: clampInt(r.pacing.delayMs, 0, 200, cur.delayMs ?? 0),
        adaptive: typeof r.pacing.adaptive === 'boolean' ? r.pacing.adaptive : (cur.adaptive !== false) };
    }
    if (r.padding && typeof r.padding === 'object') {
      const cur = out.padding || {};
      const min = clampInt(r.padding.min, 0, 900, cur.min ?? 16);
      const max = clampInt(r.padding.max, min, 900, Math.max(min, cur.max ?? 180));
      const align = [1, 2, 4, 8, 16, 32].includes(Number(r.padding.align)) ? Number(r.padding.align) : (cur.align || 16);
      out.padding = { min, max, align };
    }
    if (r.tarpit && typeof r.tarpit === 'object') {
      const cur = out.tarpit || {};
      out.tarpit = { enabled: typeof r.tarpit.enabled === 'boolean' ? r.tarpit.enabled : (cur.enabled !== false),
        delayMs: clampInt(r.tarpit.delayMs, 200, 15000, cur.delayMs ?? 1500),
        for: Array.isArray(r.tarpit.for) ? r.tarpit.for.filter(x => ['probe', 'scan', 'replay'].includes(x)).slice(0, 4) : (cur.for || ['probe', 'scan', 'replay']) };
    }
    if (r.rotation && typeof r.rotation === 'object') {
      const cur = out.rotation || {};
      out.rotation = {
        sniEverySec: clampInt(r.rotation.sniEverySec, 60, 86400, cur.sniEverySec ?? 900),
        ipEverySec: clampInt(r.rotation.ipEverySec, 60, 86400, cur.ipEverySec ?? 900),
        shapeEverySec: clampInt(r.rotation.shapeEverySec, 60, 86400, cur.shapeEverySec ?? 3600),
      };
    }
    if (r.iran && typeof r.iran === 'object') {
      out.iran = { preferDomesticSni: typeof r.iran.preferDomesticSni === 'boolean' ? r.iran.preferDomesticSni : true,
        preferTls13: typeof r.iran.preferTls13 === 'boolean' ? r.iran.preferTls13 : true };
    }
    if (typeof r.reason === 'string') out.reason = r.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
    return out;
  };

  /**
   * Deterministic fallback: no AI binding, a timeout, or a rejected answer all
   * land here.  The decision is a fixed function of *measured* numbers (the
   * per-ASN rows the clean-endpoint engine wrote), so the same telemetry always
   * produces the same strategy — no randomness, no external call.
   */
  const heuristicStrategy = async (env, base = DEFAULT_STRATEGY, now = Date.now()) => {
    const rows = await QV.safeAsync(() => QV.d1.all(env,
      'SELECT family, samples, ok, tls_ok, ws_ok, state FROM qv_ip_scores WHERE scope LIKE ? ORDER BY samples DESC LIMIT 200', 'asn:%'), []) || [];
    const agg = rows.reduce((a, r) => {
      a.s += r.samples || 0; a.ok += r.ok || 0; a.tls += r.tls_ok || 0; a.ws += r.ws_ok || 0;
      if (r.state === 'quarantine') a.quar++;
      return a;
    }, { s: 0, ok: 0, tls: 0, ws: 0, quar: 0 });
    const rate = (n, d) => (d ? n / d : null);
    const okRate = rate(agg.ok, agg.s), wsRate = rate(agg.ws, agg.s);
    const next = sanitizeStrategy(base, base);
    if (agg.s >= 20 && wsRate !== null && wsRate < 0.5) {
      /* the end-to-end upgrade is what fails: change the shape and fragment
         later in the record rather than the ClientHello */
      next.shape = 'httpupgrade';
      next.fragment = { ...(next.fragment || {}), mode: 'tls-record', size: 64, delayMs: 20, jitterMs: 40 };
      next.padding = { min: 32, max: 320, align: 16 };
    } else if (agg.s >= 20 && okRate !== null && okRate < 0.6) {
      next.shape = 'xhttp';
      next.fragment = { ...(next.fragment || {}), mode: 'mid-split', size: 40, delayMs: 16, jitterMs: 30 };
    } else {
      next.shape = next.shape || 'ws-tls';
      next.fragment = { ...(next.fragment || {}), mode: 'sni-split', size: 32, delayMs: 12, jitterMs: 25 };
    }
    next.rotation = { ...(next.rotation || {}), sniEverySec: agg.quar > 5 ? 300 : 900, ipEverySec: agg.quar > 5 ? 300 : 900 };
    next.version = (base && base.version ? base.version : 0) + 1;
    next.updated_at = now;
    next.source = 'heuristic';
    next.model = null;
    next.reason = 'measured: n=' + Math.round(agg.s) + ' ok=' + (okRate === null ? 'n/a' : Math.round(okRate * 100) + '%') +
      ' ws=' + (wsRate === null ? 'n/a' : Math.round(wsRate * 100) + '%') + ' quarantined=' + agg.quar;
    return next;
  };

  /* ---------- the AI loop ------------------------------------------------ */
  const analyse = async (env, ctx) => {
    if (!env?.AI) {
      /* no binding is a normal state, not an error: the deterministic
         heuristic still produces a strategy from measured data */
      const h = await heuristicStrategy(env, state.strategy);
      state.strategy = h; state.lastAiRun = Date.now();
      await QV.safeAsync(() => QV.d1.Kv.put(env, 'qv:strategy', h, 0), null);
      await recordStrategy(env, h, await measuredRate(env), { source: 'heuristic', reason: 'no AI binding' });
      QV.count('ci_strategy_heuristic');
      return { ok: true, strategy: h, model: null, source: 'heuristic', reason: 'no AI binding' };
    }
    const since = state.telemetry.since;
    const events = await QV.safeAsync(() => QV.d1.all(env,
      `SELECT kind, COUNT(*) c FROM qv_events WHERE ts > ? GROUP BY kind ORDER BY c DESC LIMIT 20`, Math.floor(since / 1000)), []);
    const active = await QV.safeAsync(() => QV.d1.one(env, `SELECT COUNT(*) c FROM qv_sessions WHERE closed = 0 AND last_alive > unixepoch() - 300`), { c: 0 });
    const prompt = `You are the adaptive anti-DPI strategist of an Iran-focused edge network.
Live telemetry (last window): ${JSON.stringify({ ...state.telemetry, activeSessions: active?.c || 0, eventMix: events })}
Current strategy: ${JSON.stringify(state.strategy)}
Available transport shapes: ${shapes.map(s => s.key).join(', ')}
Available SNI pools: ${Object.keys(sniPools).join(', ')}
Constraints: never suggest illegal content, never suggest attacking third parties, keep ports/transport inside the list above.
Return JSON with keys: shape, sni_pool, fragment{mode,size,delayMs,jitterMs}, pacing{chunkBytes,delayMs,adaptive}, padding{min,max,align}, tarpit{enabled,delayMs}, rotation{sniEverySec,ipEverySec,shapeEverySec}, iran{preferDomesticSni,preferTls13}, reason (max 12 words).`;
    const res = await QV.ai.json(env, prompt, { kind: 'reasoning', maxTokens: 700 });
    if (!res.ok || !res.data || typeof res.data !== 'object') {
      const h = await heuristicStrategy(env, state.strategy);
      state.strategy = h; state.lastAiRun = Date.now();
      await QV.safeAsync(() => QV.d1.Kv.put(env, 'qv:strategy', h, 0), null);
      await recordStrategy(env, h, await measuredRate(env), { source: 'heuristic', reason: res.error || 'ai-unusable' });
      QV.count('ci_strategy_heuristic');
      return { ok: true, strategy: h, model: null, source: 'heuristic', reason: res.error || 'ai-unusable' };
    }
    /* the model's JSON is a suggestion, never a command: allow-listed and
       clamped before it can change a single byte on the wire */
    const next = {
      ...sanitizeStrategy(res.data, state.strategy),
      version: (state.strategy.version || 0) + 1,
      updated_at: Date.now(), model: res.model, source: 'ai',
    };
    state.strategy = next;
    state.lastAiRun = Date.now();
    await QV.d1.Kv.put(env, 'qv:strategy', next, 0);
    await QV.d1.run(env, 'INSERT INTO qv_ai_log (model,task,ms,ok,prompt,answer) VALUES (?,?,?,?,?,?)',
      res.model, 'antidpi:strategy', res.ms || 0, 1, prompt.slice(0, 4000), JSON.stringify(res.data).slice(0, 4000));
    await recordStrategy(env, next, await measuredRate(env), { source: 'ai', reason: next.reason });
    QV.emit(env, 'ai:strategy', 'info', { message: `strategy v${next.version}: ${next.reason || ''}`, meta: { shape: next.shape, sni_pool: next.sni_pool } });
    return { ok: true, strategy: next, model: res.model };
  };

  /**
   * Strategy history + automatic rollback (feature F).
   *
   * Every applied strategy is recorded with the *measured* success ratio at the
   * moment it was applied.  `evaluateStrategy()` is the outcome half: if the
   * global ratio has since dropped by more than ROLLBACK_DROP with a meaningful
   * sample count, the previous entry is restored and the failure is logged.
   * Bounded: history ≤8 entries, written once per apply; the evaluation runs at
   * most every 30 minutes (one KV write).
   */
  const ROLLBACK_DROP = 0.15, ROLLBACK_MIN_SAMPLES = 40, EVAL_EVERY_MS = 30 * 60 * 1000;
  let lastEval = 0;

  const measuredRate = async (env) => {
    const row = await QV.safeAsync(() => QV.d1.one(env,
      'SELECT SUM(samples) s, SUM(ok) o FROM qv_ip_scores WHERE family <> ? AND samples > 0', 'host'), null);
    if (!row) return null;
    const s = Number(row.s || 0), o = Number(row.o || 0);
    return s > 0 ? { samples: s, ok: o, rate: o / s } : null;
  };

  const recordStrategy = async (env, strat, rate, extra = {}) => {
    const hist = (await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:strategy:hist', []), [])) || [];
    const entry = {
      v: strat.version || null, source: strat.source || extra.source || 'unknown',
      at: Date.now(), shape: strat.shape, fragment: strat.fragment ? strat.fragment.mode : null,
      baseline: rate ? { samples: rate.samples, ok: rate.ok, rate: Math.round(rate.rate * 1000) / 1000 } : null,
      reason: strat.reason || extra.reason || null,
    };
    const next = [...hist, entry].slice(-8);
    const written = await QV.safeAsync(() => QV.d1.Kv.put(env, 'qv:strategy:hist', next, 0), null);
    if (written === null && QV.cleanip && QV.cleanip.degradedSnapshot) QV.count('ci_strategy_hist_fail');
    return next;
  };

  const evaluateStrategy = async (env, ctx, opts = {}) => {
    const now = Date.now();
    if (!opts.force && now - lastEval < EVAL_EVERY_MS) return { ok: true, skipped: 'recent' };
    lastEval = now;
    const hist = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:strategy:hist', []), null);
    if (!Array.isArray(hist) || hist.length < 2) return { ok: true, skipped: 'no-history' };
    const rate = await measuredRate(env);
    if (!rate) return { ok: true, skipped: 'no-measurement' };
    const last = hist[hist.length - 1], prev = hist[hist.length - 2];
    if (!last.baseline) return { ok: true, skipped: 'no-baseline' };
    const since = Math.max(0, rate.samples - last.baseline.samples);
    if (since < ROLLBACK_MIN_SAMPLES) return { ok: true, skipped: 'thin-evidence', since };
    if (!(rate.rate < last.baseline.rate - ROLLBACK_DROP)) {
      return { ok: true, verdict: 'kept', rate: Math.round(rate.rate * 1000) / 1000, since };
    }
    /* roll back to the previous strategy — through the same sanitizer, so a
       restored value is clamped exactly like a fresh proposal */
    const restored = sanitizeStrategy(prev, DEFAULT_STRATEGY);
    restored.version = (state.strategy.version || 0) + 1;
    restored.updated_at = Date.now();
    restored.source = 'rollback';
    restored.model = null;
    restored.reason = 'rolled back from v' + (last.v || '?') + ': success ' +
      Math.round(rate.rate * 1000) / 1000 + ' < baseline ' + last.baseline.rate;
    state.strategy = restored;
    await QV.safeAsync(() => QV.d1.Kv.put(env, 'qv:strategy', restored, 0), null);
    await recordStrategy(env, restored, rate, { source: 'rollback', reason: restored.reason });
    QV.count('ci_strategy_rollback', 1);
    QV.emit(env, 'ai:strategy', 'warn', { message: restored.reason, meta: { from: last.v, rate: rate.rate, baseline: last.baseline.rate } });
    return { ok: true, verdict: 'rolled-back', to: restored.version, rate: Math.round(rate.rate * 1000) / 1000, baseline: last.baseline.rate, since };
  };

  const load = async (env) => {
    const saved = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:strategy', null), null);
    /* whatever is in storage is re-sanitised on the way in: a strategy written
       by an older build (or by hand) cannot inject an out-of-range value */
    if (saved && typeof saved === 'object') state.strategy = sanitizeStrategy(saved, DEFAULT_STRATEGY);
    return state.strategy;
  };

  /* ---------- public rendering used by the panels ----------------------- */
  const describe = () => ({
    strategy: state.strategy,
    carrierProfiles: carriers.map(c => ({ key: c.key, name: c.name, asns: c.asns })),
    shapes,
    sniPools: Object.fromEntries(Object.entries(sniPools).map(([k, v]) => [k, v.length])),
    telemetry: state.telemetry,
    bannedIps: state.bannedIps.size,
  });

  return { sniPools, carriers, shapes, DEFAULT_STRATEGY, state, isProbe, tarpit, pickSni, scoreSni,
    fragmentProfile, profileFor, analyse, load, describe, markBlocked, activeCarrier,
    sanitizeStrategy, heuristicStrategy, FRAG_MODES, evaluateStrategy, recordStrategy, measuredRate,
    ROLLBACK_DROP, ROLLBACK_MIN_SAMPLES };
})();
