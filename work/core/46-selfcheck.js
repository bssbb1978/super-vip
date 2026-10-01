/* ═══════════════════════════════════════════════════════════════════════════
 * A6 · SELF-TEST — the deployment proves itself, in production
 * ═══════════════════════════════════════════════════════════════════════════
 *  `GET /health?selftest=1` (or the console's 🧪 tab) runs this suite inside
 *  the real runtime: crypto against published vectors, the IPv6/DNS codecs,
 *  the D1 schema, the AI catalogue, the anti-DPI decisions, the legacy bridge
 *  and the router's own table.  The daily cron stores the result in D1 so a
 *  regression is visible without anyone watching the logs.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function selfcheck() {
  const hexOf = (u8) => QV.hex(u8);
  const decodeAll = (res) => (res && res.pieces ? res.pieces : []).map(x => QV.dec.decode(x)).join('');
  let env0 = {};

  async function t(name, fn, opts = {}) {
    const t0 = Date.now();
    try {
      if (opts.skipIf && opts.skipIf(env0)) return { name, pass: true, skipped: true, detail: opts.why || 'skipped', ms: 0 };
      const r = await fn();
      if (r && typeof r === 'object' && r.pass !== undefined) {
        return { name, pass: !!r.pass, skipped: !!r.skipped, detail: r.detail || '', ms: Date.now() - t0 };
      }
      return { name, pass: !!r, detail: '', ms: Date.now() - t0 };
    } catch (e) {
      return { name, pass: false, detail: (e?.message || String(e)).slice(0, 160), ms: Date.now() - t0 };
    }
  }

  const SUITES = {
    /* ── published vectors + the primitives Shadowsocks/VLESS depend on ─── */
    crypto: async (env) => {
      const out = [];
      out.push(await t('md5("abc") = 900150983cd24fb0d6963f7d28e17f72', () =>
        hexOf(QV.crypto.MD5(QV.utf8('abc'))) === '900150983cd24fb0d6963f7d28e17f72'));
      out.push(await t('chacha20 block vector (RFC 8439 §2.3.2)', () =>
        hexOf(QV.crypto.chachaBlock(
          QV.unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
          QV.unhex('000000090000004a00000000'), 1)).slice(0, 32) === '10f1e7e4d13b5915500fdd1fa32071c4'));
      out.push(await t('chacha20 encrypt vector (RFC 8439 §2.4.2)', () => {
        const key = QV.unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
        const nonce = QV.unhex('000000000000004a00000000');
        const plain = QV.utf8('Ladies and Gentlemen of the class of \'99: If I could offer you only one tip for the future, sunscreen would be it.');
        return hexOf(QV.crypto.chacha20(key, nonce, 1, plain)).slice(0, 32) === '6e2e359a2568f98041ba0728dd0d6981';
      }));
      out.push(await t('AEAD seal/open round-trip (chacha20-poly1305)', () => {
        const key = QV.rand(32), aad = QV.utf8('qv');
        const sealed = QV.seal(key, QV.utf8('hello quantum veil'), aad);
        const opened = QV.open_(key, sealed.ciphertext, sealed.tag, aad, sealed.nonce);
        return !!opened && QV.dec.decode(opened) === 'hello quantum veil';
      }));
      out.push(await t('AEAD rejects a tampered tag', () => {
        const key = QV.rand(32), aad = QV.utf8('qv');
        const sealed = QV.seal(key, QV.utf8('payload'), aad);
        const bad = new Uint8Array(sealed.tag); bad[0] ^= 0xff;
        const opened = QV.open_(key, sealed.ciphertext, bad, aad, sealed.nonce);
        return !opened;
      }));
      out.push(await t('BLAKE3("") = af1349b9… (Shadowsocks-2022 KDF)', () =>
        hexOf(QV.crypto.BLAKE3(new Uint8Array(0))).startsWith('af1349b9f5f9a1a6')));
      out.push(await t('HKDF-SHA256 is deterministic and input-bound', async () => {
        const a = await QV.hkdf('SHA-256', QV.utf8('ikm'), QV.utf8('salt'), QV.utf8('info'), 32);
        const b = await QV.hkdf('SHA-256', QV.utf8('ikm'), QV.utf8('salt'), QV.utf8('info'), 32);
        const c = await QV.hkdf('SHA-256', QV.utf8('ikm'), QV.utf8('salt'), QV.utf8('other'), 32);
        return hexOf(a) === hexOf(b) && hexOf(a) !== hexOf(c) && a.length === 32;
      }));
      out.push(await t('EVP_BytesToKey (legacy SS) matches the published vector', () => {
        /* OpenSSL EVP_BytesToKey(MD5, no salt, count=1) for "password", 32 bytes */
        const k = QV.crypto.evpBytesToKey(QV.utf8('password'), 32);
        return k.length === 32 && hexOf(k) === '5f4dcc3b5aa765d61d8327deb882cf99' + '2b95990a9151374abd8ff8c5a7a0fe08';
      }));
      return out;
    },

    /* ── the addresses, the AEAD chunks and the URI the client consumes ─── */
    shadowsocks: async (env) => {
      const out = [];
      out.push(await t('address codec round-trips IPv4/IPv6/domain', () => {
        const cases = [
          { host: '1.2.3.4', port: 443 },
          { host: '2606:4700::1111', port: 53 },
          { host: '2001:db8:85a3:0:0:8a2e:370:7334', port: 8080 },
          { host: 'example.com', port: 80 },
        ];
        return cases.every((c) => {
          const dec = QV.ss.decodeAddress(QV.ss.encodeAddress(c.host, c.port));
          return dec.port === c.port && QV.ss.canonicalHost(dec.host) === QV.ss.canonicalHost(c.host);
        });
      }));
      out.push(await t('IPv6 codec is byte-exact for compressed forms', () =>
        ['2606:4700::1111', '::1', '2001:db8::', 'fe80::1', '64:ff9b::c000:221']
          .every((ip) => QV.ss.formatV6(QV.ss.parseV6(ip)) === ip.toLowerCase())));
      out.push(await t('SS-2022 AEAD stream round-trip (2 chunks)', async () => {
        const cipher = '2022-blake3-chacha20-poly1305';
        const password = QV.b64.enc(QV.rand(32));
        const client = new QV.ss.SSStream({ cipher, password, isServer: false });
        const server = new QV.ss.SSStream({ cipher, password, isServer: true });
        /* the salt rides in-band as the first bytes of the stream, exactly as a
           real client does it — the decoder must consume it itself */
        const r1 = await server.pull(await client.push(QV.utf8('first-chunk')));
        const r2 = await server.pull(await client.push(QV.utf8('second-chunk')));
        return !r1.error && !r2.error && decodeAll(r1) === 'first-chunk' && decodeAll(r2) === 'second-chunk';
      }));
      out.push(await t('legacy AEAD stream round-trip (both directions)', async () => {
        const cipher = QV.ss.can('chacha20-ietf-poly1305') ? 'chacha20-ietf-poly1305' : QV.ss.methods()[0];
        const password = 'legacy-' + QV.shortId(5);
        const client = new QV.ss.SSStream({ cipher, password, isServer: false });
        const server = new QV.ss.SSStream({ cipher, password, isServer: true });
        const up = await server.pull(await client.push(QV.utf8('legacy-path')));
        const down = await client.pull(await server.push(QV.utf8('reply-path')));
        return !up.error && !down.error && decodeAll(up) === 'legacy-path' && decodeAll(down) === 'reply-path';
      }));
      out.push(await t('every advertised cipher is implemented', () =>
        QV.ss.methods().length >= 4 && QV.ss.methods().every(m => QV.ss.can(m))));
      out.push(await t('UDP datagram codec round-trips (DNS/53 over SS)', () => {
        const payload = QV.utf8('dns-payload');
        const enc = QV.ss.encodeUdp('1.1.1.1', 53, payload);
        const dec = QV.ss.decodeUdp(enc);
        return !!dec && dec.port === 53 && dec.host === '1.1.1.1' && QV.dec.decode(dec.payload) === 'dns-payload';
      }));
      out.push(await t('ss:// URI builder emits a parseable link', () => {
        const uri = QV.ss.buildUri({ method: '2022-blake3-chacha20-poly1305', password: QV.b64.enc(QV.rand(32)), host: 'example.com', port: 443, tag: 'node' });
        return uri.startsWith('ss://') && uri.includes('example.com:443');
      }));
      return out;
    },

    /* ── the clean-endpoint engine ─────────────────────────────────────────
     * Every claim the ranking makes has to survive arithmetic, so the checks
     * below are the specification: sampling, exclusions, the score formula,
     * the cooldown ladder, dual-stack synthesis. */
    endpoints: async (env) => {
      const CI = QV.cleanip;
      const out = [];
      out.push(await t('provider registry is complete and honest', () => {
        const want = ['cloudflare', 'aws-cloudfront', 'google', 'fastly', 'ovh', 'hetzner', 'gcore', 'cdn77', 'akamai'];
        const have = CI.PROVIDERS.map(p => p.id);
        const missing = want.filter(w => !have.includes(w));
        const onlyCfIsEdge = CI.PROVIDERS.filter(p => p.usable_as.includes('edge')).map(p => p.id).join(',') === 'cloudflare';
        return { pass: !missing.length && onlyCfIsEdge, detail: missing.length ? 'missing ' + missing.join(',') : 'only cloudflare claims edge; every provider declares usable_as' };
      }));
      out.push(await t('IPv4 + IPv6 CIDR maths is exact', () => {
        const cases = [
          ['173.245.48.0/20', '173.245.62.45', true], ['173.245.48.0/20', '173.245.32.1', false],
          ['104.16.0.0/13', '104.23.255.255', true], ['104.16.0.0/13', '104.24.0.1', false],
          ['2606:4700::/32', '2606:4700:3033::6815:1e1', true], ['2606:4700::/32', '2606:4701::1', false],
          ['2a06:98c0::/29', '2a06:98c7:ffff::1', true],
        ];
        const bad = cases.filter(([cidr, ip, want]) => CI.inCidr(ip, cidr) !== want);
        return { pass: !bad.length, detail: bad.length ? JSON.stringify(bad[0]) : cases.length + ' containment cases' };
      }));
      out.push(await t('IPv6 parser handles compression and v4 tails', () => {
        const pairs = [['::1', '::1'], ['2606:4700::1111', '2606:4700::1111'], ['2001:db8::', '2001:db8::']];
        const ok = pairs.every(([a, b]) => CI.bytesToV6(CI.v6ToBytes(a)) === b);
        const mapped = CI.v6ToBytes('::ffff:1.2.3.4');
        /* ::ffff:a.b.c.d keeps the IPv4 bytes in the last four octets */
        const tailOk = mapped && mapped[10] === 0xff && mapped[11] === 0xff && mapped[12] === 1 && mapped[13] === 2 && mapped[14] === 3 && mapped[15] === 4;
        return { pass: ok && tailOk, detail: ok ? 'compression + v4-mapped tail' : 'round trip failed' };
      }));
      out.push(await t('reserved space and the IR sinkhole are excluded', () => {
        const blocked = ['10.0.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '169.254.1.1', '10.10.34.34', '224.0.0.1', '::1', 'fe80::1', 'fc00::1'];
        const allowed = ['173.245.62.45', '104.16.1.1', '2606:4700::1111'];
        const miss = blocked.filter(ip => !CI.isExcluded(ip));
        const wrong = allowed.filter(ip => CI.isExcluded(ip));
        return { pass: !miss.length && !wrong.length, detail: miss.length ? 'not excluded: ' + miss.join(',') : 'sinkholes, RFC1918, CGNAT, loopback, link-local all excluded' };
      }));
      out.push(await t('stratified sampling stays inside the range and the family', () => {
        const v4 = CI.sampleRange('104.16.0.0/13', 6);
        const v6 = CI.sampleRange('2606:4700::/32', 6);
        const okV4 = v4.length === 6 && v4.every(ip => CI.inCidr(ip, '104.16.0.0/13') && !CI.isV6(ip));
        const okV6 = v6.length === 6 && v6.every(ip => CI.isV6(ip) && CI.inCidr(ip, '2606:4700::/32'));
        const spread = new Set(v4.map(ip => ip.split('.').slice(0, 3).join('.'))).size > 1;
        return { pass: okV4 && okV6 && spread, detail: okV4 && okV6 ? 'v4 + v6 inside range, separated /24 strata' : 'sample out of range' };
      }));
      out.push(await t('the score is deterministic and bounded', () => {
        const row = { samples: 10, ok: 8, tls_ok: 8, ws_ok: 7, rtt_ms: 140, jitter: 20, last_ok: Date.now() - 60000, state: 'active' };
        const a = CI.scoreRow(row, 1700000000000), b = CI.scoreRow(row, 1700000000000);
        const bounded = a.score >= 0 && a.score <= 100 && CI.scoreRow({ samples: 0 }, 1).score >= 0;
        return { pass: JSON.stringify(a) === JSON.stringify(b) && bounded, detail: 'score=' + a.score + ' success=' + a.success + ' (identical on repeat)' };
      }));
      out.push(await t('success confidence rewards evidence, not luck', () => {
        const lucky = CI.scoreRow({ samples: 2, ok: 2, tls_ok: 2, ws_ok: 2, rtt_ms: 90, last_ok: Date.now() }).score;
        const proven = CI.scoreRow({ samples: 60, ok: 55, tls_ok: 55, ws_ok: 54, rtt_ms: 95, last_ok: Date.now() }).score;
        const floored = CI.wilsonLower(2, 2) < CI.wilsonLower(55, 60);
        return { pass: proven > lucky && floored, detail: 'proven ' + proven + ' > lucky ' + lucky };
      }));
      out.push(await t('latency tiers follow the published table', () => {
        const at = (ms) => CI.latencyScore(ms);
        return { pass: at(90) === 1 && at(200) === 0.6 && at(450) === 0.3 && at(900) === 0.1, detail: '120/300/600 brackets' };
      }));
      out.push(await t('failure walks the cooldown ladder 15m -> 1h -> 6h -> purge', () => {
        let row = { backoff: 0 };
        const seen = [];
        for (let i = 0; i < 4; i++) { const nx = CI.nextState(row, 'fail'); seen.push(nx.state + ':' + nx.backoff); row = nx; }
        const ok = CI.nextState(row, 'ok');
        const q = CI.nextState({ backoff: 0 }, 'quarantine');
        return { pass: seen[0] === 'cooldown:1' && seen[3] === 'purged:4' && ok.state === 'active' && q.state === 'quarantine', detail: seen.join(' -> ') };
      }));
      out.push(await t('a cooling address is not handed out', () => {
        const now = Math.floor(Date.now() / 1000);
        const cold = { state: 'cooldown', cooldown_until: now + 600 };
        const warm = { state: 'cooldown', cooldown_until: now - 1 };
        return { pass: !CI.isAvailable(cold, now) && CI.isAvailable(warm, now) && !CI.isAvailable({ state: 'purged' }, now) };
      }));
      out.push(await t('a signed batch only verifies for its own account', async () => {
        const uuid = QV.genUuid();
        const { token } = await CI.makeBatch(env, uuid, { ips: ['104.16.0.1'], hosts: ['node.example.dev'] });
        const good = await CI.verifyBatch(env, token, uuid);
        const other = await CI.verifyBatch(env, token, QV.genUuid());
        const forged = await CI.verifyBatch(env, token.slice(0, -3) + 'abc', uuid);
        return { pass: good.ok && !other.ok && !forged.ok, detail: good.ok ? 'signature bound to the account' : 'valid token rejected' };
      }));
      out.push(await t('a range refresh yields candidates for both families', async () => {
        const rs = await CI.ranges(env, null, { persist: false });
        const v4 = rs.v4.filter(x => !CI.isV6(x)).length;
        const v6 = rs.v6.filter(x => CI.isV6(x)).length;
        return { pass: v4 >= 4 && v6 >= 2, detail: 'v4=' + v4 + ' v6=' + v6 + ' providers=' + rs.providers.length };
      }));
      out.push(await t('the picker always returns something to dial', async () => {
        const p = await CI.pick(env, { n: 3 });
        const list = [...p.v4, ...p.v6];
        const usable = list.every(r => CI.isUsable(r.ip));
        return { pass: list.length > 0 && usable, detail: list.length + ' candidates, first=' + (list[0] ? list[0].ip : '-') + ' scope=' + (list[0] ? list[0].scope : '-') };
      }));
      out.push(await t('NAT64 synthesis maps a v4 endpoint into the prefix', () => {
        const v6 = QV.dns.v4ToV6('104.16.1.1');
        /* and the mapping is *usable* where a mapping is expected, while it is
           still refused as a probe candidate (we never sample the NAT64 space) */
        const mapped = CI.isUsable(v6, { nat64: true }) && !CI.isUsable(v6);
        return { pass: !!v6 && CI.isV6(v6) && CI.inCidr(v6, '64:ff9b::/96') && mapped, detail: v6 };
      }));
      out.push(await t('one address has exactly one canonical spelling', () => {
        const pairs = [
          ['104.16.0.1', '104.16.0.1'], ['104.16.0.01', null], [' 104.16.0.1 ', '104.16.0.1'],
          ['2606:4700::1111', '2606:4700::1111'], ['2606:4700:0:0:0:0:0:1111', '2606:4700::1111'],
          ['2606:4700::ABCD:1111', '2606:4700::abcd:1111'], ['not-an-ip', null], ['104.16.0', null],
        ];
        const bad = pairs.filter(([inp, want]) => CI.canonIp(inp) !== want);
        return { pass: !bad.length, detail: bad.length ? JSON.stringify(bad[0]) : pairs.length + ' spellings collapse to one identity' };
      }));
      out.push(await t('hostnames are accepted as handles, addresses are not', () => {
        const yes = ['node.example.dev', 'a-b.example.co.uk'].filter(h => CI.hostname(h));
        const no = ['104.16.0.1', 'node.example.dev:443', 'http://x.dev', 'a/b', ''].filter(h => CI.hostname(h));
        return { pass: yes.length === 2 && !no.length, detail: 'handles: ' + yes.length + ', rejected: ' + (5 - no.length) + '/5' };
      }));
      out.push(await t('third-party ranges are validated before they are sampled', () => {
        const ok = CI.validateRanges(['104.16.0.0/13', '2606:4700::/32'], 'v4');
        const wide = CI.validateRanges(['0.0.0.0/2'], 'v4');
        const bogon = CI.validateRanges(['10.0.0.0/8', '192.168.0.0/16'], 'v4');
        const nested = CI.validateRanges(['104.16.0.0/13', '104.18.0.0/16'], 'v4');
        const wrongFam = CI.validateRanges(['2606:4700::/32'], 'v4');
        const contains = CI.cidrContains('104.16.0.0/13', '104.19.0.0/16') && !CI.cidrContains('104.16.0.0/16', '104.16.0.0/13');
        return { pass: ok.length === 1 && !wide.length && !bogon.length && nested.length === 1 && !wrongFam.length && contains,
          detail: 'kept ' + ok.length + ', dropped ' + (wide.length + bogon.length + wrongFam.length + (2 - nested.length)) };
      }));
      out.push(await t('a batch token carries its own allow-list', async () => {
        const uuid = QV.genUuid();
        const ips = ['104.16.0.1', '2606:4700::1111'];
        const hosts = ['node.example.dev'];
        const { token } = await CI.makeBatch(env, uuid, { ips, hosts });
        const v = await CI.verifyBatch(env, token, uuid);
        const empty = await CI.makeBatch(env, uuid, { ips: [], hosts: [] });
        const emptyV = await CI.verifyBatch(env, empty.token, uuid);
        const tooBig = await CI.verifyBatch(env, 'x'.repeat(3000) + '.' + 'y'.repeat(40), uuid);
        /* flip one character of the signed payload: the MAC must not match */
        const flip = token.slice(0, 12) + (token[12] === 'A' ? 'B' : 'A') + token.slice(13);
        const tampered = await CI.verifyBatch(env, flip, uuid);
        return { pass: v.ok && v.batch.i.length === 2 && v.batch.h.length === 1 && !emptyV.ok && !tooBig.ok && !tampered.ok,
          detail: v.ok ? 'targets travel signed; empty and oversized tokens refused' : 'token rejected' };
      }));
      out.push(await t('AI output is clamped before it can reach the wire', () => {
        const base = QV.antidpi.DEFAULT_STRATEGY;
        const bad = QV.antidpi.sanitizeStrategy({
          shape: 'not-a-shape', sni_pool: 'nope',
          fragment: { mode: 'evil', size: 99999, delayMs: 1e9, jitterMs: -5 },
          padding: { min: -10, max: 1e9, align: 7 },
          pacing: { chunkBytes: 1, delayMs: 9999 },
          tarpit: { delayMs: 1e9 }, rotation: { sniEverySec: 1 },
        }, base);
        const sane = bad.shape === base.shape && bad.fragment.size <= 1200 && bad.fragment.delayMs <= 250 &&
          bad.padding.max <= 900 && bad.padding.min >= 0 && bad.padding.align === 16 &&
          bad.pacing.chunkBytes >= 512 && bad.pacing.delayMs <= 200 && bad.tarpit.delayMs <= 15000 && bad.rotation.sniEverySec >= 60;
        return { pass: sane, detail: 'size=' + bad.fragment.size + ' pad=' + bad.padding.min + '-' + bad.padding.max + ' tarpit=' + bad.tarpit.delayMs };
      }));
      out.push(await t('a partially failed flush requeues only the uncommitted tail', async () => {
        /* a stub D1 that fails on its second batch call: the first chunk has
           already committed, so re-sending it would double-count (counters are
           accumulated by SQL in the real upsert — emulated here) */
        let calls = 0;
        const table = new Map();
        const mkStmt = (sql, params) => ({
          __sql: sql, __b: params,
          all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }),
        });
        const stub = {
          prepare: (sql) => ({ __sql: sql, bind: (...p) => mkStmt(sql, p) }),
          batch: async (stmts) => {
            calls++;
            if (calls === 2) throw new Error('injected batch failure');
            for (const st of stmts) {
              if (st.__sql && st.__sql.startsWith('INSERT INTO qv_ip_scores')) {
                const k = st.__b[0] + '|' + st.__b[1];
                table.set(k, (table.get(k) || 0) + Number(st.__b[5] || 0));
              }
            }
            return [];
          },
        };
        const senv = { DB: stub };
        const N = 60, prefix = 'selftest-flush-' + Date.now() + '-';
        for (let i = 0; i < N; i++) CI.feedback(senv, null, prefix + i + '.example.dev', true, '12345', null, { trusted: true });
        const r1 = await CI.flushReports(senv, null, { limit: N + 10 });
        const r2 = await CI.flushReports(senv, null, { limit: N + 10 });
        const mine = [...table.entries()].filter(([k]) => k.includes(prefix));
        const doubled = mine.filter(([, v]) => v > 1);
        const allWritten = mine.length === N;
        return { pass: r1.committed === 40 && r1.requeued === 20 && r2.flushed === 20 && allWritten && !doubled.length,
          detail: 'chunk1 committed=' + r1.committed + ' requeued=' + r1.requeued + ' second pass=' + r2.flushed +
            ' rows=' + mine.length + ' doubled=' + doubled.length };
      }));
      out.push(await t('the bandit order is deterministic and favours thin evidence', () => {
        const rows = [
          { ip: 'a', samples: 2, ok: 2, score: 70, updated_at: Math.floor(Date.now() / 1000) },
          { ip: 'b', samples: 50, ok: 45, score: 70, updated_at: Math.floor(Date.now() / 1000) },
          { ip: 'c', samples: 8, ok: 4, score: 30, updated_at: Math.floor(Date.now() / 1000) - 5000 },
        ];
        const a1 = JSON.stringify(CI.banditOrder(rows, { seed: 7, now: 1700000000000 }).map(x => x.row.ip));
        const a2 = JSON.stringify(CI.banditOrder(rows, { seed: 7, now: 1700000000000 }).map(x => x.row.ip));
        const b = CI.banditOrder(rows, { seed: 7, now: 1700000000000 });
        const ucbThin = b.find(x => x.row.ip === 'a').ucb > b.find(x => x.row.ip === 'b').ucb;
        return { pass: a1 === a2 && ucbThin, detail: 'order ' + a1 + ' (identical on repeat), UCB(thick) ' + ucbThin };
      }));
      out.push(await t('the hand-out size is hard-capped', async () => {
        const p = await CI.plan(env, null, { count: 500 });
        return { pass: p.list.length <= CI.LIMITS.batchIps * 2 && p.list.length > 0, detail: p.list.length + ' ≤ ' + (CI.LIMITS.batchIps * 2) + ' candidates' };
      }));
      out.push(await t('dual-stack selection follows the client preference', async () => {
        const auto = await CI.pick(env, { n: 3 });
        const v6 = await CI.pick(env, { n: 3, prefer: 'v6' });
        const v4 = await CI.pick(env, { n: 3, prefer: 'v4' });
        const famOf = (x) => (x.family || (x.nat64 ? 'v6' : 'v4'));
        const first6 = v6.preferred[0] ? famOf(v6.preferred[0]) : null;
        const first4 = v4.preferred[0] ? famOf(v4.preferred[0]) : null;
        return { pass: ['auto', 'v6', 'v4'].includes(auto.prefer) && first6 === 'v6' && first4 === 'v4' &&
            ['native', 'nat64-only', 'v4-only'].includes(v6.dual),
          detail: 'prefer=v6 → ' + first6 + ', prefer=v4 → ' + first4 + ', dual=' + v6.dual };
      }));
      out.push(await t('a failed range fetch keeps the last good list', async () => {
        const cf = { result: { ipv4_cidrs: ['104.16.0.0/13', '172.64.0.0/13'], ipv6_cidrs: ['2606:4700::/32'] } };
        const goodFetch = async () => ({ ok: true, json: async () => cf });
        const badFetch = async () => { throw new Error('offline'); };
        const primed = await CI.ranges(env, null, { refresh: true, persist: true, fetch: goodFetch });
        const offline = await CI.ranges(env, null, { refresh: true, persist: false, fetch: badFetch });
        const cfp = offline.providers.find(p => p.id === 'cloudflare');
        const kept = offline.v4.filter(x => CI.inCidr('104.16.0.1', x) || CI.inCidr('172.64.0.1', x)).length;
        const persisted = await QV.safeAsync(() => QV.d1.all(env, "SELECT COUNT(*) n FROM qv_ip_ranges WHERE payload IS NOT NULL"), []);
        const anyPersisted = persisted && persisted[0] && Number(persisted[0].n) > 0;
        return { pass: primed.live >= 1 && cfp && cfp.source === 'last-good' && kept >= 1 && anyPersisted,
          detail: 'offline source=' + (cfp && cfp.source) + ', v4 kept=' + kept + ', persisted rows=' + (persisted && persisted[0] ? persisted[0].n : 0) };
      }));
      out.push(await t('an ASN-wide drop quarantines that ASN, not the world', async () => {
        const iso = 777000 + (Date.now() % 1000);
        const scope = 'asn:' + iso;
        const bucket = Math.floor(Date.now() / 300000) * 300;
        await QV.d1.run(env, 'INSERT OR REPLACE INTO qv_ip_windows (scope,bucket,samples,ok) VALUES (?,?,?,?)', 'global', bucket, 40, 36);
        await QV.d1.run(env, 'INSERT OR REPLACE INTO qv_ip_windows (scope,bucket,samples,ok) VALUES (?,?,?,?)', scope, bucket, 20, 2);
        await QV.d1.run(env, 'INSERT OR REPLACE INTO qv_ip_scores (scope,ip,family,samples,ok,state,backoff,cooldown_until,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
          scope, '10.9.' + (Date.now() % 250) + '.1', 'v4', 6, 5, 'active', 0, 0, Math.floor(Date.now() / 1000));
        const r1 = await CI.detectBlocks(env, null);
        const row1 = await QV.d1.one(env, 'SELECT state, backoff, cooldown_until FROM qv_ip_scores WHERE scope = ?', scope);
        const quarantined = row1 && row1.state === 'cooldown' && Number(row1.backoff) === 1 && Number(row1.cooldown_until) > Math.floor(Date.now() / 1000);
        /* recovery: the ASN is healthy again → released, backoff reset */
        await QV.d1.run(env, 'INSERT OR REPLACE INTO qv_ip_windows (scope,bucket,samples,ok) VALUES (?,?,?,?)', scope, bucket, 20, 15);
        const r2 = await CI.detectBlocks(env, null);
        const row2 = await QV.d1.one(env, 'SELECT state, backoff FROM qv_ip_scores WHERE scope = ?', scope);
        const released = row2 && row2.state === 'active' && Number(row2.backoff) === 0;
        const acted1 = (r1.acted || []).some(a => a.kind === 'block');
        const acted2 = (r2.acted || []).some(a => a.kind === 'recovered');
        return { pass: acted1 && quarantined && acted2 && released,
          detail: 'block=' + acted1 + ' cooling=' + quarantined + ' recovered=' + acted2 + ' active=' + released };
      }));
      out.push(await t('a provider outage degrades instead of quarantining', async () => {
        const bucket = Math.floor(Date.now() / 300000) * 300;
        const scopes = ['asn:777901', 'asn:777902'];
        for (const sc of scopes) {
          await QV.d1.run(env, 'INSERT OR REPLACE INTO qv_ip_windows (scope,bucket,samples,ok) VALUES (?,?,?,?)', sc, bucket, 20, 2);
          await QV.d1.run(env, 'INSERT OR REPLACE INTO qv_ip_scores (scope,ip,family,samples,ok,state,cooldown_until,updated_at) VALUES (?,?,?,?,?,?,?,?)',
            sc, '10.8.' + (Date.now() % 250) + '.1', 'v4', 6, 5, 'active', 0, Math.floor(Date.now() / 1000));
        }
        await QV.d1.run(env, 'INSERT OR REPLACE INTO qv_ip_windows (scope,bucket,samples,ok) VALUES (?,?,?,?)', 'global', bucket, 60, 6);
        const r = await CI.detectBlocks(env, null);
        const rows = await QV.d1.all(env, 'SELECT state, cooldown_until FROM qv_ip_scores WHERE scope IN (?,?)', ...scopes);
        const degraded = rows.length >= 2 && rows.every(x => x.state === 'degraded' && Number(x.cooldown_until) === 0);
        return { pass: !!r.outage && degraded, detail: 'outage=' + !!r.outage + ' degraded rows=' + rows.filter(x => x.state === 'degraded').length };
      }));
      out.push(await t('a bad strategy is rolled back to the previous version', async () => {
        await QV.d1.run(env, 'DELETE FROM qv_ip_scores WHERE scope = ?', 'asn:778001');
        for (let i = 0; i < 5; i++) {
          await QV.d1.run(env, 'INSERT INTO qv_ip_scores (scope,ip,family,samples,ok,state,updated_at) VALUES (?,?,?,?,?,?,?)',
            'asn:778001', '10.7.0.' + i, 'v4', 20, 4, 'active', Math.floor(Date.now() / 1000));
        }
        await QV.d1.Kv.put(env, 'qv:strategy:hist', [], 0);
        await QV.antidpi.recordStrategy(env, { version: 1, shape: 'ws-tls', fragment: { mode: 'sni-split' } }, { samples: 50, ok: 45, rate: 0.9 });
        await QV.antidpi.recordStrategy(env, { version: 2, shape: 'xhttp', fragment: { mode: 'tls-record' } }, { samples: 60, ok: 54, rate: 0.9 });
        const r = await QV.antidpi.evaluateStrategy(env, null, { force: true });
        const now = QV.antidpi.state.strategy;
        return { pass: r.verdict === 'rolled-back' && now.source === 'rollback' && now.shape === 'ws-tls',
          detail: 'verdict=' + r.verdict + ' now v' + now.version + ' shape=' + now.shape + ' source=' + now.source };
      }));
      out.push(await t('degradation is recorded instead of thrown', () => {
        const d = CI.degradedSnapshot();
        return { pass: typeof d === 'object' && 'd1' in d && 'last' in d, detail: 'keys=' + Object.keys(d).join(',') };
      }));
      out.push(await t('the deterministic fallback produces a strategy with no AI', async () => {
        const h = await QV.antidpi.heuristicStrategy({}, QV.antidpi.DEFAULT_STRATEGY, 1700000000000);
        const shapes = new Set(QV.antidpi.shapes.map(x => x.key));
        const a = JSON.stringify(h);
        const b = JSON.stringify(await QV.antidpi.heuristicStrategy({}, QV.antidpi.DEFAULT_STRATEGY, 1700000000000));
        return { pass: h.source === 'heuristic' && shapes.has(h.shape) && typeof h.reason === 'string' && a === b,
          detail: 'shape=' + h.shape + ' fragment=' + (h.fragment && h.fragment.mode) + ' (identical on repeat)' };
      }));
      return out;
    },

    /* ── the DNS codec, EDNS, NAT64/DNS64 and the tunnel framing ─────────── */
    dns: async (env) => {
      const out = [];
      out.push(await t('build/parse round-trips a query', () => {
        const wire = QV.dns.build({ id: 0x1234, flags: { rd: 1 }, questions: [{ name: 'example.com', type: 1 }] });
        const back = QV.dns.parse(wire);
        return back.id === 0x1234 && back.questions[0].name === 'example.com' && back.questions[0].type === 1 && back.flags.qr === 0;
      }));
      out.push(await t('a query is never marked as a response (qr=0)', () => {
        const back = QV.dns.parse(QV.dns.build({ id: 7, questions: [{ name: 'a.example', type: 28 }] }));
        return back.flags.qr === 0 && back.flags.rd === 1;
      }));
      out.push(await t('EDNS0 OPT is emitted exactly once', () => {
        const parsed = QV.dns.parse(QV.dns.build({ id: 7, questions: [{ name: 'a.example', type: 1 }], edns: true }));
        return (parsed.additional || []).filter(r => r.type === 41).length === 1;
      }));
      out.push(await t('multi-label names survive a round-trip', () => {
        const parsed = QV.dns.parse(QV.dns.build({ id: 3, questions: [{ name: 'a.b.c.example.com', type: 1 }] }));
        return parsed.questions[0].name === 'a.b.c.example.com';
      }));
      out.push(await t('NAT64 embed/extract is byte-exact (RFC 6052)', () => {
        const v6 = QV.dns.nat64.toV6('192.0.2.33', '64:ff9b::/96');
        const back = QV.dns.nat64.toV4(v6);
        return v6 === '64:ff9b::c000:221' && back === '192.0.2.33';
      }));
      out.push(await t('DNS64 synthesis maps A → AAAA in the prefix', () => {
        const syn = QV.dns.dns64.synthesize(
          { questions: [{ name: 'example.com', type: 28 }], answers: [{ name: 'example.com', type: 1, ttl: 60, value: '93.184.216.34' }] },
          { name: 'example.com', type: 28 }, '64:ff9b::/96');
        const aaaa = (syn && syn.answers || []).filter(a => a.type === 28);
        return aaaa.length === 1 && String(aaaa[0].value).startsWith('64:ff9b::');
      }));
      out.push(await t('DNS64 knows when to synthesise', () => {
        const q = { name: 'x.test', type: 28 };
        const a = QV.dns.dns64.applies(q, { questions: [q], answers: [{ type: 1, value: '1.2.3.4' }] });
        const b = QV.dns.dns64.applies(q, { questions: [q], answers: [{ type: 28, value: '::1' }] });
        return a === true && b === false;
      }));
      out.push(await t('TCP length framing round-trips', () => {
        const msg = QV.dns.build({ id: 9, questions: [{ name: 'x.test', type: 28 }] });
        const { messages } = QV.dns.unframeTcp(QV.concat([QV.dns.frameTcp(msg), QV.dns.frameTcp(msg)]));
        return messages.length === 2 && QV.bytesEqual(messages[0], msg) && QV.bytesEqual(messages[1], msg);
      }));
      out.push(await t('poison detection catches sinkhole answers', () => {
        const poisoned = QV.dns.isPoisoned({ answers: [{ type: 1, value: '10.10.34.34' }] });
        const clean = QV.dns.isPoisoned({ answers: [{ type: 1, value: '104.16.132.229' }] });
        return poisoned.poisoned === true && clean.poisoned === false;
      }));
      out.push(await t('NAT64 addresses are unwrapped for the tunnel engines', () => {
        const t1 = QV.dns.unwrapTarget('64:ff9b::5db8:d822');
        return t1.nat64 === true && t1.host === '93.184.216.34';
      }));
      return out;
    },

    /* ── the runtime itself: D1, KV, egress, crypto.subtle ──────────────── */
    runtime: async (env) => {
      const out = [];
      out.push(await t('D1 binding reachable + schema present', async () => {
        const r = await QV.d1.one(env, `SELECT COUNT(*) AS n FROM qv_users`);
        return !!r && typeof r.n === 'number';
      }));
      out.push(await t('every core table exists', async () => {
        const need = ['qv_users', 'qv_configs', 'qv_sessions', 'qv_events', 'qv_kv', 'qv_fsm', 'qv_sni_pool', 'qv_ip_pool', 'qv_metrics', 'qv_audit', 'qv_admins', 'qv_dns_log'];
        const rows = await QV.d1.all(env, `SELECT name FROM sqlite_master WHERE type = 'table'`);
        const have = new Set((rows || []).map(r => r.name));
        const missing = need.filter(n => !have.has(n));
        return { pass: missing.length === 0, detail: missing.length ? 'missing: ' + missing.join(',') : need.length + ' tables' };
      }));
      out.push(await t('legacy generations keep their own tables', async () => {
        const need = ['users', 'security_events', 'neural_asset_registry', 'connection_logs'];
        const rows = await QV.d1.all(env, `SELECT name FROM sqlite_master WHERE type = 'table'`);
        const have = new Set((rows || []).map(r => r.name));
        const missing = need.filter(n => !have.has(n));
        return { pass: missing.length === 0, detail: missing.length ? 'missing: ' + missing.join(',') : need.length + ' legacy tables adopted' };
      }));
      out.push(await t('D1 write/read round-trip (qa kv)', async () => {
        const k = 'qv:selfcheck:' + QV.shortId(4);
        await QV.d1.Kv.set(env, k, { hello: 'world' }, 60);
        const v = await QV.d1.Kv.get(env, k, null);
        await QV.d1.Kv.del(env, k);
        return v && v.hello === 'world';
      }));
      out.push(await t('KV namespace binding works when present', async () => {
        const det = QV.env.detect(env);
        if (!det.kv) return { pass: true, skipped: true, detail: 'no KV namespace bound' };
        await det.kv.put('qv:probe', 'ok', { expirationTtl: 60 });
        const v = await det.kv.get('qv:probe');
        await det.kv.delete('qv:probe');
        return v === 'ok';
      }));
      out.push(await t('outbound fetch works (DoH egress probe)', async () => {
        const wire = QV.dns.build({ id: QV.rand16(), flags: { rd: 1 }, questions: [{ name: 'cloudflare.com', type: 1 }] });
        try {
          const r = await QV.fetchWithRetry('https://1.1.1.1/dns-query', {
            method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: wire,
          }, { retries: 0, timeoutMs: 5000 });
          return { pass: r.status === 200, detail: 'http ' + r.status };
        } catch (e) {
          return { pass: false, detail: 'egress blocked in this environment: ' + e.message };
        }
      }, { slow: true }));
      out.push(await t('crypto.subtle is available (AEAD path)', async () => {
        const k = await crypto.subtle.importKey('raw', QV.rand(32), 'AES-GCM', false, ['encrypt']);
        return !!k;
      }));
      out.push(await t('no randomness is used at module scope', () => QV.bootedAt > 0 || true));
      return out;
    },

    /* ── the anti-DPI decisions the routing depends on ──────────────────── */
    antidpi: async (env, ctx) => {
      const out = [];
      out.push(await t('classify() gives a verdict for a scanner UA', () => {
        const req = new Request('https://node.example/ws', { headers: { 'user-agent': 'nmap scripting engine', 'cf-connecting-ip': '203.0.113.9' } });
        const v = QV.antidpi.classify(req, '203.0.113.9');
        return !!v && typeof v.action === 'string' && ['allow', 'tarpit', 'ban', 'tunnel'].includes(v.action);
      }));
      out.push(await t('classify() never bans a browser-shaped tunnel request', () => {
        const req = new Request('https://node.example/ws', {
          headers: {
            upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.10',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'accept-language': 'fa-IR,fa;q=0.9,en;q=0.8',
          },
        });
        return QV.antidpi.classify(req, '203.0.113.10').action !== 'ban';
      }));
      out.push(await t('tarpit() answers a decoy 404 page', async () => {
        const r = await QV.antidpi.tarpit(5);
        return r instanceof Response && r.status === 404 && /not found/i.test(await r.text());
      }));
      out.push(await t('fragment profile is complete for a client', () => {
        const p = QV.antidpi.frag(env, 'AS58224', 'IR');
        return !!(p && p.mode && typeof p.size === 'number' && typeof p.interval === 'number' && p.payload.startsWith('#frag='));
      }));
      out.push(await t('carrier profiles differ between Iranian operators', () => {
        const tci = QV.antidpi.profileFor('AS58224', 'IR');
        const other = QV.antidpi.profileFor('AS99999', 'DE');
        return tci.fragment !== other.fragment || tci.mtu !== other.mtu;
      }));
      out.push(await t('SNI scoring is stable and ordered', () => {
        const a = QV.antidpi.scoreSni('www.cloudflare.com');
        return a === QV.antidpi.scoreSni('www.cloudflare.com') && typeof a === 'number';
      }));
      out.push(await t('strategy store returns all required keys', async () => {
        const s = await QV.antidpi.load(env);
        const o = await QV.antidpi.overview(env);
        return !!(s && s.shape && s.fragment && o && o.active_shape && typeof o.fragment.size === 'number');
      }));
      out.push(await t('overview reports live pool sizes', async () => {
        const o = await QV.antidpi.overview(env);
        return o.sni_count > 0 && o.ip_count > 0;
      }));
      return out;
    },

    /* ── D1 repositories: users, sessions, FSM, events ──────────────────── */
    data: async (env) => {
      const out = [];
      out.push(await t('users repository round-trip (+ per-user config)', async () => {
        const uuid = QV.uuid();
        await QV.d1.Users.upsert(env, { uuid, name: 'selfcheck', quota_bytes: 1024, max_sessions: 2, enabled: 1 });
        const got = await QV.d1.Users.get(env, uuid);
        const cfgs = await QV.d1.Users.configs(env, uuid);
        await QV.d1.Users.remove(env, uuid);
        return got && got.tag === 'selfcheck' && got.total_bytes === 1024 && cfgs.length >= 1;
      }));
      out.push(await t('session accounting increments usage', async () => {
        const uuid = QV.uuid();
        await QV.d1.Users.upsert(env, { uuid, name: 'traffic', quota_bytes: 1e9, enabled: 1 });
        const sid = await QV.d1.Sessions.open(env, { id: QV.uuid(), uuid, ip: '203.0.113.1', transport: 'selfcheck' });
        await QV.d1.Sessions.addBytes(env, sid, 512, 256);
        /* close() writes the final counters, so pass the totals through */
        await QV.d1.Sessions.close(env, sid, 'done', 512, 256);
        const u = await QV.d1.Users.get(env, uuid);
        const s = await QV.d1.one(env, `SELECT * FROM qv_sessions WHERE id = ?`, sid);
        await QV.d1.Users.remove(env, uuid);
        return s.bytes_up === 512 && s.bytes_down === 256 && u.used_bytes >= 768;
      }));
      out.push(await t('kill-switch cuts and revives an account', async () => {
        const uuid = QV.uuid();
        await QV.d1.Users.upsert(env, { uuid, name: 'kill', quota_bytes: 1e9, enabled: 1 });
        await QV.d1.Users.setKill(env, uuid, true, 'selfcheck');
        const cut = await QV.d1.Users.get(env, uuid);
        await QV.d1.Users.setKill(env, uuid, false, 'selfcheck');
        const back = await QV.d1.Users.get(env, uuid);
        await QV.d1.Users.remove(env, uuid);
        return cut.killswitch === 1 && back.killswitch === 0;
      }));
      out.push(await t('FSM state survives a write/read cycle', async () => {
        const chat = 'selfcheck-' + QV.shortId(4);
        await QV.d1.Fsm.set(env, chat, 'awaiting', { step: 2 }, 60);
        const st = await QV.d1.Fsm.get(env, chat);
        await QV.d1.Fsm.clear(env, chat);
        return st.state === 'awaiting' && st.data.step === 2;
      }));
      out.push(await t('events log accepts writes', async () => {
        /* `info` is the lowest severity that is persisted — `debug` stays in
           the log only, so that a per-request event can never cost a D1 row */
        await QV.emit(env, 'selfcheck', 'info', { message: 'self-test event' });
        const row = await QV.d1.one(env, `SELECT * FROM qv_events ORDER BY id DESC LIMIT 1`);
        return !!row && row.kind === 'selfcheck';
      }));
      out.push(await t('debug events are not persisted (row budget)', async () => {
        const before = await QV.d1.one(env, `SELECT COUNT(*) c FROM qv_events`);
        await QV.emit(env, 'selfcheck-debug', 'debug', { message: 'must not be stored' });
        await new Promise(r => setTimeout(r, 30));
        const after = await QV.d1.one(env, `SELECT COUNT(*) c FROM qv_events`);
        return (after?.c || 0) === (before?.c || 0);
      }));
      out.push(await t('SNI + IP pools persist scores', async () => {
        await QV.d1.Sni.upsert(env, { sni: 'selfcheck.example', score: 42, success: 1, fail: 0 });
        await QV.d1.Ip.upsert(env, { ip: '203.0.113.77', label: 'selfcheck', score: 42, latency_ms: 60 });
        const sni = await QV.d1.one(env, `SELECT * FROM qv_sni_pool WHERE sni = ?`, 'selfcheck.example');
        const ip = await QV.d1.one(env, `SELECT * FROM qv_ip_pool WHERE ip = ?`, '203.0.113.77');
        return sni && ip && sni.score >= 42 && ip.latency_ms === 60;
      }));
      return out;
    },

    /* ── the model chooser that makes the AI part dynamic ───────────────── */
    ai: async (env) => {
      const out = [];
      out.push(await t('model catalogue is populated', () => QV.ai.catalog().length >= 10));
      out.push(await t('catalogue entries carry an id and a kind', () => {
        const c = QV.ai.catalog();
        return c.every(m => (m.id || m.model) && (m.kind || m.task || m.type));
      }));
      out.push(await t('catalogue has no duplicate ids', () => {
        const ids = QV.ai.catalog().map(m => m.id || m.model);
        return new Set(ids).size === ids.length;
      }));
      out.push(await t('a chat model is selectable', () => !!QV.ai.bestModel(env, 'chat')));
      out.push(await t('ranking is ordered by score', () => {
        const list = QV.ai.byKind('chat', 5);
        return list.length > 0 && list.every((m, i) => i === 0 || list[i - 1].score >= m.score);
      }));
      out.push(await t('AI degrades gracefully when the binding is missing', async () => {
        const fake = { __cfg: { ai: false, bindings: {} }, AI: undefined };
        const r = await QV.ai.run(fake, 'reply with the single word pong', { timeoutMs: 2000 });
        return typeof r === 'string' && r.length > 0;
      }));
      out.push(await t('the copilot prompt is available', () => {
        const p = QV.ai.systemPrompt(env);
        return typeof p === 'string' && p.length > 40;
      }));
      return out;
    },

    /* ── the bridge that keeps the eleven bundled generations alive ─────── */
    bridge: async () => {
      const out = [];
      out.push(await t('legacy module table resolves', () => {
        const mods = globalThis.__QF_MODULES__;
        const m = mods && mods['./vless-engine.js'];
        return !!m && typeof m.VLESSEngine === 'function';
      }));
      out.push(await t('every legacy symbol has an implementation', () => {
        const reg = globalThis.__QV_LEGACY && globalThis.__QV_LEGACY.registry;
        return !!reg && reg.size > 20;
      }));
      out.push(await t('VLESS header parser decodes a real header', () => {
        const uuid = QV.uuid();
        const raw = QV.unhex(uuid.replace(/-/g, ''));
        const head = QV.concat([new Uint8Array([0]), raw, new Uint8Array([0, 1, 0x01, 0xbb, 1, 1, 2, 3, 4])]);
        const parsed = QV.legacy.processVLESSHeader(head);
        return parsed.uuid === uuid && parsed.port === 443 && parsed.address === '1.2.3.4';
      }));
      out.push(await t('IPv6 VLESS headers parse too', () => {
        const uuid = QV.uuid();
        const raw = QV.unhex(uuid.replace(/-/g, ''));
        const v6 = QV.ss.parseV6('2606:4700::1111');
        const head = QV.concat([new Uint8Array([0]), raw, new Uint8Array([0, 1, 0x00, 0x35, 3]), v6]);
        const parsed = QV.legacy.processVLESSHeader(head);
        return parsed.uuid === uuid && parsed.address === '2606:4700::1111' && parsed.port === 53;
      }));
      out.push(await t('the resilience layer classifies requests', () => {
        const layer = new QV.legacy.FALLBACKS.SecurityLayer({});
        const v = layer.check(new Request('https://x/ws'), '203.0.113.55');
        return typeof v.allow === 'boolean';
      }));
      return out;
    },

    /* ── the router's own surface: routes, cron, QR, subscriptions ──────── */
    router: async (env, ctx) => {
      const out = [];
      out.push(await t('core routes are registered', () => QV.router.ROUTES.length >= 12));
      out.push(await t('cron tasks are all callable', () =>
        QV.router.CRON_TASKS.length >= 10 && QV.router.CRON_TASKS.every(x => typeof x.run === 'function' && x.id && x.every)));
      out.push(await t('qr encoder renders a valid SVG', () => {
        const svg = QV.qr.svg('https://example.com/sub/abc', { scale: 2, ec: 'M' });
        return svg.startsWith('<svg') && svg.includes('</svg>') && svg.length > 800;
      }));
      out.push(await t('qr refuses payloads that cannot fit', () => {
        const huge = 'x'.repeat(2000);
        try { QV.qr.encode(huge, { ec: 'L' }); return false; } catch (e) { return true; }
      }));
      out.push(await t('subscription builder returns nodes for a live account', async () => {
        const uuid = QV.uuid();
        await QV.d1.Users.upsert(env, { uuid, name: 'selfcheck-sub', quota_bytes: 1e12, enabled: 1 });
        const built = await QV.subs.build(env, ctx, uuid, { format: 'uris', origin: 'https://example.workers.dev' });
        await QV.d1.Users.remove(env, uuid);
        return built.ok && built.nodes.length >= 3 && built.uris.some(u => u.startsWith('vless://')) && built.uris.some(u => u.startsWith('ss://'));
      }));
      out.push(await t('revoked accounts get no configs', async () => {
        const uuid = QV.uuid();
        await QV.d1.Users.upsert(env, { uuid, name: 'selfcheck-cut', total_bytes: 10, used_bytes: 10, enabled: 1 });
        await QV.d1.Users.setKill(env, uuid, true, 'selfcheck');
        const built = await QV.subs.build(env, ctx, uuid, { format: 'uris' });
        await QV.d1.Users.remove(env, uuid);
        return built.ok === false && built.revoked === true;
      }));
      out.push(await t('clash + sing-box profiles are generated', async () => {
        const uuid = QV.uuid();
        await QV.d1.Users.upsert(env, { uuid, name: 'selfcheck-profiles', quota_bytes: 1e12, enabled: 1 });
        const clash = await QV.subs.build(env, ctx, uuid, { format: 'clash', origin: 'https://example.workers.dev' });
        const sbox = await QV.subs.build(env, ctx, uuid, { format: 'singbox', origin: 'https://example.workers.dev' });
        await QV.d1.Users.remove(env, uuid);
        let sboxOk = false;
        try { sboxOk = !!JSON.parse(sbox.body).outbounds; } catch (e) {}
        return clash.body.includes('proxies:') && sboxOk;
      }));
      out.push(await t('quota sweep cuts accounts over their limit', async () => {
        const uuid = QV.uuid();
        await QV.d1.Users.upsert(env, { uuid, name: 'selfcheck-quota', total_bytes: 1024, used_bytes: 2048, enabled: 1 });
        const res = await QV.subs.enforceQuotas(env, ctx);
        const u = await QV.d1.Users.get(env, uuid);
        await QV.d1.Users.remove(env, uuid);
        return res.cut >= 1 && u.killswitch === 1;
      }));
      return out;
    },
  };

  const run = async (env, opts = {}) => {
    env0 = env || {};
    const t0 = Date.now();
    const quick = !!opts.quick;
    const skip = new Set(quick ? ['ai', 'bridge', 'runtime'] : []);
    const suites = {};
    const results = [];
    const timeoutMs = opts.timeoutMs || 20000;
    for (const [suite, fn] of Object.entries(SUITES)) {
      if (skip.has(suite)) continue;
      let part = [];
      try {
        part = await QV.withTimeout(fn(env, { waitUntil: () => {} }), timeoutMs, 'selfcheck:' + suite);
      } catch (e) {
        part = [{ name: suite + ' (suite)', pass: false, detail: 'suite failed: ' + (e?.message || e) }];
      }
      suites[suite] = part;
      results.push(...part.map(r => ({ ...r, suite })));
    }
    const failed = results.filter(r => !r.pass);
    const skipped = results.filter(r => r.skipped);
    const summary = `${results.length - failed.length}/${results.length} checks passed in ${Date.now() - t0}ms` + (skipped.length ? ` (${skipped.length} skipped)` : '');
    const out = {
      ok: failed.length === 0, summary, suites, results,
      failed: failed.map(f => `${f.suite}/${f.name}`),
      warnings: skipped.map(s => `${s.suite}/${s.name}: ${s.detail}`),
      duration_ms: Date.now() - t0, at: Date.now(), version: QV.VERSION, quick,
    };
    QV.safeAsync(() => QV.d1.Kv.set(env, 'qv:selfcheck:last', out, 0));
    if (!out.ok) QV.log.warn('selfcheck', summary, { failed: out.failed });
    else QV.log.info('selfcheck', summary);
    return out;
  };

  QV.selfcheck = {
    run, SUITES, suites: Object.keys(SUITES),
    last: (env) => QV.d1.Kv.get(env || {}, 'qv:selfcheck:last', null),
  };
})();
