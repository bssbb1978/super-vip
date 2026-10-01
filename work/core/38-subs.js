/* ═══════════════════════════════════════════════════════════════════════════
 * A3b · SUBSCRIPTION ENGINE — one account, every client, every protocol
 * ═══════════════════════════════════════════════════════════════════════════
 *  · v2rayN / v2rayNG / NekoBox / Streisand  → base64 blob of node URIs
 *  · Clash / Meta / Mihomo                    → full YAML profile
 *  · sing-box (SFI/SFA/SFM)                   → full JSON profile
 *  · plain text                               → raw URIs, one per line
 *  Every profile carries the anti-DPI hints the project is built around:
 *  client-side fragmentation (tls.fragment), uTLS fingerprints, the chosen
 *  SNI, the WS/uTLS transport, and — when available — one node per clean IP
 *  so the client can hop when an IP range is filtered.
 *  Quota enforcement lives here too: the per-user cut-off is what actually
 *  revokes an account's configs.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function subs() {
  const EOL = '\n';

  const splitHosts = (v) => String(v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

  const hostsFor = async (env, ctx) => {
    const configured = splitHosts(await QV.d1.Kv.get(env, 'qv:hosts', QV.env.get(env, 'HOSTS', '')));
    if (configured.length) return configured;
    const seen = [];
    for (const h of [QV.env.get(env, 'CUSTOM_DOMAIN', ''), QV.env.get(env, 'WORKERS_DEV', '')]) if (h) seen.push(h);
    /* the request host is added by the caller (build) — here we only know env */
    return seen;
  };

  /** every endpoint variant a client may use, in one flat list */
  const endpoints = async (env, ctx, origin, user, opts = {}) => {
    const cfg = await QV.env.prepare(env, ctx);
    const hosts = await hostsFor(env, ctx);
    const requestHost = (() => { try { return new URL(origin).hostname; } catch (e) { return ''; } })();
    for (const h of [requestHost, ...(cfg.hosts || [])]) if (h && !hosts.includes(h)) hosts.push(h);
    const sni = await QV.antidpi.pickSni(env, { kind: 'edge' }).catch(() => null);
    const sniHost = (sni && sni.sni) || QV.env.get(env, 'DEFAULT_SNI', 'www.cloudflare.com');
    const path = QV.env.get(env, 'WS_PATH', '/ws');
    /* The ranking the engine measured *from this caller's network* comes first;
       the historic D1 pool stays as the tail of the list so a cold start still
       hands out something usable.  Nothing that used to be offered is dropped. */
    const picked = await QV.safeAsync(() => QV.cleanip.pick(env, { asn: opts.asn || user?.asn || null, n: 5, uuid: user?.uuid }), { v4: [], v6: [], nat64: [] });
    const measured = picked.v4.map(r => ({ ip: r.ip, score: r.score, scope: r.scope, samples: r.samples }));
    const history = (await QV.d1.Ip.top(env, 6).catch(() => [])).map(r => ({ ip: r.ip, score: r.score, scope: 'pool', samples: 0 }));
    const seen = new Set();
    const cleanIps = [...measured, ...history].filter(r => r.ip && !seen.has(r.ip) && seen.add(r.ip)).slice(0, 6);
    const ports = splitHosts(QV.env.get(env, 'ALT_PORTS', '443')).map(Number).filter(n => n > 0 && n < 65536);
    return {
      hosts, sniHost, path, ports: ports.length ? ports : [443], cfg, user,
      cleanIps: cleanIps.map(r => r.ip),
      cleanDetail: cleanIps,
      ipv6: picked.v6.map(r => r.ip),
      nat64: picked.nat64.map(r => r.ip),
      asn: opts.asn || null,
      measured_scope: cleanIps[0] ? cleanIps[0].scope : null,
    };
  };

  const vlessUri = ({ uuid, host, port, sni, path, name, fingerprint = 'chrome' }) =>
    `vless://${uuid}@${host}:${port}?encryption=none&security=tls&sni=${encodeURIComponent(sni)}&fp=${fingerprint}&type=ws&host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}#${encodeURIComponent(name)}`;

  const ssUri = ({ method, password, host, port, name, path, sni }) => {
    const q = path ? '?plugin=' + encodeURIComponent(`v2ray-plugin;tls;host=${host};path=${path}` + (sni ? `;sni=${sni}` : '')) : '';
    return `ss://${QV.b64.url(QV.utf8(`${method}:${password}`))}@${host}:${port}${q}#${encodeURIComponent(name)}`;
  };

  /* the node object carries the 2022 PSK as `password`; accept either spelling
     so a URI can never be built with the literal string "undefined" in it */
  const ss2022Uri = ({ key, password, host, port, name, path }) => {
    const q = path ? '?plugin=' + encodeURIComponent(`v2ray-plugin;tls;host=${host};path=${path}`) : '';
    return `ss://2022-blake3-chacha20-poly1305:${encodeURIComponent(key || password || '')}@${host}:${port}${q}#${encodeURIComponent(name)}`;
  };

  /** the per-user Shadowsocks credentials live in D1 so they survive redeploys
   *  and can be revoked individually (kill-switch) without touching others */
  const ssCreds = async (env, uuid) => {
    const key = 'qv:ss:' + uuid;
    let rec = await QV.d1.Kv.get(env, key, null);
    if (!rec) {
      const cfg = await QV.env.prepare(env, null);
      rec = {
        /* a legacy AEAD password is a *string* (the key is derived from it with
           EVP_BytesToKey); storing raw bytes made the URI read "195,136,…" */
        legacy: QV.b64.enc(QV.rand(18)).replace(/[^A-Za-z0-9]/g, '').slice(0, 24),
        legacyMethod: 'aes-128-gcm',
        key2022: QV.b64.enc(QV.rand(32)),                        // 32-byte PSK for 2022 ciphers
        createdAt: Date.now(),
      };
      await QV.d1.Kv.set(env, key, rec, 0);
      void cfg;
    }
    /* the SS endpoint keeps a bounded index of user credentials: without it a
       stream cannot be attributed to a user (and could not be cut off).  This
       is awaited on purpose — the client may connect the moment it has the
       configuration in hand. */
    if (QV.ss && QV.ss.indexAdd) await QV.safeAsync(() => QV.ss.indexAdd(env, uuid), false);
    /* The keys the client is told to use are *derived* from the deployment
       master secret and the account id (HKDF-SHA256, label AXR-SS-AEAD-V1) —
       no per-user secret has to be stored or trusted.  The record minted
       above is kept as-is and stays valid, so a client that already holds it
       keeps working; nothing that used to be served is withdrawn. */
    const derived = QV.ss && QV.ss.derivedCreds ? await QV.safeAsync(() => QV.ss.derivedCreds(env, uuid), null) : null;
    if (derived) return { ...rec, key2022: derived.key2022, legacy: derived.legacy, legacyMethod: 'aes-128-gcm', derived: true, stored: { key2022: rec.key2022, legacy: rec.legacy } };
    return rec;
  };

  const clashProfile = (nodes, meta) => {
    const proxies = nodes.map(n => {
      const base = { name: n.name, server: n.host, port: n.port, udp: true, 'skip-cert-verify': false };
      if (n.proto === 'vless') {
        return { ...base, type: 'vless', uuid: n.uuid, tls: true, servername: n.sni, network: 'ws',
          'client-fingerprint': n.fp || 'chrome',
          'ws-opts': { path: n.path, headers: { Host: n.host } } };
      }
      /* the endpoint speaks Shadowsocks *over WebSocket*: the profile has to
         say so, and the path carries the account hint that keeps the first
         packet cheap on the server side */
      const wsBase = {
        ...base, network: 'ws', tls: true, servername: n.sni || n.host,
        'client-fingerprint': n.fp || 'chrome',
        'ws-opts': { path: n.path || '/ss', headers: { Host: n.host } },
      };
      if (n.proto === 'ss2022') return { ...wsBase, type: 'ss', cipher: '2022-blake3-chacha20-poly1305', password: n.password };
      return { ...wsBase, type: 'ss', cipher: n.method, password: n.password };
    });
    const names = proxies.map(p => p.name);
    const yml = [
      '# QUANTUM VEIL profile — generated ' + new Date().toISOString(),
      '# tips: enable TLS fragmentation in the client (Fragment / frag), keep uTLS = chrome',
      'mixed-port: 7890', 'allow-lan: false', 'mode: rule', 'log-level: warning', 'ipv6: true',
      'dns:',
      '  enable: true', '  ipv6: true', '  enhanced-mode: fake-ip',
      '  nameserver: [' + (meta.doh || 'https://1.1.1.1/dns-query') + ']',
      '  fallback: [' + (meta.dohLocal || 'https://dns.google/dns-query') + ']',
      'proxies:',
      ...proxies.map(p => '  - ' + JSON.stringify(p).replace(/,"/g, ', "').replace(/\{"/, '{ "')),
      'proxy-groups:',
      '  - name: QV-AUTO', '    type: url-test', '    url: http://cp.cloudflare.com/generate_204',
      '    interval: 180', '    tolerance: 60', '    proxies: [' + names.map(n => JSON.stringify(n)).join(', ') + ']',
      '  - name: QV-FALLBACK', '    type: fallback', '    proxies: [QV-AUTO, ' + names.map(n => JSON.stringify(n)).join(', ') + ']',
      'rules:',
      '  - GEOIP,IR,DIRECT', '  - GEOSITE,category-ads-all,REJECT',
      '  - DOMAIN-SUFFIX,ir,DIRECT', '  - MATCH,QV-FALLBACK',
    ].join(EOL);
    return yml;
  };

  const singboxProfile = (nodes, meta) => {
    const outbounds = [
      { type: 'selector', tag: 'proxy', outbounds: ['auto', ...nodes.map(n => n.name)], default: 'auto' },
      { type: 'urltest', tag: 'auto', outbounds: nodes.map(n => n.name), url: 'http://cp.cloudflare.com/generate_204', interval: '3m', tolerance: 60 },
      ...nodes.map(n => {
        const tls = { enabled: true, server_name: n.sni, utls: { enabled: true, fingerprint: n.fp || 'chrome' },
          /* the client-side fragmentation this project relies on */
          fragment: true, fragment_fallback_delay: '500ms',
          record_fragment: meta.recordFragment !== false };
        if (n.proto === 'vless') return { type: 'vless', tag: n.name, server: n.host, server_port: n.port, uuid: n.uuid,
          flow: '', packet_encoding: 'xudp', tls, transport: { type: 'ws', path: n.path, headers: { Host: n.host } },
          multiplex: { enabled: false } };
        const ssTransport = { type: 'ws', path: n.path || '/ss', headers: { Host: n.host } };
        if (n.proto === 'ss2022') return { type: 'shadowsocks', tag: n.name, server: n.host, server_port: n.port,
          method: '2022-blake3-chacha20-poly1305', password: n.password, tls, transport: ssTransport };
        return { type: 'shadowsocks', tag: n.name, server: n.host, server_port: n.port, method: n.method, password: n.password,
          tls, transport: ssTransport };
      }),
      { type: 'direct', tag: 'direct' },
    ];
    return JSON.stringify({
      log: { level: 'warn' },
      dns: { servers: [{ tag: 'doh', address: meta.doh || 'https://1.1.1.1/dns-query', detour: 'proxy' },
                       { tag: 'local', address: 'local', detour: 'direct' }], rules: [{ outbound: 'doh', domain_suffix: ['.ir'], action: 'route' }] },
      inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 },
                 { type: 'tun', tag: 'tun-in', inet4_address: '172.19.0.1/28', auto_route: true, strict_route: true, stack: 'mixed' }],
      outbounds,
      route: { rules: [{ ip_is_private: true, outbound: 'direct' }, { geosite: 'category-ads-all', outbound: 'direct' }], final: 'proxy', auto_detect_interface: true },
    }, null, 2);
  };

  /* ─────────────────────────── build ───────────────────────────────────── */
  const build = async (env, ctx, uuid, opts = {}) => {
    const format = (opts.format || 'base64').toLowerCase();
    const user = await QV.d1.Users.get(env, uuid);
    if (!user) return { ok: false, error: 'account not found' };
    /* The verdict (enabled / kill-switch / expiry / quota) is taken from the
       tiered state view: isolate RAM first, KV snapshot second, D1 last.  It
       carries the bytes metered a moment ago, so a cut-off shows up here at
       once — a client that polls its subscription can never see configs the
       tunnel would refuse. */
    const st = await QV.safeAsync(() => QV.d1.Users.state(env, uuid), null);
    const view = st ? { ...user, ...st, total_bytes: st.total_bytes || user.total_bytes || 0 } : user;
    if (!view.enabled || view.killswitch) {
      return { ok: false, revoked: true, error: 'account disabled by the operator', reason: view.killswitch ? 'killswitch' : 'disabled' };
    }
    if (view.expires_at && view.expires_at * 1000 < Date.now()) return { ok: false, revoked: true, error: 'account expired' };
    const quota = view.total_bytes || view.quota_bytes || 0;
    if (quota && view.used_bytes >= quota) return { ok: false, revoked: true, error: 'quota exhausted' };

    const ep = await endpoints(env, ctx, opts.origin || '', view, opts);
    const creds = await ssCreds(env, uuid);
    const label = user.name || uuid.slice(0, 8);
    const nodes = [];
    const targets = ep.hosts.slice(0, 3);
    const ips = ep.cleanIps.slice(0, 3);
    const port = ep.ports[0] || 443;

    const addAll = (host, tag) => {
      nodes.push({ proto: 'vless', name: `QV ${tag} ${host}`, host, port, uuid, sni: ep.sniHost, path: ep.path, fp: 'chrome' });
      const ssPath = '/ss/' + uuid.slice(0, 8);
      nodes.push({ proto: 'ss2022', name: `QV-2022 ${tag} ${host}`, host, port, key: creds.key2022, hint: uuid.slice(0, 8), path: ssPath });
      nodes.push({ proto: 'ss', name: `QV-AEAD ${tag} ${host}`, host, port, method: creds.legacyMethod, password: creds.legacy, hint: uuid.slice(0, 8), path: ssPath });
    };
    targets.forEach(h => addAll(h, 'TLS'));
    ips.forEach(h => addAll(h, 'IP'));
    /* Dual stack, in the order the engine measured: native IPv6 endpoints first,
       then the RFC 6052 forms synthesised from proven IPv4 ones — so an
       IPv6-only subscriber still has an address that skips the IPv4 blacklist */
    const v6list = [...(ep.ipv6 || []), ...(ep.nat64 || [])].slice(0, 4);
    v6list.forEach((h, i) => {
      const isNat = (ep.nat64 || []).includes(h);
      nodes.push({ proto: 'vless', name: `QV ${isNat ? 'NAT64' : 'IPv6'} ${h}`, host: `[${h}]`, port, uuid, sni: ep.sniHost, path: ep.path, fp: 'chrome', family: 'v6', nat64: isNat });
    });
    for (const p of ep.ports.slice(1, 3)) nodes.push({ proto: 'vless', name: `QV ALT ${port}→${p}`, host: targets[0] || ep.hosts[0] || 'localhost', port: p, uuid, sni: ep.sniHost, path: ep.path, fp: 'randomized' });

    const uris = nodes.map(n => n.proto === 'vless' ? vlessUri(n) : (n.proto === 'ss2022' ? ss2022Uri(n) : ssUri(n)));
    const base = (opts.origin && /^https?:/.test(opts.origin) ? opts.origin : (ep.hosts[0] ? 'https://' + ep.hosts[0] : ''));
    const reported = { ...view, up_bytes: view.up_bytes ?? user.up_bytes, down_bytes: view.down_bytes ?? user.down_bytes };
    const meta = {
      doh: base ? base + '/dns-query' : 'https://1.1.1.1/dns-query',
      dohLocal: 'https://dns.google/dns-query',
      recordFragment: true,
    };

    let body, contentType;
    if (format === 'clash' || format === 'mihomo' || format === 'yaml') { body = clashProfile(nodes, meta); contentType = 'text/yaml; charset=utf-8'; }
    else if (format === 'singbox' || format === 'sing-box' || format === 'json') { body = singboxProfile(nodes, meta); contentType = 'application/json; charset=utf-8'; }
    else if (format === 'uris' || format === 'text' || format === 'plain') { body = uris.join(EOL) + EOL; contentType = 'text/plain; charset=utf-8'; }
    else { body = QV.b64.enc(QV.utf8(uris.join(EOL))); contentType = 'text/plain; charset=utf-8'; }

    return {
      ok: true, body, contentType, nodes, uris, user: reported,
      subUrl: base ? `${base}/sub/${uuid}` : `/sub/${uuid}`,
      hints: {
        fragment: QV.antidpi.frag(env, null, opts.country),
        sni: ep.sniHost,
        clean_ips: ep.cleanIps,
        note: 'If the node is blocked, switch to a clean-IP node; if TLS is fingerprinted, run the client fragment profile.',
      },
    };
  };

  /* ─────────────────────── per-user quota enforcement ──────────────────── */
  const enforceQuotas = async (env, ctx) => {
    const out = { checked: 0, cut: 0, warned: 0, revived: 0 };
    const users = await QV.d1.all(env,
      `SELECT uuid, tag AS name, telegram_id, used_bytes, total_bytes AS quota_bytes, expires_at, killswitch, enabled
         FROM qv_users WHERE enabled = 1`);
    if (!users) return out;
    const now = Math.floor(Date.now() / 1000);
    for (const u of users) {
      out.checked++;
      const overQuota = u.quota_bytes > 0 && u.used_bytes >= u.quota_bytes;
      const expired = u.expires_at && u.expires_at < now;
      if ((overQuota || expired) && !u.killswitch) {
        await QV.d1.Users.setKill(env, u.uuid, true, overQuota ? 'quota' : 'expired');
        out.cut++;
        QV.emit(env, 'quota:cut', 'warn', { uuid: u.uuid, message: (overQuota ? 'quota exhausted' : 'expired') + ' — configs cut', ctx });
        if (u.telegram_id) await QV.telegram.send(env, u.telegram_id,
          QV.i18n('quota_cut', { name: u.name || '', used: QV.humanBytes(u.used_bytes), total: QV.humanBytes(u.quota_bytes) }));
      } else if (!overQuota && !expired && u.killswitch) {
        /* auto-revive when the operator raised the quota again */
        const revived = await QV.d1.Kv.get(env, 'qv:revive:' + u.uuid, false);
        if (revived) {
          await QV.d1.Users.setKill(env, u.uuid, false, 'operator');
          await QV.d1.run(env, `UPDATE qv_users SET warned_at = NULL WHERE uuid = ?`, u.uuid);
          await QV.d1.Kv.del(env, 'qv:revive:' + u.uuid);
          out.revived++;
        }
      } else if (!overQuota && u.quota_bytes > 0 && u.used_bytes / u.quota_bytes > 0.85) {
        await QV.d1.Users.update(env, u.uuid, { note: 'quota-warning:' + Math.round((u.used_bytes / u.quota_bytes) * 100) + '%' });
        out.warned++;
        if (u.telegram_id) await QV.telegram.send(env, u.telegram_id,
          QV.i18n('quota_warn', { pct: Math.round((u.used_bytes / u.quota_bytes) * 100), used: QV.humanBytes(u.used_bytes), total: QV.humanBytes(u.quota_bytes) }));
      }
    }
    QV.metrics.count('quota_sweep', 1, { cut: out.cut });
    return out;
  };

  /** Re-materialise the per-user config rows and caches.
   *  Called after a quota change, a cut/revive, a delete or a plan switch: the
   *  account's configs must always match what the subscription currently
   *  serves, and a stale snapshot must never be handed to a client. */
  const syncUsers = async (env, ctx, uuid = null) => {
    const out = { scanned: 0, created: 0, invalidated: 0, revoked: 0 };
    const users = uuid
      ? [await QV.d1.Users.get(env, uuid)].filter(Boolean)
      : (await QV.d1.all(env, `SELECT * FROM qv_users WHERE enabled = 1 LIMIT 500`)) || [];
    for (const u of users) {
      out.scanned++;
      let configs = [];
      try { configs = await QV.d1.Users.configs(env, u.uuid); } catch (e) { configs = []; }
      const blocked = !u.enabled || u.killswitch;
      if (blocked) {
        for (const cfg of configs) {
          if (!cfg.revoked) { await QV.d1.run(env, `UPDATE qv_configs SET revoked = 1 WHERE id = ?`, cfg.id); out.revoked++; }
        }
      } else {
        if (!configs.length || !configs.some(c => !c.revoked)) {
          await QV.d1.Users.newConfig(env, u.uuid, { protocol: u.protocol || 'vless', name: 'primary' });
          out.created++;
        }
        for (const cfg of configs) if (cfg.revoked) await QV.d1.run(env, `UPDATE qv_configs SET revoked = 0 WHERE id = ?`, cfg.id);
      }
      await QV.d1.Kv.del(env, 'qv:sub:' + u.uuid);
      out.invalidated++;
    }
    QV.metrics.count('users_sync', 1, { scanned: out.scanned });
    void ctx;
    return out;
  };

  QV.subs = {
    build, enforceQuotas, syncUsers, endpoints, ssCreds, hostsFor,
    vlessUri, ssUri, ss2022Uri, clashProfile, singboxProfile,
    /** stateless helper used by the API and the Telegram bot */
    quick: async (env, ctx, uuid, format) => (await build(env, ctx, uuid, { format })).body,
  };
})();
