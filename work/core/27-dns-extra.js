/* ═══════════════════════════════════════════════════════════════════════════
 * A3d · DNS SERVICE SURFACE — DoH, JSON API, tunneled DNS, NAT64 gateway
 * ═══════════════════════════════════════════════════════════════════════════
 *  Cloudflare Workers cannot listen on UDP/53 or TCP/53 — that port simply
 *  does not exist in the runtime.  What *is* possible, and what this file
 *  implements, is every equivalent that clients actually support:
 *
 *   /dns-query        RFC 8484 DoH  (GET ?dns=<base64url>, POST wire) — the
 *                     native mechanism in Firefox/Chrome/Android Private DNS,
 *                     AdGuard, sing-box, Clash and dnsproxy.  Port 443, so it
 *                     survives DNS-port filtering.
 *   /dns/tcp          DNS-over-HTTP tunnel with 2-byte length framing: point
 *                     a client's "DNS over TCP" at it through the tunnel and
 *                     it behaves like a resolver on a private port.
 *   /dns/json         the JSON shape (Google/Cloudflare style) used by the
 *                     console and by the bot
 *   ?nat64=1          DNS64 synthesis (RFC 6147) with the 64:ff9b::/96 prefix
 *   NAT64 gateway     v4↔v6 translation for the tunnel engines, so an IPv6-only
 *                     client can reach IPv4 origins (and the other way round)
 * ═══════════════════════════════════════════════════════════════════════════ */
