/* ═══════════════════════════════════════════════════════════════════════════
 * A6 · DNS ENGINE — port 53 forwarding + NAT64/DNS64 + anti-poisoning
 * ═══════════════════════════════════════════════════════════════════════════
 *  Reality check, stated plainly so nothing here is a lie:
 *    · A Cloudflare Worker cannot bind UDP/53.  It terminates HTTPS/WebSocket
 *      only.  So "UDP DNS on port 53" is delivered three honest ways:
 *        1. DoH  : RFC 8484 endpoint  (GET ?dns=<b64url> / POST dns-message)
 *        2. DoT-ish / DNS-over-tunnel : raw DNS wire, 2-byte length prefixed,
 *                  carried inside the WebSocket tunnel → clients that speak
 *                  TCP/53 (dns2tcp, dnscat-style, iptables REDIRECT) work.
 *        3. DNS-over-SS-UDP : Shadowsocks UDP datagrams over the WS carrier.
 *    · NAT64/DNS64 synthesis is real and runs here, including prefix
 *      embedding/extraction per RFC 6052 and the well-known prefix
 *      64:ff9b::/96 + the "local use" prefix 64:ff9b:1::/48.
 *    · Anti-poisoning: Iranian resolvers get hijacked; responses whose A
 *      records land in known poison space (10.10.34.34, 0.0.0.0, loopback,
 *      or Iranian blackhole ranges) are treated as forged and re-resolved.
 * ═══════════════════════════════════════════════════════════════════════════ */
