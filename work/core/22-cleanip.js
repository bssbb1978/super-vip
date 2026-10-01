/* ═══════════════════════════════════════════════════════════════════════════
 * A5 · CLEAN-ENDPOINT ENGINE  (crowd-sourced, multi-provider, dual-stack)
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS REPLACES
 *    The old scan (14-antidpi-ext.js · scanCleanIPs) measured four static
 *    Cloudflare IPv4 ranges, from the Cloudflare edge, over TCP :443 only,
 *    every hour, with a fixed constant score.  That signal cannot see what an
 *    Iranian ISP does with an address: the edge's route to Cloudflare is not
 *    the subscriber's route to Cloudflare.
 *
 *  WHAT THIS DOES
 *    The measurement that matters is taken *from the subscriber's network*.
 *    Every subscription page ships a small prober; the browser of a real user
 *    on a real ISP tests the batch of candidates the server handed out and
 *    posts a compact, signed report back.  The edge probe still exists, but it
 *    is labelled for what it is ("edge view") and never mixed into the
 *    Iran-facing score.
 *
 *    Signal 1  client/reachability   http://<ip>/…          (no TLS, so the
 *                                    answer is unambiguous: the address is
 *                                    routable from that ISP, or it is not)
 *    Signal 2  client/end-to-end     wss://<host>:<port>/…  (the real SNI, the
 *                                    real port, a real upgrade — the decisive
 *                                    metric: DNS, SNI filtering, port blocks
 *                                    and TLS interception all show up here)
 *    Signal 3  edge view             TCP/TLS from the colo (secondary; never
 *                                    presented as an Iran measurement)
 *    Signal 4  tunnel feedback       the auth outcome of real tunnel sessions,
 *                                    tagged with the caller's ASN
 *
 *  HONEST LIMITATIONS (measured, not assumed)
 *    · A browser cannot connect to https://<ip>/ with a foreign SNI, and
 *      Cloudflare fails the handshake when SNI matches no certificate it
 *      holds, so per-IP TLS success is NOT measurable from the browser.  The
 *      prober therefore measures IP reachability in cleartext and end-to-end
 *      TLS+WS against the hostnames.  Nothing here pretends otherwise.
 *    · Workers run only on Cloudflare's edge.  No other provider's range can
 *      ever carry this worker; the other providers are used as SNI/decoy
 *      material and as standalone fallback endpoints, and the registry says so
 *      in the data ("usable_as"), not in a comment.
 *    · Cron fires once a minute.  Scores refresh continuously because client
 *      reports stream in; the minute tick only aggregates, decays and refills.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function cleanEndpointEngine() {
  const DAY = 86400, HOUR = 3600;

  /* ─────────────────────────── bounds ──────────────────────────────────── */
  const LIMITS = {
    candidates: 400,        // rows kept in the D1 score table per scope
    batchIps: 10,           // IPs handed to one browser
    batchHosts: 3,          // host×port pairs handed to one browser
    reportsPerBatch: 40,    // entries accepted from one batch
    reportBytes: 8192,      // hard cap on the POSTed JSON
    batchesPerHour: 6,      // per account
    minActive: 20,          // verified endpoints that must always be available
    probeTimeoutMs: 2500,
    ewmaAlpha: 0.15,
  };

  /* ─────────────────────── provider registry ───────────────────────────── */
  /* usable_as:
   *   'edge'      the range can actually serve this worker (Cloudflare only)
   *   'sni'       usable as an SNI/decoy host behind an edge
   *   'fallback'  usable as a standalone endpoint for a self-hosted dialer
   * Ranges are a *fallback*: the live lists are fetched and cached, and the
   * source of every range is recorded per row so a stale fallback is visible.
   */
  const PROVIDERS = [
    {
      id: 'cloudflare', name: 'Cloudflare', asn: 'AS13335',
      usable_as: ['edge'],
      why: 'the only provider that runs Workers; every edge candidate comes from here',
      rangesUrl: 'https://api.cloudflare.com/client/v4/ips', parse: 'cf',
      v4: ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
        '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
        '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'],
      v6: ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
        '2a06:98c0::/29', '2c0f:f248::/32'],
    },
    {
      id: 'aws-cloudfront', name: 'Amazon CloudFront', asn: 'AS16509',
      usable_as: ['fallback', 'sni'],
      why: 'cannot front a Worker; useful only as a self-hosted fallback endpoint or an SNI candidate',
      rangesUrl: 'https://ip-ranges.amazonaws.com/ip-ranges.json', parse: 'aws',
      v4: ['13.32.0.0/15', '13.224.0.0/14', '13.249.0.0/16', '52.84.0.0/15', '54.182.0.0/16', '54.192.0.0/16',
        '54.230.0.0/16', '54.239.128.0/18', '99.84.0.0/16', '204.246.164.0/22'],
      v6: ['2600:9000::/28'],
    },
    {
      id: 'google', name: 'Google Cloud', asn: 'AS396982',
      usable_as: ['fallback', 'sni'],
      why: 'cannot front a Worker; usable as a fallback endpoint (a self-hosted listener)',
      rangesUrl: 'https://www.gstatic.com/ipranges/cloud.json', parse: 'gcp',
      v4: ['34.64.0.0/10', '34.128.0.0/10', '35.184.0.0/13', '35.190.0.0/17', '130.211.0.0/22'],
      v6: ['2600:1900::/28'],
    },
    {
      id: 'fastly', name: 'Fastly', asn: 'AS54113',
      usable_as: ['fallback', 'sni'],
      why: 'cannot front a Worker; a very common decoy SNI and a fallback endpoint',
      rangesUrl: 'https://api.fastly.com/public-ip-list', parse: 'fastly',
      v4: ['23.235.32.0/20', '43.249.72.0/22', '103.244.50.0/24', '103.245.222.0/23', '103.245.224.0/24',
        '104.156.80.0/20', '146.75.0.0/16', '151.101.0.0/16', '157.52.64.0/18', '167.82.0.0/17'],
      v6: ['2a04:4e40::/32', '2a04:4e42::/32'],
    },
    {
      id: 'ovh', name: 'OVHcloud', asn: 'AS16276',
      usable_as: ['fallback'],
      why: 'cannot front a Worker; a standalone fallback listener is the only valid use',
      rangesUrl: 'https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS16276', parse: 'ripe',
      v4: ['51.38.0.0/16', '51.68.0.0/16', '51.75.0.0/16', '51.83.0.0/16', '51.89.0.0/16', '51.91.0.0/16',
        '137.74.0.0/16', '145.239.0.0/16', '147.135.0.0/16', '149.202.0.0/16', '151.80.0.0/16', '158.69.0.0/16',
        '164.132.0.0/16', '178.32.0.0/15', '188.165.0.0/16', '213.186.32.0/19'],
      v6: ['2001:41d0::/32', '2402:1f00::/32'],
    },
    {
      id: 'hetzner', name: 'Hetzner', asn: 'AS24940',
      usable_as: ['fallback'],
      why: 'cannot front a Worker; a standalone fallback listener is the only valid use',
      rangesUrl: 'https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS24940', parse: 'ripe',
      v4: ['5.9.0.0/16', '78.46.0.0/15', '88.198.0.0/16', '128.140.0.0/17', '136.243.0.0/16', '138.201.0.0/16',
        '144.76.0.0/16', '148.251.0.0/16', '162.55.0.0/16', '176.9.0.0/16', '195.201.0.0/16', '116.202.0.0/16',
        '159.69.0.0/16', '167.235.0.0/16', '168.119.0.0/16'],
      v6: ['2a01:4f8::/32', '2a01:4f9::/32'],
    },
    {
      id: 'gcore', name: 'Gcore', asn: 'AS199524',
      usable_as: ['fallback', 'sni'],
      why: 'cannot front a Worker; CDN range usable as a decoy SNI or a fallback endpoint',
      rangesUrl: 'https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS199524', parse: 'ripe',
      v4: ['92.223.0.0/16', '95.174.0.0/16', '45.133.0.0/22', '62.112.222.0/24', '89.44.195.0/24'],
      v6: ['2a03:90c0::/32'],
    },
    {
      id: 'cdn77', name: 'CDN77', asn: 'AS60068',
      usable_as: ['fallback', 'sni'],
      why: 'cannot front a Worker; a decoy SNI or a fallback endpoint (its own network is not Workers)',
      rangesUrl: 'https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS60068', parse: 'ripe',
      v4: ['37.19.192.0/18', '79.127.128.0/17', '169.150.192.0/18', '156.146.32.0/19'],
      v6: ['2a02:6ea0::/32'],
    },
    {
      id: 'akamai', name: 'Akamai', asn: 'AS20940',
      usable_as: ['fallback', 'sni'],
      why: 'cannot front a Worker; the strongest decoy-SNI material (huge, well-reputed range)',
      rangesUrl: 'https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS20940', parse: 'ripe',
      v4: ['23.32.0.0/11', '23.192.0.0/11', '104.64.0.0/10', '184.24.0.0/13', '96.16.0.0/13', '2.16.0.0/13'],
      v6: ['2600:1400::/24', '2a02:26f0::/32'],
    },
  ];

  /**
   * Iranian access networks, as *labels* over the per-ASN scopes the engine
   * already maintains.  Nothing here invents a measurement: an ISP only gets a
   * ranking once clients on its ASN have actually reported, and every consumer
   * falls back to the global scope when the per-ASN one is empty (see pick()).
   */
  const ISPS = [
    { key: 'mci', name: 'MCI / همراه اول', asns: ['197207'] },
    { key: 'irancell', name: 'Irancell', asns: ['44244'] },
    { key: 'tci', name: 'TCI / مخابرات', asns: ['58224'] },
    { key: 'rightel', name: 'Rightel', asns: ['57218'] },
    { key: 'shatel', name: 'Shatel', asns: ['31549'] },
    { key: 'iranserver', name: 'Iran Server', asns: ['204213'] },
  ];
  const ispOf = (asn) => {
    const a = String(asn || '').replace(/^AS/i, '');
    if (!a) return null;
    const hit = ISPS.find(x => x.asns.includes(a));
    return hit ? { key: hit.key, name: hit.name } : { key: 'asn:' + a, name: 'AS' + a };
  };


  /* ─────────────────────────── exclusions ──────────────────────────────── */
  /* never a candidate: reserved space, private space, CGNAT, loopback, the
   * multicast/experimental blocks, and the Iranian DPI sinkholes that answer
   * on behalf of blocked destinations (10.10.34.x and neighbours). */
  const EXCLUDE_V4 = [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
    '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
    '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32',
    '10.10.34.0/24', '10.10.35.0/24',            /* IR DPI sinkhole (10.10.34.34 family) */
    '10.10.36.0/24', '127.0.0.53/32',
  ];
  const EXCLUDE_V6 = [
    '::/128', '::1/128', '::ffff:0:0/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001:db8::/32',
    '2001::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8', '2001:10::/28', '2001:20::/28',
  ];

  /* ─────────────────────── CIDR maths (v4 + v6) ────────────────────────── */
  const v4ToInt = (s) => {
    const o = String(s).split('.');
    if (o.length !== 4) return null;
    let v = 0;
    for (const part of o) {
      /* canonical octets only: "010.0.0.1" and " 1" must never become a second
         key for the same address in qv_ip_scores (PK is (scope, ip)). */
      if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
      const n = Number(part);
      if (n > 255) return null;
      v = (v * 256) + n;
    }
    return v >>> 0;
  };
  const intToV4 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');

  /** full 128-bit parse: 8 groups, \\:: compression, and dotted-quad tails */
  const v6ToBytes = (s) => {
    let str = String(s).trim().toLowerCase();
    if (!str.includes(':')) return null;
    if (str.includes('.')) {                                  /* ::ffff:1.2.3.4 style */
      const i = str.lastIndexOf(':');
      const v4 = v4ToInt(str.slice(i + 1));
      if (v4 === null) return null;
      str = str.slice(0, i + 1) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
    }
    const half = str.split('::');
    if (half.length > 2) return null;
    const head = half[0] ? half[0].split(':') : [];
    const tail = half.length === 2 && half[1] ? half[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    if (half.length === 1 && head.length !== 8) return null;
    const groups = [...head, ...new Array(half.length === 2 ? missing : 0).fill('0'), ...tail];
    const out = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      const g = groups[i] === '' ? 0 : parseInt(groups[i], 16);
      if (!Number.isInteger(g) || g < 0 || g > 0xffff) return null;
      out[i * 2] = (g >> 8) & 0xff; out[i * 2 + 1] = g & 0xff;
    }
    return out;
  };
  const bytesToV6 = (b) => {
    const g = [];
    for (let i = 0; i < 8; i++) g.push(((b[i * 2] << 8) | b[i * 2 + 1]).toString(16));
    let best = { at: -1, len: 0 }, cur = { at: -1, len: 0 };
    for (let i = 0; i < 8; i++) {
      if (g[i] === '0') { if (cur.at < 0) cur = { at: i, len: 0 }; cur.len++; if (cur.len > best.len) best = { ...cur }; }
      else cur = { at: -1, len: 0 };
    }
    if (best.len > 1) return [...g.slice(0, best.at), '', ...g.slice(best.at + best.len)].join(':').replace(/^:/, '::').replace(/:$/, '::');
    return g.join(':');
  };
  const isV6 = (s) => String(s).includes(':');

  const parseCidr = (cidr) => {
    const [base, bitsStr] = String(cidr).trim().split('/');
    if (isV6(base)) {
      const bytes = v6ToBytes(base);
      if (!bytes) return null;
      const bits = bitsStr === undefined ? 128 : parseInt(bitsStr, 10);
      if (!(bits >= 0 && bits <= 128)) return null;
      return { family: 'v6', base, bytes, bits };
    }
    const v = v4ToInt(base);
    if (v === null) return null;
    const bits = bitsStr === undefined ? 32 : parseInt(bitsStr, 10);
    if (!(bits >= 0 && bits <= 32)) return null;
    return { family: 'v4', base, int: v, bits };
  };
  const inCidr = (ip, cidr) => {
    const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
    if (!c) return false;
    if (c.family === 'v4') {
      const v = v4ToInt(ip);
      if (v === null) return false;
      const mask = c.bits === 0 ? 0 : ((0xffffffff << (32 - c.bits)) >>> 0);
      return ((v & mask) >>> 0) === ((c.int & mask) >>> 0);
    }
    const b = v6ToBytes(ip);
    if (!b) return false;
    const full = c.bits >> 3, rest = c.bits & 7;
    for (let i = 0; i < full; i++) if (b[i] !== c.bytes[i]) return false;
    if (rest) {
      const mask = (0xff << (8 - rest)) & 0xff;
      if ((b[full] & mask) !== (c.bytes[full] & mask)) return false;
    }
    return true;
  };
  /* the two NAT64 well-known prefixes are excluded from *sampling* (we do not
     probe them) but they are legitimate *outputs* of the DNS64 mapping when an
     IPv4-only endpoint is handed to an IPv6-only subscriber — so the exclusion
     is opt-out for exactly those two, and only where a mapping is expected. */
  const NAT64_ALLOW = new Set(['64:ff9b::/96', '64:ff9b:1::/48']);
  const isExcluded = (ip, opts = {}) => {
    const list = isV6(ip) ? EXCLUDE_V6 : EXCLUDE_V4;
    for (const c of list) { if (opts.nat64 && NAT64_ALLOW.has(c)) continue; if (inCidr(ip, c)) return true; }
    return false;
  };
  /** the canonical text form is the row identity in qv_ip_scores: one address,
   *  one row, whatever spelling a client or a provider used. */
  const canonIp = (ip) => {
    const s = String(ip == null ? '' : ip).trim().toLowerCase();
    if (!s) return null;
    if (s.includes(':')) { const b = v6ToBytes(s); return b ? bytesToV6(b) : null; }
    const v = v4ToInt(s);
    return v === null ? null : intToV4(v);
  };
  /** an address we are willing to hand to a subscriber (and to probe).
   *  opts.nat64 = accept a 64:ff9b::/96 mapping produced by our own DNS64. */
  const isUsable = (ip, opts = {}) => {
    const c = canonIp(ip);
    if (!c) return false;
    return !isExcluded(c, opts);
  };

  /* stratified sampling: one random host per distinct /24 (v4) or /48 (v6)
   * stratum, so a handful of draws covers the whole range instead of
   * clustering in one block. */
  const sampleRange = (cidr, count = 3, rnd = Math.random) => {
    const c = parseCidr(cidr);
    if (!c) return [];
    const out = new Set();
    if (c.family === 'v4') {
      const hostBits = Math.min(c.bits >= 31 ? 0 : 32 - c.bits, 8);       /* the /24 stratum */
      const strata = Math.max(1, 2 ** Math.min(32 - c.bits - hostBits, 16));
      const stride = 2 ** hostBits;
      const mask = c.bits === 0 ? 0 : ((0xffffffff << (32 - c.bits)) >>> 0);
      for (let i = 0; i < count * 3 && out.size < count; i++) {
        const s = Math.floor(rnd() * strata);
        const host = Math.floor(rnd() * stride);
        const v = (((c.int & mask) >>> 0) + s * stride + host) >>> 0;
        const ip = intToV4(v);
        if (isUsable(ip)) out.add(ip);
      }
      return [...out];
    }
    const hostBits = Math.min(128 - c.bits, 16);
    const strata = Math.max(1, 2 ** Math.min(128 - c.bits - hostBits, 16));
    for (let i = 0; i < count * 3 && out.size < count; i++) {
      const b = new Uint8Array(c.bytes);
      const s = Math.floor(rnd() * strata), host = Math.floor(rnd() * (2 ** hostBits));
      let add = (s * (2 ** hostBits)) + host;
      for (let k = 15; k >= 0 && add > 0; k--) { const t = b[k] + (add & 0xff); b[k] = t & 0xff; add = (add >> 8) + (t >> 8); }
      const ip = bytesToV6(b);
      if (isUsable(ip)) out.add(ip);
    }
    return [...out];
  };

  /* ─────────────────────── provider range discovery ────────────────────── */
  const RANGE_CACHE = QV.cache('ciRanges', { max: 32, maxBytes: 512 * 1024, ttl: 6 * HOUR * 1000 });

  const cidrContains = (outer, inner) => {
    const a = typeof outer === 'string' ? parseCidr(outer) : outer;
    const b = typeof inner === 'string' ? parseCidr(inner) : inner;
    if (!a || !b || a.family !== b.family || a.bits > b.bits) return false;
    return inCidr(b.family === 'v4' ? intToV4(b.int) : bytesToV6(b.bytes), a);
  };

  /**
   * Validation for anything a third party hands us (the live provider lists and
   * the RIPE Stat announcements).  A range becomes a candidate only if it is a
   * well-formed CIDR of the right family, no wider than a sane announcement,
   * entirely outside reserved/bogon space, and not already covered by a wider
   * prefix that we kept — nested announcements would otherwise make the
   * sampler draw the same scarce stratum twice.
   */
  const MIN_BITS = { v4: 8, v6: 16 };
  const validateRanges = (list, family) => {
    const kept = [];
    for (const raw of list || []) {
      if (typeof raw !== 'string') continue;
      const c = parseCidr(raw);
      if (!c || c.family !== family) continue;
      if (c.bits < MIN_BITS[family]) continue;                       /* /0 … /7 v4, /0 … /15 v6 */
      const base = family === 'v4' ? intToV4(c.int) : bytesToV6(c.bytes);
      if (!base || isExcluded(base)) continue;                        /* bogons never become candidates */
      if (!kept.some(k => cidrContains(k, raw))) kept.push(raw.trim().toLowerCase());
      if (kept.length >= 512) break;
    }
    return kept;
  };

  /* kept as the historical helper name used by the parsers below */
  const parseLive = (provider, body) => {
    const out = { v4: [], v6: [] };
    try {
      if (provider.parse === 'cf') {
        const r = body.result || {};
        out.v4 = r.ipv4_cidrs || []; out.v6 = r.ipv6_cidrs || [];
      } else if (provider.parse === 'aws') {
        for (const p of body.prefixes || []) if (p.service === 'CLOUDFRONT' && p.ip_prefix) out.v4.push(p.ip_prefix);
        for (const p of body.ipv6_prefixes || []) if (p.service === 'CLOUDFRONT' && p.ipv6_prefix) out.v6.push(p.ipv6_prefix);
      } else if (provider.parse === 'gcp') {
        for (const p of body.prefixes || []) {
          if (p.ipv4Prefix) out.v4.push(p.ipv4Prefix);
          if (p.ipv6Prefix) out.v6.push(p.ipv6Prefix);
        }
      } else if (provider.parse === 'fastly') {
        out.v4 = body.addresses || []; out.v6 = body.ipv6_addresses || [];
      } else if (provider.parse === 'ripe') {
        for (const p of (body.data && body.data.prefixes) || []) {
          if (p.prefix && p.prefix.includes(':')) out.v6.push(p.prefix); else if (p.prefix) out.v4.push(p.prefix);
        }
      }
    } catch (e) { /* a malformed live list just means the fallback is used */ }
    /* A provider may announce thousands of prefixes (Akamai alone is ~4 000);
       validateRanges() keeps a bounded, de-duplicated, bogon-free sample, and
       the ranking only ever hands out a few dozen addresses.  The old local
       `clean` helper was unused after that change and has been removed.        */
    return { v4: validateRanges(out.v4, 'v4'), v6: validateRanges(out.v6, 'v6') };
  };

  /**
   * Last good validated list per provider, remembered in isolate RAM and, when
   * the deployment can afford the row, in `qv_ip_ranges.payload`.  A failed
   * fetch therefore never *erases* a good list: the order of preference is
   *   live  →  last-good  →  curated static
   * and the chosen source is visible per provider in the audit.
   */
  const GOOD_RANGES = QV.cache('ciGoodRanges', { max: 32, maxBytes: 512 * 1024, ttl: 24 * HOUR * 1000 });
  const readPersistedLists = async (env) => {
    if (!env || env.__noD1) return null;
    const rows = await QV.safeAsync(() => QV.d1.all(env, 'SELECT provider, payload FROM qv_ip_ranges WHERE payload IS NOT NULL'), null);
    if (!rows) { noteDegrade('ranges', 'persisted range lists unreadable'); return null; }
    return rows;
  };

  /** every provider's ranges, live when possible, last-good, then static */
  const ranges = async (env, ctx, opts = {}) => {
    const hit = opts.refresh ? null : RANGE_CACHE.get('all');
    if (hit) return hit;
    const out = { providers: [], v4: [], v6: [], fetched_at: Date.now(), live: 0, fallback: 0, lastgood: 0 };
    const freshById = {};
    /* injectable transport: production always uses fetchWithRetry; the seam
       exists so a test (or an operator reproducing a failure) can drive the
       failure path without touching the network */
    const fetchRanges = opts.fetch || ((url, init, o) => QV.fetchWithRetry(url, init, o));
    if (opts.refresh) {
      for (const row of (await readPersistedLists(env)) || []) {
        const parsed = QV.safe(() => JSON.parse(row.payload), null);
        if (parsed && Array.isArray(parsed.v4)) GOOD_RANGES.set('g:' + row.provider, parsed, 24 * HOUR * 1000);
      }
    }
    for (const p of PROVIDERS) {
      let lists = null, src = 'static-fallback';
      if (opts.refresh) {
        const body = await QV.safeAsync(() => fetchRanges(p.rangesUrl,
          { headers: { 'user-agent': 'qv-endpoint-engine' } },
          { retries: 1, timeoutMs: 6000 }), null);
        if (body && body.ok) lists = parseLive(p, await QV.safeAsync(() => body.json(), null) || {});
      }
      const live = lists && (lists.v4.length || lists.v6.length);
      if (live) {
        src = 'live';
        /* only a validated, non-empty list becomes the new last-good */
        const keep = { v4: validateRanges(lists.v4, 'v4').slice(0, 400), v6: validateRanges(lists.v6, 'v6').slice(0, 400) };
        if (keep.v4.length || keep.v6.length) {
          GOOD_RANGES.set('g:' + p.id, keep, 24 * HOUR * 1000);
          freshById[p.id] = keep;                            /* persisted below, one batch */
          src = 'live';
        } else { lists = null; }
      }
      let chosen = live ? lists : (GOOD_RANGES.get('g:' + p.id) || null);
      if (!live && chosen) { src = 'last-good'; }
      if (!chosen) {
        /* the static fallback goes through the same validator as a live list:
           a typo in a curated range must be caught here, not by a subscriber */
        chosen = { v4: validateRanges(p.v4, 'v4'), v6: validateRanges(p.v6, 'v6') };
        src = 'static-fallback';
      }
      out.providers.push({
        id: p.id, name: p.name, asn: p.asn, usable_as: p.usable_as, why: p.why,
        source: src, v4: chosen.v4.length, v6: chosen.v6.length,
        ranges_url: p.rangesUrl,
      });
      if (src === 'live') out.live++; else if (src === 'last-good') out.lastgood++; else out.fallback++;
      if (p.usable_as.includes('edge')) { out.v4.push(...chosen.v4); out.v6.push(...chosen.v6); }
      /* every provider's ranges are also candidates for the *decoy* pool */
      out[p.id] = chosen;
    }
    out.v4 = [...new Set(out.v4)]; out.v6 = [...new Set(out.v6)];
    RANGE_CACHE.set('all', out, 6 * HOUR * 1000);
    if (opts.persist !== false) {
      /* one row per provider: the table is a cache, not a ledger.  The payload
         column is additive (ALTER TABLE) and only carries validated lists. */
      const db = QV.d1.db(env);
      if (db) {
        const nowSec = Math.floor(Date.now() / 1000);
        const rows = out.providers.map(p => {
          const lists = out[p.id] || { v4: [], v6: [] };
          const fresh = freshById[p.id];
          return [p.id, 'both', (lists.v4 || []).length + (lists.v6 || []).length, p.source, nowSec,
            fresh ? JSON.stringify(fresh) : null];
        });
        await QV.safeAsync(() => QV.d1.batch(env, rows.map(r => db.prepare(
          'INSERT INTO qv_ip_ranges (provider,family,count,source,fetched_at,payload) VALUES (?,?,?,?,?,?) ' +
          'ON CONFLICT(provider) DO UPDATE SET family=excluded.family, count=excluded.count, source=excluded.source, ' +
          'fetched_at=excluded.fetched_at, payload=COALESCE(excluded.payload, qv_ip_ranges.payload)'
        ).bind(...r))), null);
      }
    }
    /* a *cold* read (no refresh asked) is expected to use the static lists, so
       it is not a degradation; a refresh that leaves providers on their static
       lists is, and the provider ids are named in the record */
    if (opts.refresh) {
      const stale = out.providers.filter(p => p.source === 'static-fallback').map(p => p.id);
      if (stale.length) {
        noteDegrade('ranges', stale.length + ' provider(s) on static lists after refresh: ' + stale.join(','));
        QV.metrics.count('ci_ranges_static_after_refresh', stale.length);
      }
      const lastgood = out.providers.filter(p => p.source === 'last-good').length;
      if (lastgood) QV.metrics.count('ci_ranges_lastgood', lastgood);
    }
    return out;
  };

  /* ─────────────────────────── scoring ─────────────────────────────────── */
  /* Wilson lower bound: the sample count is part of the score, so three lucky
   * successes can never outrank a hundred measured ones. */
  const wilsonLower = (ok, n, z = 1.64) => {
    if (!n) return 0;
    const p = ok / n, z2 = z * z, denom = 1 + z2 / n;
    const centre = p + z2 / (2 * n);
    const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return Math.max(0, (centre - spread) / denom);
  };
  const LAT_BUCKETS = [40, 80, 120, 200, 300, 500, 800, 1200, 2000, 5000];
  const bucketOf = (ms) => {
    for (let i = 0; i < LAT_BUCKETS.length; i++) if (ms <= LAT_BUCKETS[i]) return i;
    return LAT_BUCKETS.length;
  };
  const percentile = (hist, q) => {
    const total = hist.reduce((a, b) => a + b, 0);
    if (!total) return null;
    const want = total * q;
    let acc = 0;
    for (let i = 0; i < hist.length; i++) {
      acc += hist[i];
      if (acc >= want) return LAT_BUCKETS[i] === undefined ? null : LAT_BUCKETS[i];
    }
    return LAT_BUCKETS[LAT_BUCKETS.length - 1];
  };
  const latencyScore = (p50) => {
    if (p50 === null || p50 === undefined) return 0.45;          /* unknown: neutral-poor */
    if (p50 <= 120) return 1;
    if (p50 <= 300) return 0.6;
    if (p50 <= 600) return 0.3;
    return 0.1;
  };

  /**
   * Deterministic score for one (scope, ip) row.  Pure function: same input,
   * same output — which is what the determinism test pins down.
   *
   *   base   = 0.50*success + 0.20*tls + 0.15*ws + 0.15*latency
   *   fresh  = 0.7 + 0.3*exp(-sinceOK/ 6h)
   *   jitter = clamp(1 - jitterMs/200, 0.5, 1)
   *   score  = 100 * base * fresh * jitter - penalty  , clamped to [0,100]
   *   penalty= 6 per recent failure, capped at 30
   */
  const scoreRow = (row, now = Date.now()) => {
    const samples = Math.max(0, row.samples || 0);
    const ok = Math.max(0, Math.min(samples, row.ok || 0));
    const tls = samples ? Math.max(0, Math.min(1, (row.tls_ok || 0) / samples)) : 0;
    const ws = samples ? Math.max(0, Math.min(1, (row.ws_ok || 0) / samples)) : 0;
    const success = wilsonLower(ok, samples);
    const p50 = row.rtt_ms ?? null;
    const lat = latencyScore(p50);
    const base = 0.50 * success + 0.20 * tls + 0.15 * ws + 0.15 * lat;
    const sinceOK = row.last_ok ? Math.max(0, now - row.last_ok) : 24 * HOUR * 1000;
    const fresh = 0.7 + 0.3 * Math.exp(-sinceOK / (6 * HOUR * 1000));
    const jitter = QV.clamp(1 - ((row.jitter || 0) / 200), 0.5, 1);
    const penalty = Math.min(30, (row.recent_fails || 0) * 6);
    const state = row.state || 'active';
    const gate = state === 'quarantine' ? 0 : state === 'cooldown' ? 0.35 : 1;
    const raw = 100 * base * fresh * jitter * gate - penalty;
    return {
      score: Math.round(QV.clamp(raw, 0, 100) * 10) / 10,
      success: Math.round(success * 1000) / 1000,
      confidence: Math.round(wilsonLower(ok, samples) * 1000) / 1000,
      latency_ms: p50, samples, state,
      parts: { base: Math.round(base * 1000) / 1000, fresh: Math.round(fresh * 1000) / 1000, jitter: Math.round(jitter * 1000) / 1000, penalty },
    };
  };

  /* ─────────────────────── cooldown / quarantine ───────────────────────── */
  const BACKOFF = [0, 900, 3600, 21600, 0];                 /* 15m → 1h → 6h → purge */
  const nextState = (row, verdict = 'fail') => {
    const level = Math.max(0, Math.min(4, row.backoff || 0));
    if (verdict === 'quarantine') return { state: 'quarantine', backoff: level, cooldown_until: Math.floor(Date.now() / 1000) + 12 * HOUR };
    if (verdict === 'ok') return { state: 'active', backoff: 0, cooldown_until: 0 };
    if (verdict === 'degrade') return { state: 'degraded', backoff: level, cooldown_until: 0 };
    const step = Math.min(4, level + 1);
    if (step >= 4) return { state: 'purged', backoff: 4, cooldown_until: Math.floor(Date.now() / 1000) + DAY };
    return { state: 'cooldown', backoff: step, cooldown_until: Math.floor(Date.now() / 1000) + BACKOFF[step] };
  };
  const isAvailable = (row, now = Math.floor(Date.now() / 1000)) =>
    row.state !== 'purged' && !(row.cooldown_until && row.cooldown_until > now);

  /* ─────────────────────── signed batch tokens ─────────────────────────── */
  const batchPayload = (b) => QV.b64.url(QV.utf8(JSON.stringify(b)));
  const signBatch = async (env, payload) => QV.b64.url(await QV.hmacSha256(QV.utf8(secretOf(env)), QV.utf8(payload)));
  const secretOf = (env) => {
    const s = QV.env.get(env, 'JWT_SECRET', '') || QV.env.get(env, 'API_SECRET_TOKEN', '') || 'qv-batch';
    return String(s);
  };
  /**
   * A batch token is self-describing on purpose.  The allow-list of addresses
   * and handles travels *inside* the HMAC-signed payload, so any isolate —
   * not just the one that issued it — can verify that a report is about
   * something we actually handed out.  Without this, a signed token replayed
   * to another colo met an empty in-isolate cache and was accepted blindly.
   * Size is bounded (≤ 10 addresses + ≤ 3 handles ≈ 700 B) and enforced again
   * on verify.
   */
  const makeBatch = async (env, uuid, opts = {}) => {
    const ips = [...new Set((opts.ips || []).map(canonIp).filter(Boolean))].slice(0, LIMITS.batchIps);
    const hosts = [...new Set((opts.hosts || []).map(h => String(h).trim().toLowerCase()).filter(Boolean))].slice(0, LIMITS.batchHosts);
    const b = {
      u: uuid, b: QV.shortId(8), e: Math.floor(Date.now() / 1000) + 600,
      n: opts.nonce || QV.hex(QV.rand(6)),
      j: opts.jitter ? 1 : 0,
      i: ips, h: hosts,
    };
    const payload = batchPayload(b);
    return { token: payload + '.' + (await signBatch(env, payload)), batch: b };
  };
  const verifyBatch = async (env, token, uuid) => {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return { ok: false, error: 'malformed' };
    if (parts[0].length > 2048 || parts[1].length > 128) return { ok: false, error: 'too-large' };
    const expect = await signBatch(env, parts[0]);
    if (!QV.timingSafeEqual(expect, parts[1])) return { ok: false, error: 'bad-signature' };
    let b;
    try { b = QV.json.parse(QV.dec.decode(QV.b64.dec(parts[0])), null); } catch (e) { b = null; }
    if (!b || typeof b !== 'object') return { ok: false, error: 'bad-payload' };
    if (uuid && b.u !== uuid) return { ok: false, error: 'wrong-account' };
    if (!b.e || b.e * 1000 < Date.now()) return { ok: false, error: 'expired' };
    b.i = [...new Set((Array.isArray(b.i) ? b.i : []).map(canonIp).filter(Boolean))].slice(0, LIMITS.batchIps);
    b.h = [...new Set((Array.isArray(b.h) ? b.h : []).map(h => String(h).trim().toLowerCase()).filter(Boolean))].slice(0, LIMITS.batchHosts);
    if (!b.i.length && !b.h.length) return { ok: false, error: 'batch-without-targets' };
    return { ok: true, batch: b };
  };

  /* ─────────────────────── report intake ───────────────────────────────── */
  /* Reports buffer in isolate RAM and are written as *aggregates* on flush:
   * one batched upsert per changed row, never one row per report. */
  const REPORT_BUF = new Map();          /* key: scope|ip → aggregate */
  const BUF_MAX = 400;
  const BATCH_SEEN = QV.cache('ciBatch', { max: 4000, maxBytes: 512 * 1024, ttl: 15 * 60 * 1000 });
  const RATE = QV.cache('ciRate', { max: 4000, maxBytes: 512 * 1024, ttl: HOUR * 1000 });
  const HANDOUT = QV.cache('ciHandout', { max: 5000, maxBytes: 2 * 1024 * 1024, ttl: 15 * 60 * 1000 });

  /* one tunnel-feedback sample per (account, target) per hour: an account that
     reconnects in a loop must not be able to inflate a host's score */
  const FB_GUARD = QV.cache('ciFb', { max: 4000, maxBytes: 256 * 1024, ttl: HOUR * 1000 });
  const KNOWN = QV.cache('ciKnown', { max: 64, maxBytes: 256 * 1024, ttl: 60 * 1000 });
  const fbOnce = (uuid, key) => {
    const k = 'f:' + String(uuid || '-') + ':' + key;
    if (FB_GUARD.get(k)) return false;
    FB_GUARD.set(k, 1, HOUR * 1000);
    return true;
  };

  /* ───────────────────────── degradation register ─────────────────────────
   * Self-healing is already the behaviour (every D1/KV/AI call goes through
   * QV.safeAsync and a cached or heuristic path follows); this records *that*
   * it happened and *why*, so the audit can show a stale score instead of
   * leaving an operator to guess.  Purely additive: no control flow changes. */
  const DEGRADED = { d1: 0, kv: 0, ai: 0, ranges: 0, windows: 0, feedback: 0, last: null, last_at: 0 };
  const noteDegrade = (kind, detail) => {
    if (DEGRADED[kind] === undefined) DEGRADED[kind] = 0;
    DEGRADED[kind]++;
    DEGRADED.last = { kind, detail: String(detail || '').slice(0, 120), at: Date.now() };
    DEGRADED.last_at = Date.now();
    QV.count('ci_degraded_' + kind);
    return true;
  };
  /** the audit sees a snapshot, never the live object */
  const degradedSnapshot = () => {
    const out = {};
    for (const [k, v] of Object.entries(DEGRADED)) if (typeof v === 'number' && k !== 'last_at') out[k] = v;
    out.last = DEGRADED.last;
    return out;
  };

  /* why feedback was refused / dropped, visible in the audit (feature H) */
  const DROP_REASONS = {};

  const rateOk = (uuid) => {
    const k = 'r:' + uuid;
    const n = RATE.get(k) || 0;
    if (n >= LIMITS.batchesPerHour) return false;
    RATE.set(k, n + 1, HOUR * 1000);
    return true;
  };

  const accept = (entry, meta) => {
    const scope = meta.asn ? 'asn:' + meta.asn : 'global';
    const key = scope + '|' + entry.ip;
    let agg = REPORT_BUF.get(key);
    if (!agg) {
      if (REPORT_BUF.size >= BUF_MAX) { REPORT_BUF.delete(REPORT_BUF.keys().next().value); }
      agg = { scope, ip: entry.ip, family: meta.family || entry.family || (isV6(entry.ip) ? 'v6' : 'v4'),
        provider: meta.provider || 'cloudflare', asn: meta.asn || null, samples: 0, ok: 0, tls_ok: 0, ws_ok: 0,
        rtt_sum: 0, rtt_n: 0, hist: new Array(LAT_BUCKETS.length + 1).fill(0), jitter: 0, last_ok: 0,
        fails: 0, suspect: 0, country: meta.country || null, at: Date.now() };
      REPORT_BUF.set(key, agg);
    }
    const weight = entry.suspect ? 0.25 : (Number.isFinite(entry.weight) && entry.weight > 0 ? Math.min(1, entry.weight) : 1);
    agg.samples += weight;
    if (entry.ok) { agg.ok += weight; agg.last_ok = Date.now(); } else agg.fails += 1;
    if (entry.tlsOk) agg.tls_ok += weight;
    if (entry.wsOk) agg.ws_ok += weight;
    if (typeof entry.rttMs === 'number' && entry.rttMs > 0 && entry.rttMs < 20000) {
      agg.rtt_sum += entry.rttMs; agg.rtt_n += 1;
      agg.hist[bucketOf(entry.rttMs)] += weight;
      agg.jitter = agg.jitter ? (agg.jitter * 0.7 + Math.abs(entry.rttMs - agg.jitter) * 0.3) : 0;
    }
    if (entry.suspect) agg.suspect += 1;
    return true;
  };

  /**
   * Validate one posted report body.  Everything here is anti-forgery:
   * the token must be ours, the batch must be ours, the IP must be one we
   * handed out in that batch, sizes and ranges are capped, and the same
   * (batch, ip, nonce) tuple is accepted once.
   */
  const submit = async (env, ctx, request, rawBody) => {
    const bytes = rawBody.byteLength || 0;
    if (bytes > LIMITS.reportBytes) return { ok: false, error: 'payload-too-large', status: 413 };
    let body;
    try { body = JSON.parse(QV.dec.decode(new Uint8Array(rawBody))); } catch (e) { return { ok: false, error: 'bad-json', status: 400 }; }
    const token = body.t || request.headers.get('x-qv-batch') || '';
    const verdict = await verifyBatch(env, token, body.u || null);
    if (!verdict.ok) return { ok: false, error: verdict.error, status: 403 };
    if (BATCH_SEEN.get('b:' + verdict.batch.b)) return { ok: false, error: 'batch-already-used', status: 409 };
    if (!rateOk(verdict.batch.u)) return { ok: false, error: 'rate-limited', status: 429 };
    const reports = Array.isArray(body.r) ? body.r : [];
    const hostReports = Array.isArray(body.h) ? body.h.slice(0, LIMITS.batchHosts) : [];
    if (!reports.length && !hostReports.length) return { ok: false, error: 'empty', status: 400 };
    if (reports.length > LIMITS.reportsPerBatch) return { ok: false, error: 'too-many-reports', status: 400 };
    /* the allow-list comes from the signed token, not from isolate RAM */
    const handout = { ips: verdict.batch.i || [], hosts: verdict.batch.h || [], family: null };
    const cf = (request.cf || {});
    const meta = {
      asn: cf.asn ? String(cf.asn) : null,
      country: cf.country || request.headers.get('cf-ipcountry') || null,
      family: body.f || null,
    };
    let accepted = 0, rejected = 0;
    for (const r of reports) {
      const ip = canonIp(r.ip);
      if (!ip || !isUsable(ip)) { rejected++; continue; }
      /* only addresses this account was actually handed may be reported —
         the list is signed, so this holds on every isolate */
      if (!handout.ips.includes(ip)) { rejected++; continue; }
      const nonce = String(r.nonce || '').slice(0, 24);
      const dupKey = 'd:' + verdict.batch.b + ':' + ip + ':' + nonce;
      if (BATCH_SEEN.get(dupKey)) { rejected++; continue; }
      BATCH_SEEN.set(dupKey, 1, 15 * 60 * 1000);
      const rtt = Number(r.rttMs);
      const entry = {
        ip, ok: !!r.ok, tlsOk: !!r.tlsOk, wsOk: !!r.wsOk,
        rttMs: Number.isFinite(rtt) ? QV.clamp(rtt, 0, 20000) : null,
        /* outlier rejection: a 3 ms round trip from a subscriber network is
           not a measurement, it is a spoofed or cached answer */
        suspect: (Number.isFinite(rtt) && rtt > 0 && rtt < 4) ? 1 : 0,
      };
      accept(entry, meta);
      accepted++;
    }
    /* End-to-end handle verdicts: the browser opened wss://<host>:<port><path>
       with real SNI.  This is the only signal that can see DNS poisoning, SNI
       filtering, port blocking and TLS interception, so it is scored with the
       same rules and kept in the same per-ASN scope — keyed by hostname, which
       pick() can never mistake for an address (isUsable rejects it). */
    for (const r of hostReports) {
      const host = String(r.host || '').trim().toLowerCase();
      if (!host || host.length > 253 || !/^[a-z0-9][a-z0-9.\-]*\.[a-z0-9]{2,}$/.test(host)) { rejected++; continue; }
      if (!handout.hosts.includes(host)) { rejected++; continue; }
      const nonce = String(r.nonce || '').slice(0, 24);
      const dupKey = 'h:' + verdict.batch.b + ':' + host + ':' + nonce;
      if (BATCH_SEEN.get(dupKey)) { rejected++; continue; }
      BATCH_SEEN.set(dupKey, 1, 15 * 60 * 1000);
      const rtt = Number(r.rttMs);
      accept({
        ip: host, family: 'host', provider: 'handle',
        ok: !!r.ok, tlsOk: !!r.tlsOk, wsOk: !!r.wsOk,
        rttMs: Number.isFinite(rtt) ? QV.clamp(rtt, 0, 20000) : null,
        suspect: 0,
      }, { ...meta, family: 'host' });
      accepted++;
    }
    BATCH_SEEN.set('b:' + verdict.batch.b, 1, 15 * 60 * 1000);
    HANDOUT.delete(verdict.batch.b);
    QV.count('ci_reports', accepted);
    QV.count('ci_reports_rejected', rejected);
    if (REPORT_BUF.size >= 120) {
      const flush = flushReports(env, ctx);
      if (ctx?.waitUntil) ctx.waitUntil(flush); else await flush;
    }
    return { ok: true, accepted, rejected, asn: meta.asn, scope: meta.asn ? 'asn:' + meta.asn : 'global' };
  };

  /**
   * Fold the RAM buffer into D1 as aggregates.
   *
   *  · D1 allows 100 bound parameters per statement, so the look-up is chunked
   *    to 40 rows (80 parameters) — the previous single SELECT bound two
   *    parameters per buffered row and failed silently past 50 rows, which
   *    reset every counter to the last batch instead of accumulating.
   *  · The counters are now accumulated *by SQL* (samples = samples + excluded),
   *    so a lost or stale read can no longer destroy history: the delta lands
   *    either way.  The score/state columns are recomputed from the read that
   *    we did get and refreshed on the next flush.
   *  · Each flush writes at most FLUSH_ROWS statements; the tick budget keeps
   *    the whole thing inside the D1 query-per-invocation allowance.
   */
  const FLUSH_ROWS = 40;
  const flushReports = async (env, ctx, opts = {}) => {
    if (!REPORT_BUF.size) return { flushed: 0 };
    const take = Math.min(REPORT_BUF.size, opts.limit || FLUSH_ROWS);
    const items = [];
    for (const [k, v] of REPORT_BUF) { if (items.length >= take) break; items.push([k, v]); }
    for (const [k] of items) REPORT_BUF.delete(k);
    const db = QV.d1.db(env);
    if (!db) {
      noteDegrade('d1', 'no DB binding: reports stay buffered in RAM');
      for (const [k, v] of items) { const prev = REPORT_BUF.get(k); if (prev) { prev.samples += v.samples; prev.ok += v.ok; } else REPORT_BUF.set(k, v); }
      return { flushed: 0, requeued: items.length };
    }
    const now = Math.floor(Date.now() / 1000);
    const known = new Map();
    let readFailed = 0;
    for (let i = 0; i < items.length; i += FLUSH_ROWS) {
      const slice = items.slice(i, i + FLUSH_ROWS);
      const rows = await QV.safeAsync(() => QV.d1.all(env,
        'SELECT scope, ip, samples, ok, tls_ok, ws_ok, rtt_ms, jitter, fails, backoff, state, cooldown_until, last_ok FROM qv_ip_scores WHERE ' +
        slice.map(() => '(scope = ? AND ip = ?)').join(' OR '),
        ...slice.flatMap(([, v]) => [v.scope, v.ip])), null);
      if (!rows) { readFailed++; noteDegrade('d1', 'score look-up failed during flush'); continue; }
      for (const r of rows) known.set(r.scope + '|' + r.ip, r);
    }
    const stmts = [];
    for (const [key, v] of items) {
      const prev = known.get(key) || {};
      const samples = (prev.samples || 0) + v.samples;
      const ok = (prev.ok || 0) + v.ok;
      const tls_ok = (prev.tls_ok || 0) + v.tls_ok;
      const ws_ok = (prev.ws_ok || 0) + v.ws_ok;
      const fails = (prev.fails || 0) + v.fails;
      const rttN = v.rtt_n || 0;
      const rttMs = rttN ? (prev.rtt_ms ? Math.round(prev.rtt_ms * 0.65 + (v.rtt_sum / rttN) * 0.35) : Math.round(v.rtt_sum / rttN)) : (prev.rtt_ms ?? null);
      const jitter = v.jitter ? Math.round(prev.jitter ? prev.jitter * 0.7 + v.jitter * 0.3 : v.jitter) : (prev.jitter || 0);
      const successRate = samples ? ok / samples : 0;
      let state = prev.state || 'active', backoff = prev.backoff || 0, cooldown_until = prev.cooldown_until || 0;
      if (v.fails) {
        if (v.samples >= 2 && successRate >= 0.8) { state = 'active'; backoff = 0; cooldown_until = 0; }
        else if (samples && v.fails / Math.max(1, v.samples) >= 0.6) { const nx = nextState({ backoff }, 'fail'); state = nx.state; backoff = nx.backoff; cooldown_until = nx.cooldown_until; }
        else { state = 'degraded'; }
      } else if (successRate >= 0.75 && samples >= 2) { state = 'active'; backoff = 0; cooldown_until = 0; }
      const lastOkS = v.last_ok ? Math.floor(v.last_ok / 1000) : (prev.last_ok || 0);
      const row = {
        scope: v.scope, ip: v.ip, family: v.family, provider: v.provider, asn: v.asn,
        samples, ok, tls_ok, ws_ok, rtt_ms: rttMs, jitter, fails, backoff, state, cooldown_until,
        last_ok: lastOkS, last_probe: now, country: v.country, suspect: v.suspect || 0,
      };
      const scored = scoreRow({ ...row, last_ok: row.last_ok * 1000, recent_fails: 0 }, Date.now());
      stmts.push(db.prepare(
        'INSERT INTO qv_ip_scores (scope,ip,family,provider,asn,samples,ok,tls_ok,ws_ok,rtt_ms,jitter,score,confidence,state,fails,backoff,cooldown_until,last_ok,last_probe,country,suspect,updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,ip) DO UPDATE SET ' +
        'family=excluded.family, provider=excluded.provider, asn=excluded.asn, ' +
        'samples=qv_ip_scores.samples + excluded.samples, ok=qv_ip_scores.ok + excluded.ok, ' +
        'tls_ok=qv_ip_scores.tls_ok + excluded.tls_ok, ws_ok=qv_ip_scores.ws_ok + excluded.ws_ok, ' +
        'fails=qv_ip_scores.fails + excluded.fails, suspect=qv_ip_scores.suspect + excluded.suspect, ' +
        'rtt_ms=excluded.rtt_ms, jitter=excluded.jitter, score=excluded.score, confidence=excluded.confidence, ' +
        'state=excluded.state, backoff=excluded.backoff, cooldown_until=excluded.cooldown_until, ' +
        'last_ok=MAX(qv_ip_scores.last_ok, excluded.last_ok), last_probe=excluded.last_probe, ' +
        'country=excluded.country, updated_at=excluded.updated_at')
        /* deltas only: the SQL does the accumulation */
        .bind(row.scope, row.ip, row.family, row.provider, row.asn, v.samples, v.ok, v.tls_ok, v.ws_ok,
          row.rtt_ms, row.jitter, scored.score, scored.confidence, row.state, v.fails, row.backoff,
          row.cooldown_until, row.last_ok, row.last_probe, row.country, v.suspect, now));
    }
    /* statements were pushed in `items` order, one per item, so an item index
       and a statement index are the same index.  Only the *uncommitted* tail is
       requeued: the counters are accumulated by SQL (`samples = samples +
       excluded.samples`), so re-sending a chunk that already committed would
       add those deltas a second time. */
    let committed = 0, failedBatch = -1;
    for (let i = 0; i < stmts.length; i += FLUSH_ROWS) {
      const part = stmts.slice(i, i + FLUSH_ROWS);
      const res = await QV.safeAsync(() => QV.d1.batch(env, part), null);
      if (!res) { failedBatch = i; break; }
      committed = i + part.length;
    }
    if (failedBatch >= 0) {
      const rest = items.slice(committed);
      for (const [k, v] of rest) {
        const prev = REPORT_BUF.get(k);
        if (prev) { prev.samples += v.samples; prev.ok += v.ok; prev.tls_ok += v.tls_ok; prev.ws_ok += v.ws_ok; prev.fails += v.fails; }
        else REPORT_BUF.set(k, v);
      }
      QV.metrics.count('ci_flush_partial', 1);
      noteDegrade('d1', 'batch write failed: uncommitted tail requeued');
      QV.metrics.count('ci_flush_rows', committed);
      return { flushed: committed, error: 'batch-failed', committed, requeued: rest.length,
        batches: Math.ceil(committed / FLUSH_ROWS), read_failed: readFailed };
    }
    QV.metrics.count('ci_flush_rows', items.length);
    if (readFailed) QV.metrics.count('ci_flush_readpartial', readFailed);
    /* per-scope rolling buckets: the only way to see a *sudden* ASN-wide drop
       (cumulative counters can never show a change in rate) */
    const windows = await publishWindows(env, items);
    return { flushed: items.length, scopes: [...new Set(items.map(([, v]) => v.scope))].length, read_failed: readFailed,
      batches: Math.ceil(stmts.length / FLUSH_ROWS), windows };
  };

  /* ───────────────── rolling windows (block detection input) ───────────────── */
  /**
   * One row per (scope, 5-minute bucket) with the *deltas* of that tick added in
   * SQL.  Bounded: at most WINDOW_SCOPES scopes per flush, one statement each,
   * batched with the engine's other writes.  `qv_ip_windows` is additive and is
   * only ever read by detectBlocks() and the audit.
   */
  const WINDOW_MS = 5 * 60 * 1000;
  const WINDOW_SCOPES = 16;
  const publishWindows = async (env, items) => {
    const db = QV.d1.db(env);
    if (!db || !items.length) return 0;
    const bucket = Math.floor(Date.now() / WINDOW_MS) * (WINDOW_MS / 1000);
    const agg = new Map();
    for (const [, v] of items) {
      const key = v.family === 'host' ? v.scope + '|host' : v.scope;
      const a = agg.get(key) || { samples: 0, ok: 0, ws_ok: 0, tls_ok: 0, fails: 0 };
      a.samples += v.samples; a.ok += v.ok; a.ws_ok += v.ws_ok; a.tls_ok += v.tls_ok; a.fails += v.fails;
      agg.set(key, a);
    }
    const stmts = [...agg.entries()].slice(0, WINDOW_SCOPES).map(([scope, a]) => db.prepare(
      'INSERT INTO qv_ip_windows (scope,bucket,samples,ok,ws_ok,tls_ok,fails) VALUES (?,?,?,?,?,?,?) ' +
      'ON CONFLICT(scope,bucket) DO UPDATE SET samples = qv_ip_windows.samples + excluded.samples, ' +
      'ok = qv_ip_windows.ok + excluded.ok, ws_ok = qv_ip_windows.ws_ok + excluded.ws_ok, ' +
      'tls_ok = qv_ip_windows.tls_ok + excluded.tls_ok, fails = qv_ip_windows.fails + excluded.fails'
    ).bind(scope, bucket, a.samples, a.ok, a.ws_ok, a.tls_ok, a.fails));
    if (!stmts.length) return 0;
    const res = await QV.safeAsync(() => QV.d1.batch(env, stmts), null);
    if (!res) { noteDegrade('windows', 'window batch failed'); return 0; }
    return stmts.length;
  };

  /* ─────────────────── candidate generation (ε-greedy) ─────────────────── */
  const SCORES = QV.cache('ciScores', { max: 2000, maxBytes: 2 * 1024 * 1024, ttl: 60000 });

  const loadScores = async (env, scope, opts = {}) => {
    const key = 's:' + scope;
    if (!opts.fresh) { const hit = SCORES.get(key); if (hit) return hit; }
    const rows = await QV.safeAsync(() => QV.d1.all(env,
      'SELECT * FROM qv_ip_scores WHERE scope = ? ORDER BY score DESC LIMIT ?', scope, LIMITS.candidates), []) || [];
    SCORES.set(key, rows, 60000);
    return rows;
  };

  /* ═══════════ adaptive scheduling: Thompson-style bandit (feature B) ═══════
   * Exploitation used to be a plain score sort, so a candidate with two lucky
   * samples was handed out as often as one with fifty measured ones.  Instead
   * each candidate's posterior is sampled — mean (ok+1)/(n+2) with the normal
   * approximation of its width — from a **deterministic** PRNG seeded per
   * request: Thompson sampling with an explainable, reproducible
   * implementation (same rows + seed ⇒ same order).  Uncertainty and recent
   * change therefore win hand-outs, which is what a bandit is for; a UCB bonus
   * keeps a starved scope explored.  Hard caps stay in place.
   */
  const mulberry32 = (a) => () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const banditOrder = (rows, opts = {}) => {
    const now = opts.now || Date.now();
    const rnd = mulberry32((opts.seed | 0) || 1);
    const total = rows.reduce((a, r) => a + Math.max(0, r.samples || 0), 0);
    const logTotal = Math.log(total + 2);
    const gauss = () => {
      const u = Math.max(1e-9, rnd()), v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    return rows.map(r => {
      const n = Math.max(0, r.samples || 0);
      const ok = Math.max(0, Math.min(n, r.ok || 0));
      const mean = (ok + 1) / (n + 2);
      const sd = Math.sqrt((mean * (1 - mean)) / (n + 3));
      const posterior = QV.clamp(mean + gauss() * sd, 0, 1);
      const ucb = Math.sqrt((2 * logTotal) / (n + 1));
      const recent = r.updated_at && (now / 1000 - r.updated_at) < 600 ? 0.05 : 0;   /* changed in the last 10 min */
      const prior = (r.score || 0) / 100;
      const weight = n / (n + 4);                       /* thin evidence ⇒ lean on the score */
      return { row: r, pick: weight * posterior + (1 - weight) * prior + 0.15 * ucb + recent, n, ucb };
    }).sort((a, b) => b.pick - a.pick);
  };

  /**
   * Build the candidate list a probe round should test:
   *   · everything proven and due for a re-check (exploitation)
   *   · a slice of never-seen addresses from stratified sampling (exploration)
   * ε-greedy: with probability epsilon the whole round is exploration.
   */
  const plan = async (env, ctx, opts = {}) => {
    const rs = await ranges(env, ctx, { refresh: opts.refreshRanges && opts.refreshRanges >= 1 });
    const scopeList = [opts.scope || 'global', ...(opts.asns || [])];
    const seen = new Set();
    const out = [];
    const dueMs = (opts.dueMs || 10 * 60 * 1000);
    for (const scope of scopeList) {
      const rows = await loadScores(env, scope);
      for (const r of rows) {
        if (!isUsable(r.ip) || !isAvailable(r)) continue;
        if (Date.now() - (r.last_probe || 0) < dueMs && (r.samples || 0) > 4) continue;
        if (seen.has(r.ip)) continue;
        seen.add(r.ip);
        out.push({ ip: r.ip, family: r.family, provider: r.provider, scope, score: r.score, samples: r.samples, source: 'known' });
      }
    }
    /* exploitation order: bandit by default, plain score when asked */
    const ordered = opts.bandit === false
      ? out.slice().sort((a, b) => (b.score || 0) - (a.score || 0))
      : banditOrder(out, { seed: opts.seed || 0, now: Date.now() }).map(x => x.row);
    const perScope = Math.max(1, opts.perScope || 6);        /* gradual re-test per ASN */
    const capped = [], perScopeCount = new Map();
    for (const r of ordered) {
      const k = r.scope || 'global';
      const c = perScopeCount.get(k) || 0;
      if (c >= perScope) continue;
      perScopeCount.set(k, c + 1);
      capped.push(r);
    }
    out.length = 0; out.push(...capped);
    const explore = Math.random() < (opts.epsilon ?? 0.15);
    const want = opts.count || 12;
    const fresh = [];
    for (const family of ['v4', 'v6']) {
      const list = family === 'v4' ? rs.v4 : rs.v6;
      if (!list.length) continue;
      const perRange = 1;
      for (let i = 0; i < want * 2 && fresh.length < want; i++) {
        const cidr = list[Math.floor(Math.random() * list.length)];
        for (const ip of sampleRange(cidr, perRange)) {
          if (seen.has(ip)) continue;
          seen.add(ip); fresh.push({ ip, family, provider: 'cloudflare', scope: 'global', score: 0, samples: 0, source: 'explore' });
        }
      }
    }
    /* hard cap on hand-out size: never more than the caller's cap per round */
    const cap = Math.min(want, opts.cap || LIMITS.batchIps * 2);
    const picked = (explore
      ? [...fresh.slice(0, want), ...out.slice(0, want)]
      : [...out.slice(0, want - Math.ceil(want / 3)), ...fresh.slice(0, Math.ceil(want / 3))]).slice(0, cap);
    return { list: picked, ranges: { v4: rs.v4.length, v6: rs.v6.length, live: rs.live, fallback: rs.fallback }, explore };
  };

  /* ───────────────────────── batch handout ─────────────────────────────── */
  const handlesFor = async (env, ctx, opts = {}) => {
    const cfg = await QV.safeAsync(() => QV.env.prepare(env, ctx), null) || {};
    const hosts = (opts.hosts && opts.hosts.length ? opts.hosts : (cfg.hosts || [])).slice(0, LIMITS.batchHosts);
    const ports = (opts.ports && opts.ports.length ? opts.ports : [443]).slice(0, 3);
    const path = opts.path || QV.env.get(env, 'WS_PATH', '/ws');
    /* order the hosts by what subscribers on this ASN actually measured:
       a host that fails wss:// here (SNI blockade, TLS reset) drops behind the
       ones that work.  Unmeasured hosts keep their configured order. */
    const scopes = opts.asn ? ['asn:' + opts.asn, 'global'] : ['global'];
    const score = new Map();
    for (const sc of scopes) {
      const rows = await loadScores(env, sc);
      for (const r of rows) if (r.family === 'host' && !score.has(r.ip)) score.set(r.ip, r);
    }
    if (score.size) {
      hosts.sort((a, b) => {
        const ra = score.get(a), rb = score.get(b);
        if (!ra && !rb) return 0;
        if (!ra) return 1;
        if (!rb) return -1;
        return (rb.score || 0) - (ra.score || 0);
      });
    }
    /* one entry per host:port — the same host reached over two ports is two
       measurements, the same host twice is a browser wasting battery, and the
       signed allow-list is a set anyway */
    const seen = new Set();
    const pairs = [];
    for (const h of hosts) for (const p of ports) {
      const k = h + '|' + p;
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push({ host: h, port: p, path });
      if (pairs.length >= LIMITS.batchHosts) return pairs;
    }
    return pairs;
  };

  /** what a browser needs to know in order to measure: ips + handles */
  const handout = async (env, ctx, uuid, opts = {}) => {
    const planRes = await plan(env, ctx, { count: opts.count || LIMITS.batchIps, scope: opts.scope });
    const handles = await handlesFor(env, ctx, { ...opts, asn: opts.asn || null });
    const ips = planRes.list.map(x => x.ip);
    const hosts = handles.map(h => h.host);
    const { token, batch } = await makeBatch(env, uuid, { nonce: opts.nonce, ips, hosts });
    /* in-isolate copy: only used for single-use detection, never as the source
       of truth for what was handed out (that is the signed token) */
    HANDOUT.set(batch.b, { ips, hosts, at: Date.now() }, 15 * 60 * 1000);
    return {
      token, batch: batch.b, expires_in: 600,
      ips: planRes.list.map(x => ({ ip: x.ip, family: x.family, score: x.score, samples: x.samples })),
      handles, ranges: planRes.ranges, explore: planRes.explore,
      limits: { concurrency: 4, timeout_ms: LIMITS.probeTimeoutMs, max_reports: LIMITS.reportsPerBatch },
    };
  };

  /* ─────────────────────── edge view (secondary) ───────────────────────── */
  /**
   * Reachability from the Cloudflare colo.  Kept separate on purpose: it can
   * only ever say "the edge can reach this address", never "an Iranian
   * subscriber can".  Results land in scope 'edge' and are never merged into
   * the per-ASN scores that drive subscriptions.
   */
  const edgeProbe = async (env, ctx, ips, opts = {}) => {
    const timeout = opts.timeoutMs || 3000;
    const results = [];
    await Promise.all((ips || []).slice(0, opts.limit || 12).map(async (ip) => {
      const t0 = Date.now();
      let tcp = false, err = null, via = 'tcp';
      try {
        const sock = connect({ hostname: ip, port: opts.port || 443 });
        const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout));
        await Promise.race([sock.opened, timer]);
        tcp = true;
        await QV.safeAsync(() => sock.close(), null);
      } catch (e) {
        err = String(e && e.message || e);
        /* A refused TCP connect from a Worker is not proof the address is dead
           for subscribers — and the runtime may refuse loopback-to-Cloudflare
           connects on policy.  The documented alternative: a request to a
           bare edge address is answered by the edge itself (403 "direct IP
           access not allowed"), so any HTTP answer at all proves reachability
           over the other transport.  Recorded verbatim, same scope. */
        if (opts.http !== false) {
          const rs = await QV.safeAsync(() => QV.fetchWithRetry('https://' + (isV6(ip) ? '[' + ip + ']' : ip) + '/cdn-cgi/trace', {
            method: 'GET', headers: { 'user-agent': 'qv-edge-probe' },
          }, { retries: 0, timeoutMs: timeout }), null);
          if (rs) { tcp = true; via = 'http-' + rs.status; err = err + ' (http ok)'; }
        }
      }
      results.push({ ip, tcp, ms: Date.now() - t0, error: err, via, view: 'edge' });
    }));
    const ok = results.filter(r => r.tcp).length;
    QV.count('ci_edge_probe', results.length);
    QV.count('ci_edge_ok', ok);
    return results;
  };

  /* ═══════════════════ block detection (feature C) ═══════════════════════
   * Cumulative counters can never show a *change* in rate, so the flush path
   * also writes 5-minute (scope, bucket) deltas into qv_ip_windows.  This step
   * compares a 15-minute window per ASN against the same window in the global
   * scope and against the other ASNs:
   *
   *   one ASN fell, the others are healthy   → local block: quarantine that
   *                                            ASN's candidates on the
   *                                            exponential ladder, then let
   *                                            them out gradually
   *   most ASNs fell together (global too)   → provider/edge outage: do NOT
   *                                            punish the candidates; mark them
   *                                            degraded, clear cooldowns
   *   a flagged ASN recovered                → release, backoff reset
   *
   * One statement per affected scope, all batched, bounded by the scope list.
   */
  const BLOCK = { minSamples: 12, dropPoints: 0.25, lowRate: 0.35, recoverRate: 0.6, recoverSamples: 8, windowMin: 15 };
  const BLOCKS = QV.cache('ciBlocks', { max: 64, maxBytes: 64 * 1024, ttl: 6 * HOUR * 1000 });

  const detectBlocks = async (env, ctx, opts = {}) => {
    const db = QV.d1.db(env);
    if (!db) { noteDegrade('d1', 'block detection skipped: no DB'); return { ok: false, degraded: true }; }
    const since = Math.floor(Date.now() / 1000) - (opts.windowMin || BLOCK.windowMin) * 60;
    const rows = await QV.safeAsync(() => QV.d1.all(env,
      'SELECT scope, SUM(samples) s, SUM(ok) o FROM qv_ip_windows WHERE bucket >= ? GROUP BY scope', since), null);
    if (!rows) { noteDegrade('d1', 'block detection read failed'); return { ok: false, degraded: true }; }
    const stat = new Map(rows.map(r => [r.scope, { s: Number(r.s || 0), o: Number(r.o || 0) }]));
    const global = stat.get('global') || { s: 0, o: 0 };
    const globalRate = global.s >= BLOCK.minSamples ? global.o / global.s : null;
    const asnScopes = [...stat.entries()]
      .filter(([scope, a]) => scope.startsWith('asn:') && !scope.includes('|host') && a.s >= BLOCK.minSamples)
      .map(([scope, a]) => ({ scope, asn: scope.slice(4), samples: a.s, rate: a.o / a.s }));
    /* two different questions, deliberately kept apart:
       absLow  — this ASN is doing badly in absolute terms
       low     — this ASN is doing *worse than the rest of the fleet*, which is
                 the signature of a targeted (per-ISP) block rather than of a
                 problem at the edge                                        */
    const absLow = asnScopes.filter(x => x.rate <= BLOCK.lowRate);
    const low = absLow.filter(x => globalRate === null || x.rate <= globalRate - BLOCK.dropPoints);
    /* cross-ASN vote: is most of the measured space down at once? */
    const outage = globalRate !== null && globalRate <= BLOCK.lowRate &&
      absLow.length >= Math.max(2, Math.ceil(asnScopes.length / 2));
    const now = Math.floor(Date.now() / 1000);
    const acted = [], stmts = [];
    if (outage) {
      for (const x of absLow) {
        stmts.push(db.prepare(
          'UPDATE qv_ip_scores SET state = ?, cooldown_until = 0, updated_at = ? WHERE scope = ? AND state IN (?,?,?)'
        ).bind('degraded', now, x.scope, 'active', 'cooldown', 'degraded'));
        BLOCKS.set(x.scope, { kind: 'outage', at: Date.now(), rate: x.rate, samples: x.samples, global: globalRate }, 6 * HOUR * 1000);
      }
      if (absLow.length) { QV.count('ci_outage_detected', absLow.length); acted.push({ kind: 'outage', asns: absLow.map(x => x.asn) }); }
    } else {
      for (const x of low) {
        /* exponential ladder: backoff+1 → 15m/1h/6h → purge, the row ladder
           applied to the whole scope at once */
        stmts.push(db.prepare(
          'UPDATE qv_ip_scores SET backoff = MIN(4, backoff + 1), ' +
          'state = CASE WHEN backoff + 1 >= 4 THEN ? ELSE ? END, ' +
          'cooldown_until = ? + CASE MIN(4, backoff + 1) WHEN 1 THEN 900 WHEN 2 THEN 3600 WHEN 3 THEN 21600 ELSE 86400 END, ' +
          'updated_at = ? WHERE scope = ? AND state IN (?,?)'
        ).bind('purged', 'cooldown', now, now, x.scope, 'active', 'degraded'));
        BLOCKS.set(x.scope, { kind: 'block', at: Date.now(), rate: x.rate, samples: x.samples, global: globalRate }, 6 * HOUR * 1000);
        QV.emit(env, 'cleanip:block', 'warn', { message: 'possible ISP-level block on ' + x.scope, meta: { rate: x.rate, samples: x.samples, global: globalRate } });
      }
      if (low.length) { QV.count('ci_block_detected', low.length); acted.push({ kind: 'block', asns: low.map(x => x.asn) }); }
    }
    /* recovery: a flagged ASN that is healthy again is released, backoff reset */
    for (const x of asnScopes) {
      const flagged = BLOCKS.get(x.scope);
      if (!flagged || x.rate < BLOCK.recoverRate || x.samples < BLOCK.recoverSamples) continue;
      stmts.push(db.prepare(
        'UPDATE qv_ip_scores SET state = ?, backoff = 0, cooldown_until = 0, updated_at = ? WHERE scope = ? AND state IN (?,?)'
      ).bind('active', now, x.scope, 'cooldown', 'degraded'));
      BLOCKS.delete(x.scope);
      QV.count('ci_block_cleared', 1);
      acted.push({ kind: 'recovered', asn: x.asn, rate: x.rate });
    }
    let written = 0;
    for (let i = 0; i < stmts.length; i += FLUSH_ROWS) {
      const part = stmts.slice(i, i + FLUSH_ROWS);
      const res = await QV.safeAsync(() => QV.d1.batch(env, part), null);
      if (!res) { noteDegrade('d1', 'block-detection write failed'); break; }
      written += part.length;
    }
    return { ok: true, asns: asnScopes.length, low: low.length, abs_low: absLow.length, outage, global_rate: globalRate,
      acted, statements: written, min_samples: BLOCK.minSamples };
  };

  /** block state for the audit, without another query
   *  (QVStore keeps { v, b, exp } inside its Map — read the payload, honour the
   *  expiry, and never leak the internal record shape) */
  const blockSnapshot = () => {
    const out = [];
    try {
      const now = Date.now();
      for (const [scope, e] of BLOCKS.m || []) {
        if (!e || (e.exp && e.exp < now)) continue;
        const v = e.v || {};
        out.push({ scope, kind: v.kind || null, at: v.at || null, rate: v.rate, samples: v.samples, global: v.global });
      }
    } catch (e) {}
    return out.slice(0, 20);
  };

  /* ─────────────────────────── selection ───────────────────────────────── */
  /**
   * The picker every subscription goes through.  Order of preference:
   *   1. rows scored for the caller's ASN (they were measured on that ISP)
   *   2. the global rows (measured on other ISPs — still far better than a
   *      static list, and clearly second choice)
   * Rotates deterministically per (uuid, hour) so two profiles issued in the
   * same hour are not identical, without any per-request random walk.
   */
  const pick = async (env, req = {}) => {
    req = { ...req, env };
    const n = req.n || 4;
    const asn = req.asn ? String(req.asn) : null;
    const family = req.family || null;
    const asnRows = asn ? await loadScores(env, 'asn:' + asn) : [];
    const globalRows = await loadScores(env, 'global');   /* host rows are filtered below */
    const merged = new Map();
    for (const r of [...asnRows.map(r => ({ ...r, scope: 'asn' })), ...globalRows.map(r => ({ ...r, scope: 'global' }))]) {
      if (!isUsable(r.ip) || !isAvailable(r)) continue;
      if (family && r.family !== family) continue;
      if (r.samples >= 2 && r.score < 25) continue;                 /* measured and bad */
      const prev = merged.get(r.ip);
      if (!prev || (r.scope === 'asn' && prev.scope !== 'asn')) merged.set(r.ip, r);
    }
    let rows = [...merged.values()].sort((a, b) =>
      (b.scope === 'asn' ? 1 : 0) - (a.scope === 'asn' ? 1 : 0) || (b.score || 0) - (a.score || 0));
    /* Cold start (nothing measured yet, or every row aged out): fall back to
       stratified samples so the caller is never handed an empty list.  These
       are marked unmeasured, and the browser reports that follow are what
       promote or retire them. */
    if (!rows.length) {
      const rs = await QV.safeAsync(() => ranges(req.env || null, null, { persist: false }), null);
      const pickSample = (list, fam) => {
        const out = [];
        for (let i = 0; i < (list || []).length && out.length < n; i++) {
          const cidr = list[Math.floor(Math.random() * list.length)];
          for (const ip of sampleRange(cidr, 1)) out.push({ ip, family: fam, score: 0, samples: 0, state: 'unmeasured', scope: 'sample' });
        }
        return out;
      };
      if (rs) {
        rows = req.family === 'v6' ? pickSample(rs.v6, 'v6') : [...pickSample(rs.v4, 'v4'), ...(req.family === 'v4' ? [] : pickSample(rs.v6, 'v6'))];
      }
    }
    const rot = QV.hash32 ? (QV.hash32(String(req.uuid || '')) + Math.floor(Date.now() / 3600000)) % Math.max(1, rows.length) : 0;
    const ordered = rows.length ? [...rows.slice(rot), ...rows.slice(0, rot)] : [];
    const v4 = ordered.filter(r => (r.family || 'v4') === 'v4').slice(0, n);
    const v6 = ordered.filter(r => r.family === 'v6').slice(0, n);
    /* NAT64: when only v4 is proven, synthesise the v6 form so an IPv6-only
       subscriber still has an address to dial */
    const synth = v4.slice(0, n).map(r => {
      const map = QV.dns && QV.dns.v4ToV6 ? QV.dns.v4ToV6(r.ip) : null;
      return { ip: map, source_ip: r.ip, family: 'v6', nat64: true, score: r.score, scope: r.scope, synthesized: true };
    }).filter(x => x.ip && isUsable(x.ip, { nat64: true }));
    /* dual-stack preference (feature E): the client says which family it wants
       dialled first; when it has no IPv6 at all, the NAT64 mappings are already
       interchangeable with the v4 nodes, so nothing is ever withheld. */
    const prefer = req.prefer === 'v6' ? 'v6' : req.prefer === 'v4' ? 'v4' : 'auto';
    const nativeV6 = v6.length > 0;
    const preferred = prefer === 'v6'
      ? [...(nativeV6 ? v6 : synth), ...v4]
      : prefer === 'v4' ? [...v4, ...synth] : [...v4, ...v6, ...synth];
    return { v4, v6, nat64: synth, asn: asn, rows: ordered.length, prefer,
      preferred: preferred.slice(0, n), dual: nativeV6 ? 'native' : (synth.length ? 'nat64-only' : 'v4-only') };
  };

  /* ─────────────────────── cron steps ──────────────────────────────────── */
  const aggregate = async (env, ctx) => {
    const flushed = await flushReports(env, ctx, { limit: 200 });
    const decayed = await decay(env);
    const blocks = await detectBlocks(env, ctx);
    const top = await syncPool(env);
    return { ...flushed, decayed, blocks, pool: top };
  };

  /* The per-window aggregates are bounded *in time*: 48 h of 5-minute buckets
     is all the detector and the audit ever read.  The delete is rate-limited to
     once an hour so the 1-minute cron does not spend a statement on nothing. */
  let lastWindowPrune = 0;
  const pruneWindows = async (db, now) => {
    if (now - lastWindowPrune < 3600) return 0;
    lastWindowPrune = now;
    const r = await QV.safeAsync(() => db.prepare('DELETE FROM qv_ip_windows WHERE bucket < ?')
      .bind(now - 48 * 3600).run(), null);
    return r ? (r.meta?.changes ?? r.changes ?? 0) : 0;
  };

  /** scores age: no measurement in a day means the row drifts to the middle */
  const decay = async (env) => {
    const db = QV.d1.db(env);
    if (!db) return { ok: false };
    const now = Math.floor(Date.now() / 1000);
    /* updated_at is bumped by the decay itself: without it the WHERE clause
       stayed true forever and a stale row lost one sample *per tick* (once a
       minute) instead of once per 15-minute window. */
    const r = await QV.safeAsync(() => db.prepare(
      'UPDATE qv_ip_scores SET score = MAX(0, score * 0.85), samples = MAX(0, samples - 1), ' +
      'state = CASE WHEN state = ? AND cooldown_until < ? THEN ? ELSE state END, updated_at = ? WHERE updated_at < ?'
    ).bind('cooldown', now, 'active', now, now - 900).run(), null);
    const purged = await QV.safeAsync(() => db.prepare('DELETE FROM qv_ip_scores WHERE state = ? AND cooldown_until < ?').bind('purged', now - DAY).run(), null);
    const windows = await pruneWindows(db, now);
    return { decayed: r ? (r.meta?.changes ?? r.changes ?? 0) : 0, purged: purged ? (purged.meta?.changes ?? purged.changes ?? 0) : 0, windows_pruned: windows };
  };

  /** mirror the best rows into qv_ip_pool: every existing surface keeps working */
  const syncPool = async (env) => {
    const db = QV.d1.db(env);
    if (!db) return { ok: false };
    const rows = await QV.safeAsync(() => QV.d1.all(env,
      'SELECT ip, score, rtt_ms, tls_ok, ws_ok, samples, family, provider FROM qv_ip_scores WHERE scope = ? AND state = ? ORDER BY score DESC LIMIT 40',
      'global', 'active'), []) || [];
    if (!rows.length) return { mirrored: 0 };
    const stmts = rows.map(r => db.prepare(
      'INSERT INTO qv_ip_pool (ip,label,score,latency_ms,success,fail,last_test) VALUES (?,?,?,?,?,?,unixepoch()) ' +
      'ON CONFLICT(ip) DO UPDATE SET label = excluded.label, score = excluded.score, latency_ms = excluded.latency_ms, last_test = unixepoch()'
    ).bind(r.ip, 'clean:' + (r.provider || 'cf'), r.score, r.rtt_ms, Math.round(r.samples || 0), 0));
    await QV.safeAsync(() => QV.d1.batch(env, stmts), null);
    return { mirrored: rows.length };
  };

  /**
   * The pool of verified endpoints must never run dry.  When fewer than
   * minActive rows are available the engine explores immediately (an edge
   * probe round so the candidate list is not empty even before the first
   * subscriber report arrives) and records the shortfall.
   */
  const refill = async (env, ctx) => {
    const rows = await loadScores(env, 'global', { fresh: true });
    const active = rows.filter(r => isAvailable(r) && (r.state === 'active' || r.state === 'degraded'));
    const verified = active.filter(r => (r.samples || 0) >= 2 && (r.score || 0) >= 45);
    let explored = 0, probed = 0;
    if (verified.length < LIMITS.minActive) {
      const planRes = await plan(env, ctx, { count: Math.max(12, LIMITS.minActive - verified.length), epsilon: true });
      explored = planRes.list.length;
      const edge = await edgeProbe(env, ctx, planRes.list.map(x => x.ip).slice(0, 12), { limit: 12 });
      probed = edge.filter(r => r.tcp).length;
      /* edge results are recorded in their own scope — never as Iran data */
      const db = QV.d1.db(env);
      if (db && edge.length) {
        const now = Math.floor(Date.now() / 1000);
        await QV.safeAsync(() => QV.d1.batch(env, edge.map(r => db.prepare(
          'INSERT INTO qv_ip_scores (scope,ip,family,provider,asn,samples,ok,rtt_ms,score,confidence,state,last_ok,updated_at) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,ip) DO UPDATE SET samples = samples + 1, ok = ok + excluded.ok, ' +
          'rtt_ms = COALESCE(excluded.rtt_ms, rtt_ms), score = excluded.score, updated_at = excluded.updated_at'
        ).bind('edge', r.ip, isV6(r.ip) ? 'v6' : 'v4', 'cloudflare', null, 1, r.tcp ? 1 : 0, r.ms,
          scoreRow({ samples: 1, ok: r.tcp ? 1 : 0, rtt_ms: r.ms, tls_ok: 0, ws_ok: 0 }, Date.now()).score, 0.2,
          r.tcp ? 'active' : 'degraded', r.tcp ? now : 0, now))), null);
      }
      QV.count('ci_refill', 1);
    }
    return { available: active.length, verified: verified.length, min: LIMITS.minActive, explored, edge_ok: probed, shortfall: Math.max(0, LIMITS.minActive - verified.length) };
  };

  /** optional, degradable: Workers AI labels anomalies, it never scores */
  const label = async (env, ctx) => {
    if (!QV.env.get(env, 'AI_LABEL', '') && !(env.AI && QV.env.get(env, 'AI_LABEL', ''))) return { ok: false, reason: 'labeling disabled' };
    const rows = await loadScores(env, 'global');
    const odd = rows.filter(r => (r.samples || 0) >= 4 && (r.score || 0) < 30).slice(0, 12);
    if (!odd.length) return { ok: true, labels: [] };
    const res = await QV.safeAsync(() => QV.ai.run(env, `Edges of a network edge list. For each row say in JSON {"ip":"..","label":"flapping|blocked|slow|noisy"} only. Rows: ${JSON.stringify(odd.map(r => ({ ip: r.ip, ok: r.ok, samples: r.samples, rtt: r.rtt_ms, state: r.state })))}`, { kind: 'chat', system: 'Answer compact JSON.' }), null);
    return { ok: !!res, labels: res && res.text ? res.text.slice(0, 800) : null, model: res && res.model };
  };

  /* ─────────────────────── operator view ───────────────────────────────── */
  const audit = async (env, ctx) => {
    const rs = await ranges(env, ctx);
    const rows = await QV.safeAsync(() => QV.d1.all(env,
      'SELECT scope, COUNT(*) n, SUM(state = ?) active, SUM(state = ?) cooldown, SUM(state = ?) quarantine, AVG(score) avg_score FROM qv_ip_scores GROUP BY scope', 'active', 'cooldown', 'quarantine'), []) || [];
    const families = await QV.safeAsync(() => QV.d1.all(env,
      'SELECT family, COUNT(*) n, MAX(score) best FROM qv_ip_scores WHERE scope = ? GROUP BY family', 'global'), []) || [];
    const recent = await QV.safeAsync(() => QV.d1.all(env,
      'SELECT ip, scope, family, asn, samples, ok, tls_ok, ws_ok, rtt_ms, jitter, score, confidence, state, backoff, cooldown_until FROM qv_ip_scores ORDER BY updated_at DESC LIMIT 25'), []) || [];
    const counters = QV.safe(() => QV.metrics.flat(), {});
    /* per-ISP view: the same numbers as `scopes`, labelled with the carrier name
       and with the successful-upgrade ratio that actually matters in Iran */
    const perIsp = await QV.safeAsync(() => QV.d1.all(env,
      "SELECT asn, COUNT(*) n, SUM(samples) samples, SUM(ok) ok, SUM(ws_ok) ws_ok, SUM(state = 'quarantine') quarantined, " +
      "SUM(state = 'cooldown') cooling, AVG(score) avg_score, MAX(updated_at) last_seen " +
      "FROM qv_ip_scores WHERE scope LIKE 'asn:%' AND family <> 'host' GROUP BY asn ORDER BY samples DESC LIMIT 24"), []) || [];
    const history = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:strategy:hist', []), []);
    const strategy = QV.safe(() => QV.antidpi.state.strategy, null);
    return {
      providers: rs.providers, ranges: { v4: rs.v4.length, v6: rs.v6.length, live: rs.live, fallback: rs.fallback, lastgood: rs.lastgood || 0 },
      scopes: rows, families, recent,
      counters: Object.fromEntries(Object.entries(counters).filter(([k]) => k.startsWith('ci_'))),
      buffer: REPORT_BUF.size, limits: LIMITS,
      /* ── observability (feature H) ── */
      buffer_pressure: { used: REPORT_BUF.size, max: BUF_MAX, pct: Math.round((REPORT_BUF.size / BUF_MAX) * 1000) / 10,
        window_scopes: WINDOW_SCOPES, flush_rows: FLUSH_ROWS },
      isps: ISPS.map(i => ({ ...i, label: i.name })),
      per_isp: perIsp.map(r => ({ ...r, isp: ispOf(r.asn), samples: Number(r.samples || 0), ok: Number(r.ok || 0),
        success_pct: r.samples ? Math.round((Number(r.ok) / Number(r.samples)) * 1000) / 10 : null,
        upgrade_pct: r.samples ? Math.round((Number(r.ws_ok) / Number(r.samples)) * 1000) / 10 : null })),
      blocks: blockSnapshot(),
      block_limits: BLOCK,
      dropped_feedback: { ...DROP_REASONS, by_counter: Object.fromEntries(Object.entries(counters).filter(([k]) => k.startsWith('ci_feedback_'))) },
      degraded: degradedSnapshot(),
      strategy: strategy ? { version: strategy.version || null, source: strategy.source || null, shape: strategy.shape || null,
        fragment: strategy.fragment || null, updated_at: strategy.updated_at || null, reason: strategy.reason || null } : null,
      strategy_history: Array.isArray(history) ? history.slice(-6) : [],
      signals: {
        client_reachability: 'http://<ip>/ from the subscriber browser (no TLS, unambiguous)',
        client_end_to_end: 'wss://<host>:<port><path> from the subscriber browser (real SNI, real port)',
        edge_view: 'TCP/TLS from the colo — never presented as an Iran measurement',
        tunnel_feedback: 'auth outcome of real sessions (authenticated), tagged with the caller ASN',
      },
    };
  };

  /**
   * What feedback is allowed to talk about: the configured handle list plus
   * the addresses/handles that already have a row.  Cached with the score
   * cache (60 s) so a tunnel open costs no extra D1 read on the hot path.
   */
  /** hosts the operator declared: HOSTS plus the custom domain binding */
  const configuredHosts = (env) => {
    const raw = [QV.env.get(env, 'HOSTS', ''), QV.env.get(env, 'CUSTOM_DOMAIN', '')];
    const out = new Set();
    for (const chunk of raw) {
      for (const part of String(chunk || '').split(',')) {
        const h = hostname(part.trim());
        if (h) out.add(h);
      }
    }
    return out;
  };

  /**
   * What feedback is allowed to talk about.
   *
   *   configured  HOSTS + CUSTOM_DOMAIN (the operator's own domains)
   *   scored      every hostname/address that already has a score row
   *   ownHost     the Host of the authenticated request, accepted **only** when
   *               it equals one of the configured domains or a scored row.
   *
   * That last rule is what keeps tunnel feedback alive on a deployment where
   * `HOSTS` was never set: the request itself proves which domain the session
   * arrived on (Cloudflare routed it there), so its own Host is legitimate —
   * while an arbitrary hostname invented by a client is still refused.  When
   * nothing at all is configured *and* nothing is scored yet, feedback is
   * dropped and the reason is recorded (`ci_feedback_dropped_nohosts`).
   */
  const knownTargets = async (env, asn, opts = {}) => {
    const own = hostname(opts.ownHost || null);
    const key = 'known:' + (asn || '-') + ':' + (own || '');
    const hit = KNOWN.get(key);
    if (hit) return hit;
    const cfg = configuredHosts(env);
    const rows = [...(asn ? await loadScores(env, 'asn:' + asn) : []), ...(await loadScores(env, 'global'))];
    const out = { hosts: new Set(cfg), ips: new Set(), cfg_size: cfg.size, scored: 0 };
    for (const r of rows) {
      if (!r || !r.ip) continue;
      if (r.family === 'host') { const h = hostname(r.ip); if (h) { out.hosts.add(h); out.scored++; } }
      else { const c = canonIp(r.ip); if (c) out.ips.add(c); }
    }
    if (own && (cfg.has(own) || out.hosts.has(own))) out.hosts.add(own);
    out.verified_own = !!(own && out.hosts.has(own) && !cfg.has(own));
    KNOWN.set(key, out, 60000);
    return out;
  };

  /** a hostname we are willing to score: no scheme, no port, no bare address */
  const hostname = (x) => {
    const s = String(x == null ? '' : x).trim().toLowerCase();
    if (!s || s.length > 253 || s.includes(':') || s.includes('/')) return null;
    if (!/^[a-z0-9](?:[a-z0-9.\-]*[a-z0-9])?\.[a-z0-9]{2,}$/.test(s)) return null;
    return s;
  };

  /* ─────────────────────── client prober (browser) ─────────────────────── */
  /** the script every subscription page may load; self-contained, no deps */
  const proberJs = () => [
    '(function(){',
    '  if (window.__qvProbe) return; window.__qvProbe = true;',
    '  var LS = { off: "qv.probe.off", at: "qv.probe.at" };',
    '  function off(){ try { return localStorage.getItem(LS.off) === "1"; } catch(e){ return false; } }',
    '  function battery(){ try { return navigator.getBattery ? navigator.getBattery() : null; } catch(e){ return null; } }',
    '  function timed(u, ms){',
    '    var ac = window.AbortController ? new AbortController() : null;',
    '    var t0 = performance.now();',
    '    var to = setTimeout(function(){ try { ac && ac.abort(); } catch(e){} }, ms);',
    '    return fetch(u, { mode: "no-cors", cache: "no-store", redirect: "follow", signal: ac ? ac.signal : undefined })',
    '      .then(function(){ clearTimeout(to); return { ok: true, rttMs: Math.round(performance.now() - t0) }; })',
    '      .catch(function(){ clearTimeout(to); return { ok: false, rttMs: Math.round(performance.now() - t0) }; });',
    '  }',
    '  function wsTest(host, port, path, ms){',
    '    return new Promise(function(res){',
    '      var t0 = performance.now(), done = false;',
    '      var url = "wss://" + host + (port && port !== 443 ? ":" + port : "") + (path || "/ws");',
    '      var ws;',
    '      try { ws = new WebSocket(url); } catch(e){ return res({ ok:false, wsOk:false, tlsOk:false, rttMs:0 }); }',
    '      var to = setTimeout(function(){ if(!done){ done = true; try{ ws.close(); }catch(e){} res({ ok:false, wsOk:false, tlsOk:false, rttMs:Math.round(performance.now()-t0) }); } }, ms);',
    '      ws.onopen = function(){ done = true; clearTimeout(to); var r = Math.round(performance.now()-t0); try{ ws.close(); }catch(e){} res({ ok:true, tlsOk:true, wsOk:true, rttMs:r }); };',
    '      ws.onerror = function(){ if(!done){ done = true; clearTimeout(to); res({ ok:false, tlsOk:false, wsOk:false, rttMs:Math.round(performance.now()-t0) }); } };',
    '    });',
    '  }',
    '  function pool(items, limit, fn){',
    '    var i = 0, out = [];',
    '    function next(){',
    '      if (i >= items.length) return Promise.resolve(out);',
    '      var idx = i++;',
    '      return fn(items[idx], idx).then(function(r){ out.push(r); return next(); }, function(){ out.push(null); return next(); });',
    '    }',
    '    var lanes = [];',
    '    for (var k = 0; k < Math.min(limit, items.length); k++) lanes.push(next());',
    '    return Promise.all(lanes).then(function(){ return out.filter(Boolean); });',
    '  }',
    '  function post(base, token, payload){',
    '    return fetch(base + "/api/ip-report", { method: "POST", headers: { "content-type": "application/json", "x-qv-batch": token }, body: JSON.stringify(payload) });',
    '  }',
    '  function run(opt){',
    '    opt = opt || {};',
    '    var base = opt.base || location.origin;',
    '    if (off() && !opt.force) return Promise.resolve({ skipped: "opted-out" });',
    '    var last = 0; try { last = Number(localStorage.getItem(LS.at) || 0); } catch(e){}',
    '    if (!opt.force && Date.now() - last < 3600000) return Promise.resolve({ skipped: "recent" });',
    '    var conn = navigator.connection || {};',
    '    if (!opt.force && (conn.saveData || /2g/.test(conn.effectiveType || ""))) return Promise.resolve({ skipped: "data-saver" });',
    '    var bat = battery();',
    '    return Promise.resolve(bat).then(function(b){',
    '      if (b && !opt.force && b.level < 0.15 && !b.charging) return { skipped: "low-battery" };',
    '      return fetch(base + "/api/ip-batch?u=" + encodeURIComponent(opt.uuid || "") + (opt.scope ? "&scope=" + encodeURIComponent(opt.scope) : ""), { cache: "no-store" })',
    '        .then(function(r){ return r.json(); })',
    '        .then(function(j){',
    '          var d = (j && j.data) || j || {};',
    '          if (!d.ips || !d.ips.length) return { skipped: "no-batch" };',
    '          var timeout = (d.limits && d.limits.timeout_ms) || 2500;',
    '          var reports = [];',
    '          return pool(d.ips, (d.limits && d.limits.concurrency) || 4, function(c){',
    '            var fam = c.family === "v6";',
    '            var url = fam ? "http://[" + c.ip + "]/cdn-cgi/trace" : "http://" + c.ip + "/cdn-cgi/trace";',
    '            return timed(url, timeout).then(function(r){',
    '              reports.push({ ip: c.ip, family: c.family, rttMs: r.rttMs, ok: !!r.ok, tlsOk: false, wsOk: false, nonce: Math.random().toString(36).slice(2, 10) });',
    '              return r;',
    '            });',
    '          }).then(function(){',
    '            var hs = d.handles || [];',
    '            if (!hs.length) return reports;',
    '            return pool(hs, 2, function(h){',
    '              return wsTest(h.host, h.port, h.path, Math.max(3000, timeout)).then(function(r){',
    '                reports.push({ ip: h.host, family: "host", rttMs: r.rttMs, ok: !!r.ok, tlsOk: !!r.tlsOk, wsOk: !!r.wsOk, nonce: Math.random().toString(36).slice(2, 10) });',
    '                return r;',
    '              });',
    '            }).then(function(){ return reports; });',
    '          }).then(function(list){',
    '            var clean = list.filter(function(r){ return r.family !== "host"; }).slice(0, 40);',
    '            var hrep = list.filter(function(r){ return r.family === "host"; }).map(function(r){',
    '              return { host: String(r.ip).toLowerCase(), rttMs: r.rttMs, ok: !!r.ok, tlsOk: !!r.tlsOk, wsOk: !!r.wsOk, nonce: r.nonce };',
    '            }).slice(0, 6);',
    '            if (!clean.length && !hrep.length) return { reports: 0 };',
    '            return post(base, d.token, { t: d.token, u: opt.uuid || "", f: (clean[0] && clean[0].family) || "v4", r: clean, h: hrep })',
    '              .then(function(r){ try { localStorage.setItem(LS.at, String(Date.now())); } catch(e){} return { sent: clean.length, hosts: hrep.length, status: r.status }; });',
    '          });',
    '        });',
    '    });',
    '  }',
    '  window.QVProbe = { run: run, optOut: function(){ try { localStorage.setItem(LS.off, "1"); } catch(e){} }, optIn: function(){ try { localStorage.removeItem(LS.off); } catch(e){} } };',
    '  if (document.currentScript && document.currentScript.dataset.auto === "1") {',
    '    setTimeout(function(){ run({}).catch(function(){}); }, 1500);',
    '  }',
    '})();',
  ].join('\n');

  /** a self-contained page a subscriber can open to measure their own ISP */
  const proberPage = (env, uuid) => {
    const u = String(uuid || '');
    const html = [
      '<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>QV · وضعیت شبکه شما</title>',
      '<style>body{font:15px system-ui,Segoe UI,Tahoma;background:#0b1020;color:#e8eaf6;margin:0;padding:24px}',
      '.c{max-width:640px;margin:auto}h1{font-size:19px}.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1e2547}',
      '.ok{color:#4ade80}.bad{color:#f87171}.muted{color:#8b93b8}button{background:#4f46e5;color:#fff;border:0;padding:10px 16px;border-radius:8px;font:inherit}',
      'code{background:#161c33;padding:2px 6px;border-radius:6px}</style></head><body><div class="c">',
      '<h1>سنجش مسیر شما (اختیاری)</h1>',
      '<p class="muted">این صفحه در مرورگر خودتان چند نشانی را می‌آزماید و نتیجه را بی‌نام به سرور می‌فرستد؛',
      ' تنها ASN و کشور ذخیره می‌شود، نه نشانی شما. هر بار حداکثر چند ثانیه طول می‌کشد.</p>',
      '<p><button id="go">شروع سنجش</button> <button id="off" style="background:#334155">توقف دائمی</button></p>',
      '<div id="out"></div>',
      '<p class="muted" style="margin-top:20px">برای اشتراک: <code>' + QV.esc(u) + '</code></p>',
      '</div>',
      '<script src="/probe.js"></script>',
      '<script>',
      'var out = document.getElementById("out");',
      'function line(k, v, cls){ var d = document.createElement("div"); d.className = "row";',
      '  d.innerHTML = "<span>" + k + "</span><span class=\\"" + (cls||"") + "\\">" + v + "</span>"; out.appendChild(d); }',
      'document.getElementById("go").onclick = function(){',
      '  out.innerHTML = ""; line("وضعیت", "در حال سنجش…");',
      '  window.QVProbe.run({ uuid: ' + JSON.stringify(u) + ', force: true }).then(function(r){',
      '    out.innerHTML = "";',
      '    line("نتیجه", JSON.stringify(r));',
      '    line("راهنما", "اگر همه‌چیز سبز بود، مسیر شما سالم است.", "ok");',
      '  }).catch(function(e){ out.innerHTML = ""; line("خطا", String(e), "bad"); });',
      '};',
      'document.getElementById("off").onclick = function(){ window.QVProbe.optOut(); line("وضعیت", "سنجش خاموش شد", "muted"); };',
      '</script></body></html>',
    ].join('\n');
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  };

  /* ─────────────────────────── public surface ──────────────────────────── */
  QV.cleanip = {
    LIMITS, PROVIDERS, EXCLUDE_V4, EXCLUDE_V6, LAT_BUCKETS, BACKOFF,
    parseCidr, inCidr, isV6, isExcluded, isUsable, canonIp, hostname, cidrContains, validateRanges, v4ToInt, intToV4, v6ToBytes, bytesToV6,
    configuredHosts, degradedSnapshot, DROP_REASONS,
    sampleRange, percentile, latencyScore, wilsonLower, scoreRow, nextState, isAvailable,
    ranges, plan, handout, submit, flushReports, aggregate, decay, syncPool, refill, edgeProbe,
    pick, audit, label, proberJs, proberPage, makeBatch, verifyBatch, knownTargets,
    ISPS, ispOf, banditOrder, detectBlocks, blockSnapshot, BLOCK, publishWindows, degradedSnapshot,
    bufferSize: () => REPORT_BUF.size,
    /**
     * Tunnel feedback — the second primary signal.
     *
     *   target  the SNI/Host the session actually used (scored in the host
     *           scope for the caller's ASN) — always available on an upgrade
     *   ep      the endpoint the client dialled, only when the client told us
     *           (``?ep=<ip>``): the Worker cannot see which clean address a
     *           client dialled, because TLS/SNI terminates on the hostname.
     *           Guessing it would be inventing a measurement, so it is optional.
     *
     * A 101 on the VLESS path is issued *after* validateUserFast/quota/expiry/
     * IP-limit, so it means "an authenticated account opened a tunnel through
     * this host".  It is a weaker sample than a browser probe (no latency, no
     * packet-level success), so it enters with weight 0.5 and a `tunnel`
     * provider tag, and it can never mark an address unavailable.
     */
    feedback: async (env, uuid, target, ok, asn, ep, opts = {}) => {
      const asnS = asn ? String(asn) : null;
      const weight = Number.isFinite(opts.weight) ? opts.weight : 0.5;
      const provider = opts.provider || 'tunnel';
      const recorded = [];
      /* A tunnel report confirms a candidate; it never creates one.  Both the
         handle and the dialled address must already be known — a configured
         host for the handle, an existing score row for the address — because
         the upgrade itself is unauthenticated (VLESS authenticates on the first
         frame, not at 101), so anything the client names would otherwise be
         attacker-chosen input to the ranking. */
      const check = opts.trusted !== true;          /* only the operator API may seed */
      const known = check ? await knownTargets(env, asnS, { ownHost: opts.ownHost }) : null;
      const host = hostname(target);
      if (host && check && !known.hosts.has(host)) {
        /* the reason matters: "nobody configured a domain" is an operator
           mistake, "this name is not ours" is an attack */
        const why = known.cfg_size === 0 && known.scored === 0 ? 'no-hosts' : 'unknown-host';
        QV.count(why === 'no-hosts' ? 'ci_feedback_dropped_nohosts' : 'ci_feedback_unknown_host');
        DROP_REASONS[why] = (DROP_REASONS[why] || 0) + 1;
        DROP_REASONS['last_' + why] = host;
        if (why === 'no-hosts') noteDegrade('feedback', 'HOSTS/CUSTOM_DOMAIN unset and no host row yet: tunnel feedback dropped');
        return { ok: false, error: why };
      }
      const first = fbOnce(uuid, host || canonIp(ep || target) || '-');
      if (!first) { QV.count('ci_feedback_dedup'); return { ok: true, dedup: true, recorded: [] }; }
      if (host) {
        accept({ ip: host, family: 'host', provider, ok: !!ok, tlsOk: !!ok, wsOk: !!ok, rttMs: null, suspect: 0, weight },
          { asn: asnS, family: 'host', provider });
        recorded.push(host);
      }
      const ip = canonIp(ep || (!host ? target : null));
      if (ip && check && !known.ips.has(ip)) { QV.count('ci_feedback_unknown_ip'); return { ok: false, error: 'unknown-endpoint' }; }
      if (ip && isUsable(ip, { nat64: true })) {
        accept({ ip, family: isV6(ip) ? 'v6' : 'v4', provider, ok: !!ok, tlsOk: !!ok, wsOk: !!ok, rttMs: null, suspect: 0, weight },
          { asn: asnS, family: isV6(ip) ? 'v6' : 'v4', provider });
        recorded.push(ip);
      }
      if (!recorded.length) { QV.count('ci_feedback_skipped'); return { ok: false, error: 'nothing-recorded' }; }
      QV.count(ok ? 'ci_feedback_ok' : 'ci_feedback_fail');
      if (REPORT_BUF.size >= 120) {
        const flush = flushReports(env, null, { limit: FLUSH_ROWS * 4 });
        return { ok: true, recorded, flushed: await flush };
      }
      return { ok: true, recorded, buffered: REPORT_BUF.size };
    },
  };
})();