(function dnsExtra() {
  const D = QV.dns;
  const json = (data, status = 200) => new Response(JSON.stringify(data, null, 1), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  });

  const typeOf = (t) => D.TYPE[String(t || 'A').toUpperCase()] ?? (Number(t) || 1);

  /* ── adapters so the router can call uniform signatures ───────────────── */
  const handleDoh = async (c, allowJson) => {
    const res = await D.handleDohRequest(c.request, c.env, c.ctx);
    /* the console asks for JSON with ?format=json even without the accept header */
    if (allowJson && c.url && c.url.searchParams.get('format') === 'json' && (res.headers.get('content-type') || '').includes('dns-message')) {
      const wire = new Uint8Array(await res.arrayBuffer());
      const msg = D.parse(wire);
      return json({
        Status: msg.flags.rcode, TC: msg.flags.tc, RD: msg.flags.rd, RA: msg.flags.ra,
        Question: msg.questions, Answer: msg.answers,
        Authority: msg.authority || [], Additional: (msg.additional || []).filter(r => r.type !== D.TYPE.OPT),
        Comment: 'quantum-veil dog',
      }, res.status);
    }
    return res;
  };

  /** DNS over the HTTP tunnel — accepts raw wire or 2-byte length framing */
  const handleTcpOverTunnel = async (c) => {
    const url = c.url;
    if (c.request.method === 'GET' && url.searchParams.get('dns')) {
      const wire = QV.b64.unurl(url.searchParams.get('dns'));
      const out = await resolveWire(c.env, c.ctx, wire, { nat64: url.searchParams.get('nat64') !== '0' });
      return new Response(D.frameTcp(out), {
        headers: { 'content-type': 'application/dns-message', 'cache-control': 'no-store', 'x-qv-transport': 'http-tunnel-framed' },
      });
    }
    if (c.request.method !== 'POST') return json({ ok: false, error: 'GET with ?dns= or POST a DNS message' }, 405);
    const body = new Uint8Array(await c.request.arrayBuffer());
    if (!body.length) return json({ ok: false, error: 'empty body' }, 400);

    /* a framed payload starts with a length that matches the rest of the body */
    const parts = [];
    const framelen = body.length >= 2 ? (body[0] << 8 | body[1]) : -1;
    if (framelen === body.length - 2) parts.push(body.subarray(2));
    else parts.push(...D.unframeTcp(body).messages);

    const nat64 = c.url.searchParams.get('nat64') !== '0';
    const outs = [];
    for (const p of parts) {
      if (p.length < 12) continue;
      outs.push(await resolveWire(c.env, c.ctx, p, { nat64 }));
    }
    const framed = QV.concat(...outs.map(o => D.frameTcp(o)));
    return new Response(framed, {
      headers: { 'content-type': 'application/dns-message', 'cache-control': 'no-store', 'x-qv-transport': 'http-tunnel' },
    });
  };

  const resolveWire = async (env, ctx, wire, { nat64 = true, useCache = true } = {}) => {
    const prefix = nat64 ? (env && env.NAT64_PREFIX) || D.NAT64_PREFIXES[0].prefix : null;
    const id = (wire[0] << 8) | wire[1];
    try {
      const { msg, wire: outWire } = await D.resolve(env, ctx, wire, { useCache, synthesize64: prefix });
      return outWire;
    } catch (e) {
      const q = (() => { try { return D.parse(wire).questions[0]; } catch (err) { return null; } })();
      return D.build({ id, flags: { qr: 1, rcode: D.RCODE.SERVFAIL, rd: 1, ra: 1 }, questions: q ? [q] : [] });
    }
  };

  /* ────────────────────────── JSON query API ──────────────────────────── */
  const jsonQuery = async (env, ctx, name, type = 'A', wantDns64 = false, force64 = false) => {
    const t0 = Date.now();
    const clean = String(name).trim().replace(/\.$/, '');
    if (!clean || clean.length > 253) return { ok: false, error: 'invalid name' };
    const q = { name: clean, type: typeOf(type), class: 1 };
    const wire = D.build({ id: QV.rand16(), flags: { rd: 1 }, questions: [q] });
    try {
      const prefix = wantDns64 ? ((env && env.NAT64_PREFIX) || D.NAT64_PREFIXES[0].prefix) : null;
      const { msg, source } = await D.resolve(env, ctx, wire, { synthesize64: prefix, force64: !!(wantDns64 && force64) });
      const answers = (msg.answers || [])
        .filter(a => a.type !== D.TYPE.OPT)
        .map(a => ({ name: a.name, type: D.TYPE_NAME[a.type] || a.type, type_id: a.type, ttl: a.ttl, value: a.value }));
      return {
        ok: true, name: clean, type: D.TYPE_NAME[q.type] || q.type, status: msg.flags.rcode,
        status_text: Object.keys(D.RCODE).find(k => D.RCODE[k] === msg.flags.rcode) || 'UNKNOWN',
        answers, authority: msg.authority || [],
        source, cached: !!msg.cached, dns64: !!msg.dns64, dns64_forced: !!msg.dns64_forced, prefix: msg.prefix || null, ms: Date.now() - t0,
        nat64_hint: answers.filter(a => a.type === 'A').map(a => {
          try { return D.v4ToV6(a.value, (env && env.NAT64_PREFIX) || D.NAT64_PREFIXES[0].prefix); } catch (e) { return null; }
        }).filter(Boolean),
      };
    } catch (e) {
      return { ok: false, error: e?.message || 'resolution failed', name: clean, type: String(type), ms: Date.now() - t0 };
    }
  };

  /* ────────────────────────── cache maintenance ───────────────────────── */
  const stats = async (env) => {
    /* d1.one() reports "no row" as null instead of throwing, so the fallback of
       safeAsync never engages — guard the value itself */
    const row = (await QV.safeAsync(() => QV.d1.one(env, `SELECT COUNT(*) AS n FROM qv_kv WHERE key LIKE 'dns:%'`), null)) || { n: 0 };
    const hits = (await QV.safeAsync(() => QV.d1.one(env, `SELECT COUNT(*) AS n FROM qv_dns_log WHERE ts > ?`, Math.floor(Date.now() / 1000) - 86400), null)) || { n: 0 };
    return {
      cached: row.n || 0, queries_24h: hits.n || 0,
      nat64: D.NAT64_PREFIXES.map(p => ({ name: p.name, prefix: p.prefix, bits: p.bits, cidr: p.prefix + '/' + p.bits })),
      upstreams: D.UPSTREAMS.map(u => ({ name: u.name, url: u.url, kind: u.kind || 'doh' })),
      poison_guard: { cidrs: D.NAT64_PREFIXES.length ? 'on' : 'off', sinks: '0.0.0.0, 127.0.0.1, 10.10.34.x' },
      doh_endpoint: '/dns-query',
      formats: ['application/dns-message (RFC 8484)', 'application/dns-json', 'wrapped-tls/1', 'http-tunnel framed'],
      tcp53_available: false,
      tcp53_note: 'the Workers runtime exposes no UDP/53 or TCP/53 socket; use DoH, or point the client DNS-over-TCP at /dns/tcp through the tunnel',
    };
  };

  const flush = async (env) => {
    const r = await QV.safeAsync(() => QV.d1.run(env, `DELETE FROM qv_kv WHERE key LIKE 'dns:%' OR key LIKE 'qv:dns:%'`), { changes: 0 });
    return r?.changes || 0;
  };

  const sweepCache = async (env) => {
    const r = await QV.safeAsync(() => QV.d1.run(env, `DELETE FROM qv_kv WHERE key LIKE 'dns:%' AND expires_at > 0 AND expires_at < ?`, Math.floor(Date.now() / 1000)), { changes: 0 });
    return { removed: r?.changes || 0 };
  };

  const warm = async (env, ctx, names = []) => {
    const list = (names && names.length ? names : ['cloudflare.com', 'www.google.com', 'github.com', 'www.cloudflare.com', 'api.telegram.org', 'developers.cloudflare.com']);
    let ok = 0;
    for (const n of list.slice(0, 24)) {
      for (const t of ['A', 'AAAA']) {
        const r = await jsonQuery(env, ctx, n, t, t === 'AAAA');
        if (r.ok) ok++;
      }
    }
    QV.log.info('dns', 'cache warmed', { names: list.length, queries: ok });
    return ok;
  };

  /* ─────────────────── NAT64 gateway for the tunnel engines ───────────── */
  const nat64 = {
    prefixes: D.NAT64_PREFIXES,
    /** text form: "2a00:1450::" → { host, port } reachable through the tunnel */
    toV6: (v4, prefix) => D.v4ToV6(v4, prefix),
    toV4: (v6, prefixes) => D.v6ToV4(v6, prefixes),
    /** used by the SS/VLESS engines: turn a NAT64 address into a real target */
    unwrap: (host, prefixes) => D.unwrapTarget(host, prefixes),
    /** RFC 6052 §2.2 embedding/extraction, exposed for tests and the console */
    embed: (v4, prefix) => D.v4ToV6(v4, prefix),
    extract: (v6) => D.v6ToV4(v6),
    prefixesFromEnv: (env) => D.nat64PrefixesFromEnv(env),
  };

  const dns64 = {
    synthesize: (msg, question, prefix) => {
      const out = D.synthesize(msg, prefix || D.NAT64_PREFIXES[0].prefix);
      void question;
      return out;
    },
    /** true when a question can be served with synthesized AAAA records */
    applies: (question, msg) => question && question.type === D.TYPE.AAAA && !(msg.answers || []).some(a => a.type === D.TYPE.AAAA) && (msg.answers || []).some(a => a.type === D.TYPE.A),
  };

  const logQuery = async (env, q, source, ms) => QV.safeAsync(() => QV.d1.run(env,
    `INSERT INTO qv_dns_log (name, type, source, ms, ts) VALUES (?, ?, ?, ?, ?)`,
    q.name, q.type, source, ms, Math.floor(Date.now() / 1000)));

  Object.assign(QV.dns, {
    handleDoh, handleTcpOverTunnel, jsonQuery, stats, flush, sweepCache, warm,
    nat64, dns64, resolveWire, typeOf, logQuery,
    /** anything that looks like a DNS-over-HTTPS request goes to the codec */
    looksLikeDoh: (request) => /application\/dns-message/i.test(request.headers.get('accept') || '') ||
      (request.method === 'POST' && /application\/dns-message/i.test(request.headers.get('content-type') || '')),
  });
})();