QV.dns = (() => {
  const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, OPT: 41, DS: 43, RRSIG: 46, DNSKEY: 48, NSEC: 47, HTTPS: 65, SVCB: 64, ANY: 255 };
  const TYPE_NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));
  const CLASS = { IN: 1, CH: 3, HS: 4, NONE: 254, ANY: 255 };
  const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };

  /* ───────────────────────── wire codec ───────────────────────────────── */
  const nameToWire = (name) => {
    const parts = String(name).replace(/\.$/, '').split('.').filter(Boolean);
    const out = [];
    for (const p of parts) {
      const b = QV.utf8(p);
      if (b.length > 63) throw new Error('label too long');
      out.push(b.length, ...b);
    }
    out.push(0);
    return new Uint8Array(out);
  };

  const readName = (buf, off) => {
    const labels = [];
    let jumped = false, origOff = off, guard = 0, cursor = off;
    for (;;) {
      if (guard++ > 128) throw new Error('dns name loop');
      const len = buf[cursor];
      if (len === undefined) throw new Error('dns name truncated');
      if (len === 0) { cursor++; break; }
      if ((len & 0xc0) === 0xc0) {                       // compression pointer
        const ptr = ((len & 0x3f) << 8) | buf[cursor + 1];
        if (!jumped) origOff = cursor + 2;
        cursor = ptr; jumped = true; continue;
      }
      labels.push(QV.dec.decode(buf.subarray(cursor + 1, cursor + 1 + len)));
      cursor += 1 + len;
    }
    return { name: labels.join('.'), next: jumped ? origOff : cursor };
  };

  const parseMessage = (buf) => {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const id = dv.getUint16(0);
    const flags = dv.getUint16(2);
    const qd = dv.getUint16(4), an = dv.getUint16(6), ns = dv.getUint16(8), ar = dv.getUint16(10);
    let off = 12;
    const questions = [];
    for (let i = 0; i < qd; i++) {
      const { name, next } = readName(buf, off); off = next;
      const type = dv.getUint16(off); const cls = dv.getUint16(off + 2); off += 4;
      questions.push({ name, type, class: cls });
    }
    const readRr = (count) => {
      const out = [];
      for (let i = 0; i < count; i++) {
        const { name, next } = readName(buf, off); off = next;
        const type = dv.getUint16(off), cls = dv.getUint16(off + 2), ttl = dv.getUint32(off + 4);
        const rdlen = dv.getUint16(off + 8); off += 10;
        const rdata = buf.subarray(off, off + rdlen);
        let value = null;
        try {
          if (type === TYPE.A && rdlen === 4) value = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
          else if (type === TYPE.AAAA && rdlen === 16) {
            const g = []; for (let k = 0; k < 8; k++) g.push(((rdata[k * 2] << 8) | rdata[k * 2 + 1]).toString(16));
            value = g.join(':');
          }
          else if (type === TYPE.CNAME || type === TYPE.NS || type === TYPE.PTR) value = readName(buf, off).name;
          else if (type === TYPE.TXT) {
            let p = 0, txt = '';
            while (p < rdlen) { const l = rdata[p]; txt += QV.dec.decode(rdata.subarray(p + 1, p + 1 + l)); p += 1 + l; }
            value = txt;
          }
          else if (type === TYPE.MX) value = { pref: dv.getUint16(off), host: readName(buf, off + 2).name };
          else if (type === TYPE.SRV) value = { prio: dv.getUint16(off), weight: dv.getUint16(off + 2), port: dv.getUint16(off + 4), target: readName(buf, off + 6).name };
          else if (type === TYPE.SOA) {
            const m = readName(buf, off); const r = readName(buf, m.next);
            value = { mname: m.name, rname: r.name };
          } else if (type === TYPE.OPT) value = { edns: true, udpSize: cls, extRcode: (ttl >> 24) & 0xff, version: (ttl >> 16) & 0xff, flags: ttl & 0xffff };
          else value = QV.b64.enc(rdata);
        } catch (e) { value = QV.b64.enc(rdata); }
        out.push({ name, type, typeName: TYPE_NAME[type] || String(type), class: cls, ttl, value, rdata });
        off += rdlen;
      }
      return out;
    };
    const answers = readRr(an);
    const authority = readRr(ns);
    const additional = readRr(ar);
    return {
      id,
      flags: {
        qr: (flags >> 15) & 1, opcode: (flags >> 11) & 0xf, aa: (flags >> 10) & 1, tc: (flags >> 9) & 1,
        rd: (flags >> 8) & 1, ra: (flags >> 7) & 1, ad: (flags >> 5) & 1, cd: (flags >> 4) & 1,
        rcode: flags & 0xf,
      },
      rcodeName: Object.keys(RCODE).find(k => RCODE[k] === (flags & 0xf)) || 'UNKNOWN',
      questions, answers, authority, additional,
      size: buf.length,
    };
  };

  const buildMessage = ({ id = QV.rand16(), flags = {}, questions = [], answers = [], authority = [], additional = [], edns = true }) => {
    const parts = [];
    const head = new Uint8Array(12);
    const dv = new DataView(head.buffer);
    dv.setUint16(0, id);
    const f = ((flags.qr ?? 0) << 15) | ((flags.opcode ?? 0) << 11) | ((flags.aa ?? 0) << 10) |
      ((flags.tc ?? 0) << 9) | ((flags.rd ?? 1) << 8) | ((flags.ra ?? 1) << 7) |
      ((flags.ad ?? 0) << 5) | ((flags.cd ?? 0) << 4) | (flags.rcode ?? 0);
    const extra = additional.filter(r => r.type !== TYPE.OPT);      // never duplicate OPT
    dv.setUint16(2, f);
    dv.setUint16(4, questions.length);
    dv.setUint16(6, answers.length);
    dv.setUint16(8, authority.length);
    dv.setUint16(10, extra.length + (edns ? 1 : 0));
    parts.push(head);

    for (const q of questions) {
      parts.push(nameToWire(q.name));
      const t = new Uint8Array(4);
      new DataView(t.buffer).setUint16(0, q.type); new DataView(t.buffer).setUint16(2, q.class || CLASS.IN);
      parts.push(t);
    }
    const encodeRr = (rr) => {
      const chunks = [nameToWire(rr.name)];
      let rdata;
      const type = rr.type;
      if (type === TYPE.A) rdata = new Uint8Array(rr.value.split('.').map(Number));
      else if (type === TYPE.AAAA) {
        /* expand :: notation fully */
        const [h, t] = rr.value.split('::');
        const head = h ? h.split(':').filter(Boolean) : [];
        const tail = t !== undefined ? (t ? t.split(':').filter(Boolean) : []) : [];
        const pad = new Array(8 - head.length - tail.length).fill('0');
        const groups = [...head, ...pad, ...tail].map(g => parseInt(g || '0', 16));
        rdata = new Uint8Array(16);
        groups.forEach((g, i) => { rdata[i * 2] = g >> 8; rdata[i * 2 + 1] = g & 0xff; });
      }
      else if (type === TYPE.CNAME || type === TYPE.NS || type === TYPE.PTR) rdata = nameToWire(rr.value);
      else if (type === TYPE.TXT) {
        const b = QV.utf8(rr.value);
        const chunksTxt = [];
        for (let i = 0; i < b.length; i += 255) { const s = b.subarray(i, Math.min(i + 255, b.length)); chunksTxt.push(s.length, ...s); }
        rdata = new Uint8Array(chunksTxt.length ? chunksTxt : [0]);
      }
      else if (type === TYPE.MX) rdata = QV.concat(new Uint8Array([rr.value.pref >> 8, rr.value.pref & 0xff]), nameToWire(rr.value.host));
      else if (type === TYPE.SRV) {
        const h = new Uint8Array(6);
        const d2 = new DataView(h.buffer);
        d2.setUint16(0, rr.value.prio); d2.setUint16(2, rr.value.weight); d2.setUint16(4, rr.value.port);
        rdata = QV.concat(h, nameToWire(rr.value.target));
      }
      else if (type === TYPE.OPT) rdata = rr.rdata instanceof Uint8Array ? rr.rdata : new Uint8Array(0);
      else rdata = rr.rdata instanceof Uint8Array ? rr.rdata : new Uint8Array(0);
      const meta = new Uint8Array(10);
      const dm = new DataView(meta.buffer);
      dm.setUint16(0, type); dm.setUint16(2, rr.class || CLASS.IN); dm.setUint32(4, rr.ttl ?? 300); dm.setUint16(8, rdata.length);
      chunks.push(meta, rdata);
      return QV.concat(...chunks);
    };
    for (const rr of [...answers, ...authority, ...extra]) parts.push(encodeRr(rr));
    if (edns) {
      const opt = new Uint8Array(11);
      const dv2 = new DataView(opt.buffer);
      opt[0] = 0;                              // root name
      dv2.setUint16(1, TYPE.OPT); dv2.setUint16(3, 1232); dv2.setUint32(5, 0); dv2.setUint16(9, 0);
      parts.push(opt);
    }
    return QV.concat(...parts);
  };

  /* ───────────────────────── NAT64 / DNS64 (RFC 6052, 6147) ───────────── */
  const NAT64_PREFIXES = [
    { name: 'well-known', prefix: '64:ff9b::', bits: 96 },
    { name: 'local-use', prefix: '64:ff9b:1::', bits: 96 },
    { name: 'cloudflare', prefix: '2606:4700:64::', bits: 96 },
    { name: 'v6-only-test', prefix: '2001:db8:122:344::', bits: 96 },
  ];

  const prefixToBytes = (prefix) => {
    const [h, t] = prefix.split('::');
    const head = h ? h.split(':').filter(Boolean) : [];
    const tail = t !== undefined ? (t ? t.split(':').filter(Boolean) : []) : [];
    const pad = new Array(8 - head.length - tail.length).fill('0');
    const groups = [...head, ...pad, ...tail].map(g => parseInt(g || '0', 16));
    const b = new Uint8Array(16);
    groups.forEach((g, i) => { b[i * 2] = g >> 8; b[i * 2 + 1] = g & 0xff; });
    return b;
  };
  const bytesToV6 = (b) => {
    const g = []; for (let i = 0; i < 8; i++) g.push(((b[i * 2] << 8) | b[i * 2 + 1]).toString(16));
    /* compress longest zero run for readability */
    let best = { i: -1, n: 0 }, cur = { i: -1, n: 0 };
    g.forEach((x, i) => {
      if (x === '0') { if (cur.i < 0) cur = { i, n: 1 }; else cur.n++; }
      else { if (cur.n > best.n) best = { ...cur }; cur = { i: -1, n: 0 }; }
    });
    if (cur.n > best.n) best = { ...cur };
    if (best.n > 1) return [...g.slice(0, best.i), '', ...g.slice(best.i + best.n)].join(':').replace(/^:|:$/g, (m, o, s) => (o === 0 ? ':' : ':'));
    return g.join(':');
  };
  const v4ToV6 = (ipv4, prefix = NAT64_PREFIXES[0].prefix) => {
    const out = prefixToBytes(prefix);
    const p = ipv4.split('.').map(Number);
    out[12] = p[0]; out[13] = p[1]; out[14] = p[2]; out[15] = p[3];
    return bytesToV6(out);
  };
  const v6ToV4 = (ipv6, prefixes = NAT64_PREFIXES.map(p => p.prefix)) => {
    const b = prefixToBytes(ipv6.includes('::') || !ipv6.endsWith(':') ? ipv6 : ipv6 + '');
    /* normalise through prefixToBytes for both compressed and full forms */
    for (const pf of prefixes) {
      const pb = prefixToBytes(pf);
      let match = true;
      for (let i = 0; i < 12; i++) if (pb[i] !== b[i]) { match = false; break; }
      if (match) return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
    }
    return null;
  };
  /** DNS64: synthesise AAAA records from A answers (RFC 6147) */
  /* `force` covers the operator-controlled case: a client that *wants* the
   *  NAT64 mapping (a gateway behind a 464XLAT setup, or ?dns64=1 on the API)
   *  gets synthesised AAAA records even when the upstream returned real ones.
   *  Without `force` the RFC 6147 rule stands: never synthesise when a real
   *  AAAA exists. */
  const synthesize = (msg, prefix = NAT64_PREFIXES[0].prefix, force = false) => {
    if (!msg.questions.some(q => q.type === TYPE.AAAA)) return null;
    const aRR = msg.answers.filter(a => a.type === TYPE.A);
    if (!aRR.length) return null;
    if (!force && msg.answers.some(a => a.type === TYPE.AAAA)) return null;
    const q = msg.questions.find(x => x.type === TYPE.AAAA);
    const answers = aRR.map(a => ({ name: a.name, type: TYPE.AAAA, ttl: Math.min(a.ttl, 600), class: CLASS.IN, value: v4ToV6(a.value, prefix), nat64: true, synthesizedFrom: a.value }));
    const rest = force ? msg.answers : msg.answers.filter(a => a.type !== TYPE.A);
    return { ...msg, flags: { ...msg.flags, aa: 0 }, answers: [...answers, ...rest], dns64: true, dns64_forced: !!force, prefix };
  };
  const nat64PrefixesFromEnv = (env) => {
    const extra = (env && env.NAT64_PREFIX) ? [env.NAT64_PREFIX] : [];
    const list = [...extra, ...NAT64_PREFIXES.map(p => p.prefix)];
    return [...new Set(list)];
  };
  /** resolve a tunnel target that may be NAT64-encoded back to a connectable IPv4 */
  const unwrapTarget = (host, prefixes) => {
    if (!host || !host.includes(':')) return { host, nat64: false };
    const v4 = v6ToV4(host, prefixes || NAT64_PREFIXES.map(p => p.prefix));
    return v4 ? { host: v4, nat64: true, original: host } : { host, nat64: false };
  };

  /* ───────────────────────── poisoning defence ────────────────────────── */
  const POISON_V4 = new Set(['0.0.0.0', '127.0.0.1', '10.10.34.34', '10.10.34.35', '10.10.34.36']);
  const POISON_CIDR = [
    [/^10\./, 'rfc1918'], [/^192\.168\./, 'rfc1918'], [/^172\.(1[6-9]|2\d|3[01])\./, 'rfc1918'],
    [/^169\.254\./, 'link-local'], [/^0\./, 'invalid'], [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'cgnat'],
  ];
  const isPoisoned = (msg, expected = []) => {
    const bad = [];
    for (const a of msg.answers) {
      if (a.type === TYPE.A) {
        if (POISON_V4.has(a.value)) bad.push({ ip: a.value, why: 'known-sinkhole' });
        else {
          for (const [re, why] of POISON_CIDR) if (re.test(a.value)) { bad.push({ ip: a.value, why }); break; }
        }
      }
    }
    /* heuristic: an A answer that is *not* routable for the tunnel is useless */
    const routable = msg.answers.filter(a => a.type === TYPE.A || a.type === TYPE.AAAA);
    return { poisoned: bad.length > 0, bad, routable: routable.length > 0, expected };
  };

  /* ───────────────────────── upstream forwarding ──────────────────────── */
  const UPSTREAMS = [
    { url: 'https://1.1.1.1/dns-query', name: 'cloudflare' },
    { url: 'https://dns.google/dns-query', name: 'google' },
    { url: 'https://9.9.9.9:5053/dns-query', name: 'quad9' },
    { url: 'https://doh.opendns.com/dns-query', name: 'opendns' },
    { url: 'https://dns.adguard-dns.com/dns-query', name: 'adguard' },
  ];
  const pickUpstreams = (env) => {
    const custom = (env && env.DOH_UPSTREAM) ? env.DOH_UPSTREAM.split(',').map(s => s.trim()).filter(Boolean).map(url => ({ url, name: 'custom' })) : [];
    return [...custom, ...UPSTREAMS];
  };

  const queryUpstream = async (url, wire, timeout = 5000) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
        body: wire, signal: ac.signal,
      });
      if (!res.ok) throw new Error('upstream http ' + res.status);
      const buf = new Uint8Array(await res.arrayBuffer());
      return parseMessage(buf);
    } finally { clearTimeout(t); }
  };

  /** race the first two upstreams, fall back through the rest, cache results */
  const resolve = async (env, ctx, wire, { useCache = true, synthesize64 = null, force64 = false } = {}) => {
    const msg = parseMessage(wire);
    const q = msg.questions[0];
    const cacheKey = q ? `dns:${q.name.toLowerCase()}:${q.type}` : null;
    if (useCache && cacheKey) {
      const hit = await QV.d1.Kv.get(env, cacheKey, null);
      if (hit && hit.wire) {
        const cached = parseMessage(QV.b64.dec(hit.wire));
        cached.id = msg.id; cached.cached = true;
        return { msg: cached, wire: buildMessage({ ...cached, id: msg.id }), source: 'cache' };
      }
    }
    const upstreams = pickUpstreams(env);
    let lastErr = null, result = null, source = null;
    /* two-lane race then sequential fallback */
    const lanes = [upstreams[0], upstreams[1]].filter(Boolean);
    try {
      result = await Promise.race(lanes.map(u => queryUpstream(u.url, wire).then(r => ({ r, u })))).then(x => { source = x.u.name; return x.r; });
    } catch (e) {
      lastErr = e;
      for (const u of upstreams.slice(2)) {
        try { result = await queryUpstream(u.url, wire); source = u.name; break; } catch (e2) { lastErr = e2; }
      }
    }
    if (!result) throw lastErr || new Error('all upstream resolvers failed');

    const poison = isPoisoned(result);
    if (poison.poisoned) {
      QV.log.warn('dns', 'poisoned answer detected, re-resolving', { name: q?.name, bad: poison.bad, source });
      for (const u of upstreams) {
        if (u.name === source) continue;
        try {
          const alt = await queryUpstream(u.url, wire);
          if (!isPoisoned(alt).poisoned) { result = alt; source = u.name + '+clean'; poison.poisoned = false; break; }
        } catch (e) { /* keep trying */ }
      }
      if (poison.poisoned) QV.emit(env, 'dns:poison', 'warn', { message: `all upstreams returned sinkholes for ${q?.name}`, ctx, meta: { bad: poison.bad } });
    }

    if (synthesize64) {
      /* RFC 6147 in full: when a client asks for AAAA and the upstream has no
         AAAA to give, a DNS64 resolver *re-queries for A* and maps those
         addresses into the NAT64 prefix.  Only then is synthesis meaningful —
         so do the follow-up query here instead of waiting for an A record that
         will never be in the AAAA answer. */
      const hasA = (result.answers || []).some(a => a.type === TYPE.A);
      const hasAAAA = (result.answers || []).some(a => a.type === TYPE.AAAA);
      const needsA = !hasA && !!(q && q.type === TYPE.AAAA) && (force64 || !hasAAAA);
      if (needsA) {
        const aQuery = buildMessage({ id: QV.rand16(), flags: { rd: 1 }, questions: [{ name: q.name, type: TYPE.A, class: CLASS.IN }] });
        for (const u of upstreams) {
          try {
            const aRes = await queryUpstream(u.url, aQuery);
            const aRR = (aRes.answers || []).filter(a => a.type === TYPE.A);
            if (aRR.length) {
              result = { ...result, answers: [...aRR, ...(result.answers || [])], synth_from: u.name };
              break;
            }
          } catch (e) { /* try the next upstream */ }
        }
      }
      const syn = synthesize(result, synthesize64, force64);
      if (syn) { result = syn; if (!source) source = 'dns64:' + (result.synth_from || source || 'local'); }
    }

    if (useCache && cacheKey) {
      const ttl = Math.min(300, Math.max(30, Math.min(...(result.answers.map(a => a.ttl || 60).concat([120])))));
      QV.safeAsync(() => QV.d1.Kv.set(env, cacheKey, { wire: QV.b64.enc(buildMessage({ ...result, id: 0 })) }, ttl));
    }
    return { msg: result, wire: buildMessage({ ...result, id: msg.id }), source, poison };
  };

  /* ───────────────────────── Workers entry: RFC 8484 ──────────────────── */
  const handleDohRequest = async (request, env, ctx) => {
    const url = new URL(request.url);
    let wire = null;
    if (request.method === 'GET') {
      const dns = url.searchParams.get('dns');
      if (!dns) return new Response('missing ?dns=', { status: 400 });
      wire = QV.b64.urlDec(dns.replace(/-/g, '+').replace(/_/g, '/'));
    } else if (request.method === 'POST') {
      wire = new Uint8Array(await request.arrayBuffer());
    } else if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    } else return new Response('method not allowed', { status: 405, headers: { allow: 'GET, POST' } });

    if (wire.length < 12) return new Response('bad dns message', { status: 400 });
    const nat64 = url.searchParams.get('nat64') !== '0';
    try {
      const { msg, wire: outWire, source } = await resolve(env, ctx, wire, { synthesize64: nat64 ? (env.NAT64_PREFIX || NAT64_PREFIXES[0].prefix) : null });
      const accept = request.headers.get('accept') || '';
      if (accept.includes('application/dns-json') || url.searchParams.get('ct') === 'json') {
        return new Response(JSON.stringify({
          Status: msg.flags.rcode, TC: msg.flags.tc, RD: msg.flags.rd, RA: msg.flags.ra, AD: msg.flags.ad,
          Question: msg.questions.map(q => ({ name: q.name, type: q.type })),
          Answer: msg.answers.map(a => ({ name: a.name, type: a.type, TTL: a.ttl, data: typeof a.value === 'string' ? a.value : JSON.stringify(a.value) })),
          Comment: `qv-dns upstream=${source} cached=${!!msg.cached} dns64=${!!msg.dns64} poison-guard=on`,
        }), { status: 200, headers: { ...cors(), 'content-type': 'application/dns-json' } });
      }
      const headers = { ...cors(), 'content-type': 'application/dns-message', 'cache-control': 'no-store' };
      headers['x-qv-upstream'] = source || 'unknown';
      if (msg.dns64) headers['x-qv-dns64'] = msg.prefix;
      return new Response(outWire, { status: 200, headers });
    } catch (e) {
      QV.log.error('dns', 'resolve failed', { err: e?.message });
      const q = (() => { try { return parseMessage(wire).questions[0]; } catch { return null; } })();
      const fail = buildMessage({ id: parseMessage(wire).id, flags: { qr: 1, rcode: RCODE.SERVFAIL }, questions: q ? [q] : [] });
      return new Response(fail, { status: 502, headers: { ...cors(), 'content-type': 'application/dns-message' } });
    }
  };

  /* ───────────────────────── 2-byte length framed DNS-over-tunnel ─────── */
  const frameTcp = (wire) => QV.concat(new Uint8Array([wire.length >> 8, wire.length & 0xff]), wire);
  const unframeTcp = (buf) => {
    const out = [];
    let off = 0;
    while (off + 2 <= buf.length) {
      const len = (buf[off] << 8) | buf[off + 1];
      if (off + 2 + len > buf.length) break;
      out.push(buf.subarray(off + 2, off + 2 + len));
      off += 2 + len;
    }
    return { messages: out, rest: buf.subarray(off) };
  };

  /** resolve a domain for the tunnel engines (clean-IP aware) */
  const resolveTarget = async (env, ctx, host, prefixes) => {
    const unwrapped = unwrapTarget(host, prefixes);
    if (unwrapped.nat64) return unwrapped;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { host, nat64: false };
    try {
      const wire = buildMessage({ id: QV.rand16(), flags: { rd: 1 }, questions: [{ name: host, type: TYPE.A, class: CLASS.IN }] });
      const { msg } = await resolve(env, ctx, wire, { useCache: true });
      const a = msg.answers.find(x => x.type === TYPE.A);
      if (a) return { host: a.value, nat64: false, resolvedFrom: host, ttl: a.ttl };
    } catch (e) { /* fall through */ }
    return { host, nat64: false, unresolved: true };
  };

  const cors = () => ({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, accept',
    'access-control-max-age': '86400',
  });

  return {
    TYPE, TYPE_NAME, CLASS, RCODE, NAT64_PREFIXES,
    parse: parseMessage, build: buildMessage, nameToWire, readName,
    v4ToV6, v6ToV4, synthesize, unwrapTarget, nat64PrefixesFromEnv,
    isPoisoned, resolve, resolveTarget, pickUpstreams, queryUpstream,
    handleDohRequest, frameTcp, unframeTcp, UPSTREAMS,
  };
})();
