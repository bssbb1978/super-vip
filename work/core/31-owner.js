/* ═══════════════════════════════════════════════════════════════════════════
 * A3b · OWNER BINDING — the bot is claimed, never configured
 * ═══════════════════════════════════════════════════════════════════════════
 *  Problem: the Telegram control plane used to need `ADMIN_TELEGRAM_ID`, a value
 *  that has to be typed by hand, kept out of the repository and rotated by hand
 *  whenever the operator changes device.  While it is missing, every alert,
 *  every approval request and every support ping is silently dropped, and half
 *  of the admin commands answer “ADMIN_TELEGRAM_ID not set”.
 *
 *  Design: the owner is DISCOVERED, not configured.
 *
 *    1. `ADMIN_TELEGRAM_ID` stays supported and keeps the highest priority — an
 *       operator who already set it sees exactly zero change.
 *    2. When it is absent, whoever can already authenticate against the panel
 *       (ADMIN_PASSWORD session, API_SECRET_TOKEN or Cloudflare Access) mints a
 *       single-use *claim code*:  POST /api/owner {action:'invite'}, or the
 *       “connect Telegram” button in the console.
 *    3. The operator opens the deep link  https://t.me/<bot>?start=claim_CODE
 *       or sends `/claim CODE` in a private chat.  Nothing is shown to a
 *       stranger: a wrong or unknown code gets a neutral refusal, never a hint.
 *    4. The code is verified in constant time against an HMAC-SHA256 digest, so
 *       the plaintext is never stored anywhere (not in D1, not in a log).
 *       Consumption is atomic: a primary-key INSERT decides the winner, so two
 *       isolates racing on the same code can never both succeed.
 *    5. The winning chat id is written to `qv_admins` with role='owner' and the
 *       whole control plane then resolves its recipients from D1 — alerts,
 *       approvals, support, broadcasts and the admin menus all work with no
 *       environment variable at all.
 *
 *  Hard rules (why this is safe rather than merely convenient):
 *   · a chat is NEVER auto-promoted for messaging first; the code is the proof;
 *   · claiming is only possible in a private chat where from.id === chat.id;
 *   · codes expire (default 30 min), are single-use, and a new invite revokes
 *     none of the old ones but `rotate` does — all of them, instantly;
 *   · roles are checked on every privileged path: owner > admin > viewer;
 *   · the env-configured id can never be demoted or locked out from the chat;
 *   · the owner's chat id is never echoed into logs, /health or HTML — only a
 *     masked form (…1234) ever leaves D1, and only over an admin session;
 *   · if no recipient exists yet, alerts are queued in D1 instead of being
 *     dropped, and flushed to the owner the moment the bot is claimed;
 *   · `OWNER_LOCK=1` disables claiming completely (env id only).
 * ═══════════════════════════════════════════════════════════════════════════ */
(function owner() {
  /* unambiguous alphabet: no I/L/O/0/1 — a code read out loud or copied from a
     screenshot cannot be mistyped into another valid code */
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const GROUPS = 2, GROUP = 5;                 // 10 chars ≈ 49.5 bits of entropy
  const RETRY_WINDOW = 600;                    // 10 min

  const get = (env, key, dflt) => {
    try {
      if (QV.env && QV.env.get) {
        const v = QV.env.get(env, key, undefined);
        if (v !== undefined && v !== null && v !== '') return v;
      }
    } catch (e) { /* fall through to the raw binding */ }
    try {
      const v = env && env[key];
      return (v === undefined || v === null || v === '') ? dflt : v;
    } catch (e) { return dflt; }
  };

  const num = (env, key, dflt, lo, hi) => {
    const n = Number(get(env, key, dflt));
    const v = Number.isFinite(n) ? n : dflt;
    return Math.min(hi === undefined ? v : hi, Math.max(lo === undefined ? v : lo, v));
  };
  const on = (env, key, dflt = false) => {
    const v = String(get(env, key, dflt ? '1' : '0')).toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  };

  const locked = (env) => on(env, 'OWNER_LOCK', false);
  const mask = (id) => {
    const s = String(id || '');
    if (!s) return null;
    return s.length <= 4 ? '•' + s : '•'.repeat(Math.max(2, s.length - 4)) + s.slice(-4);
  };
  const digits = (v) => String(v || '').split(/[\s,;]+/).map(s => s.trim()).filter(s => /^-?\d{3,20}$/.test(s));
  const num0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  /** env-configured admins — always trusted, never written by the claim flow */
  const envIds = (env) => digits(get(env, 'ADMIN_TELEGRAM_ID', '') || get(env, 'ADMIN_CHAT_ID', ''));

  /* ── the pepper: committed once, stable for the life of the database ─────
   *  Everything the claim flow stores or transports is an HMAC under this value
   *  — the code digests in D1, and the id fingerprints that travel inside
   *  Telegram callback payloads and console buttons — so it has to be identical
   *  in every isolate *and* identical after a redeploy.
   *
   *  The ladder is: an explicit OWNER_PEPPER → the pepper already committed to
   *  this database → one derived from the deployment's own secrets → a minted
   *  one.  Reading the committed value *before* deriving is the whole point:
   *  deriving from live secrets means that rotating ADMIN_PASSWORD, the bot
   *  token or the API token silently re-keys every fingerprint, and from that
   *  moment `byFp` resolves nothing — the "revoke" and "role" buttons in
   *  Telegram and in the console keep rendering but stop working, with no error
   *  anywhere.  One committed row removes that failure mode entirely.
   *
   *  Is keeping it in D1 safe?  `qv_admins` already holds the raw chat ids, so
   *  anybody who can read this database learns nothing new from the key that
   *  protects them.  What the pepper defends is the data that *leaves* D1
   *  (callbacks, JSON, logs), and for anybody without the database those stay
   *  exactly as one-way as before.
   *
   *  Committing is `INSERT … ON CONFLICT DO NOTHING` plus a re-read, so two
   *  isolates booting at the same moment converge on one value instead of each
   *  keeping its own.
   * ──────────────────────────────────────────────────────────────────────── */
  const PEPPER_KEY = 'qv:owner:pepper';
  const isPepper = (v) => /^[0-9a-f]{32,128}$/i.test(String(v || ''));
  const pepperCache = new Map();

  const readPepper = async (env) => {
    const v = await QV.safeAsync(() => QV.d1.Kv.get(env, PEPPER_KEY, null), null);
    return isPepper(v) ? String(v) : '';
  };
  const commitPepper = async (env, candidate) => {
    if (!env || !env.DB) return candidate;         // nowhere to commit to
    await QV.safeAsync(() => QV.d1.run(env,
      `INSERT INTO qv_kv (key,value,expires_at) VALUES (?,?,NULL) ON CONFLICT(key) DO NOTHING`,
      PEPPER_KEY, JSON.stringify(candidate)), null);
    QV.lru.delete('kv:' + PEPPER_KEY);             // re-read the winner, not our guess
    return (await readPepper(env)) || candidate;
  };
  const derive = async (material) =>
    QV.hex(await QV.hmacSha256(QV.utf8('qv-owner-pepper-v1'), QV.utf8(material)));

  const pepperOf = async (env) => {
    const explicit = String(get(env, 'OWNER_PEPPER', '') || '');
    if (explicit) return explicit;                 // operator-pinned: never stored
    if (pepperCache.has('p')) return pepperCache.get('p');
    /* only memoise once the value is durable — an uncommitted candidate from a
       request that raced the schema must not stick for the life of the isolate */
    const keep = (p) => { if (env && env.DB) pepperCache.set('p', p); return p; };

    const committed = await readPepper(env);
    if (committed) return keep(committed);

    const fromEnv = [
      get(env, 'TELEGRAM_WEBHOOK_SECRET', ''), get(env, 'TELEGRAM_BOT_TOKEN', ''),
      get(env, 'JWT_SECRET', ''), get(env, 'API_SECRET_TOKEN', ''), get(env, 'ADMIN_PASSWORD', ''),
    ].map(v => String(v || '')).join('|');
    if (fromEnv.replace(/\|/g, '')) return keep(await commitPepper(env, await derive(fromEnv)));

    /* nothing configured: fall back to the credentials the env module already
       generated and persisted, which are stable for the life of the database */
    const sec = await QV.safeAsync(() => QV.env.secrets(env, null), null);
    const fromStore = [sec?.jwt, sec?.api, sec?.bridge, sec?.adminPassword].map(v => String(v || '')).join('|');
    if (fromStore.replace(/\|/g, '')) return keep(await commitPepper(env, await derive(fromStore)));

    return keep(await commitPepper(env, QV.hex(QV.rand(24))));
  };

  /** diagnostics only — never the value itself */
  const pepperSource = async (env) => {
    if (String(get(env, 'OWNER_PEPPER', '') || '')) return 'env';
    if (await readPepper(env)) return 'd1';
    return (env && env.DB) ? 'derived' : 'ephemeral';
  };

  const normalize = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  /** keyed digest under the deployment pepper — the only place a raw value is
      ever turned into something storable or transportable */
  const tag = async (env, msg) => QV.hex(await QV.hmacSha256(QV.utf8(await pepperOf(env)), QV.utf8(String(msg))));
  const digestOf = async (env, code) => tag(env, 'claim:' + normalize(code));
  /** short, stable, non-reversible handle for a chat id — safe to put inside a
      Telegram callback payload, because it cannot be turned back into the id */
  const fpOf = async (env, id) => (await tag(env, 'id:' + String(id))).slice(0, 12);
  const newCode = () => {
    const bytes = QV.rand(GROUPS * GROUP);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out.match(new RegExp('.{1,' + GROUP + '}', 'g')).join('-');
  };

  /* ── recipients ───────────────────────────────────────────────────────── */
  const rowsOf = async (env) => QV.safeAsync(
    () => QV.d1.all(env, `SELECT telegram_id, name, role, added_at FROM qv_admins ORDER BY added_at ASC LIMIT 200`), []) || [];

  /** every chat that may command the node: env ids first (owner), then D1 rows */
  const resolve = async (env) => {
    const envList = envIds(env);
    const rows = await rowsOf(env);
    const seen = new Set();
    const admins = [];
    const owners = [];
    for (const id of envList) {
      if (seen.has(id)) continue;
      seen.add(id);
      owners.push({ telegram_id: id, role: 'owner', source: 'env', name: 'env' });
      admins.push({ telegram_id: id, role: 'owner', source: 'env', name: 'env' });
    }
    for (const r of rows) {
      const id = String(r.telegram_id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const role = envList.length && r.role === 'owner' ? 'admin' : (r.role || 'admin');
      admins.push({ telegram_id: id, role, source: 'd1', name: r.name || '', added_at: r.added_at });
      if (role === 'owner') owners.push({ telegram_id: id, role, source: 'd1', name: r.name || '' });
    }
    return { env: envList, admins, owners, ids: admins.map(a => a.telegram_id), owner: owners[0] || null };
  };

  const recipientIds = async (env) => (await resolve(env)).ids;
  /** resolve a callback-payload fingerprint back to a qv_admins row */
  const byFp = async (env, needle) => {
    const want = String(needle || '');
    if (!/^[0-9a-f]{6,16}$/i.test(want)) return null;
    for (const r of await rowsOf(env)) if ((await fpOf(env, r.telegram_id)) === want.toLowerCase()) return r;
    return null;
  };
  /** a caller may address an admin either by raw numeric id (owner typing it in)
      or by fingerprint (a button in Telegram or the console, which must never
      carry the real id) — both resolve to the same row */
  const resolveTarget = async (env, target) => {
    const s = String(target || '').trim();
    if (/^-?\d{3,20}$/.test(s)) return s;
    if (/^[0-9a-f]{6,16}$/i.test(s)) {
      const row = await byFp(env, s);
      return row ? String(row.telegram_id) : null;
    }
    return null;
  };
  const roleOf = async (env, chat) => {
    const id = String(chat || '');
    if (!id) return null;
    if (envIds(env).includes(id)) return 'owner';
    const row = await QV.safeAsync(() => QV.d1.one(env, `SELECT role FROM qv_admins WHERE telegram_id = ? LIMIT 1`, id), null);
    return row ? (row.role || 'admin') : null;
  };
  const isAdmin = async (env, chat) => {
    const role = await roleOf(env, chat);
    return role === 'owner' || role === 'admin';
  };
  const unclaimed = async (env) => {
    if (envIds(env).length) return false;
    const row = await QV.safeAsync(() => QV.d1.one(env, `SELECT 1 AS ok FROM qv_admins WHERE role = 'owner' LIMIT 1`), null);
    return !row;
  };

  /* ── the queue that keeps early alerts from being lost ─────────────────── */
  const queueAlert = async (env, text) => {
    const max = num(env, 'OWNER_NOTIFY_QUEUE', 50, 0, 200);
    if (!max) return { queued: 0 };
    const list = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:owner:queue', []), []) || [];
    const next = (Array.isArray(list) ? list : []).concat([{ text: String(text || '').slice(0, 1200), at: Date.now() }]).slice(-max);
    await QV.safeAsync(() => QV.d1.Kv.set(env, 'qv:owner:queue', next, 86400 * 30), null);
    return { queued: next.length };
  };
  const drainQueue = async (env) => {
    const list = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:owner:queue', []), []) || [];
    if (Array.isArray(list) && list.length) await QV.safeAsync(() => QV.d1.Kv.del(env, 'qv:owner:queue'), null);
    return Array.isArray(list) ? list : [];
  };
  /** draining is not acknowledgement: an item that could not be handed to
      Telegram (429, network, an owner removed mid-flush) goes back on the
      queue, oldest first — but only up to OWNER_NOTIFY_TRIES attempts, so a
      permanently broken destination cannot pin the queue forever */
  const requeueAlerts = async (env, items) => {
    const max = num(env, 'OWNER_NOTIFY_QUEUE', 50, 0, 200);
    const limit = num(env, 'OWNER_NOTIFY_TRIES', 5, 1, 50);
    const back = [];
    let dropped = 0;
    for (const it of (Array.isArray(items) ? items : [])) {
      if (!it) continue;
      const text = String(it.text || (typeof it === 'string' ? it : '')).slice(0, 1200);
      if (!text) continue;
      const tries = Number(it.tries || 0) + 1;
      if (tries > limit) { dropped++; continue; }
      back.push({ text, at: Number(it.at) || Date.now(), tries });
    }
    if (!back.length) return { queued: 0, dropped };
    if (!max) return { queued: 0, dropped: dropped + back.length };
    const cur = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:owner:queue', []), []) || [];
    const merged = back.concat(Array.isArray(cur) ? cur : []).slice(-max);
    await QV.safeAsync(() => QV.d1.Kv.set(env, 'qv:owner:queue', merged, 86400 * 30), null);
    return { queued: merged.length, dropped };
  };
  const queueLen = async (env) => {
    const list = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:owner:queue', []), []) || [];
    return Array.isArray(list) ? list.length : 0;
  };

  /* ── invite / claim / manage ──────────────────────────────────────────── */
  const deepLink = async (env, code) => {
    const uname = String(await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:tg:bot', ''), '') || '').replace(/^@/, '');
    return uname ? `https://t.me/${uname}?start=claim_${normalize(code)}` : null;
  };

  const invite = async (env, ctx, opts = {}) => {
    if (locked(env)) return { ok: false, error: 'owner binding is locked (OWNER_LOCK=1)' };
    const ttlMin = num(env, 'OWNER_CLAIM_TTL_MIN', opts.ttl_min || 30, 1, 1440);
    const code = newCode();
    const ttl = ttlMin * 60;
    const digest = await digestOf(env, code);
    const fp = digest.slice(0, 12);
    const now = Math.floor(Date.now() / 1000);
    const rec = { fp, digest, at: now, exp: now + ttl, ttl, by: String(opts.by || 'panel').slice(0, 40), via: String(opts.via || 'panel') };
    await QV.d1.Kv.set(env, 'qv:owner:claim:' + fp, rec, ttl);
    QV.emit(env, 'owner:invite', 'info', { message: `owner claim code minted (${ttlMin}m, ${rec.by})`, ctx });
    return {
      ok: true, code, fingerprint: fp, expires_at: rec.exp, ttl_min: ttlMin,
      link: await deepLink(env, code),
      note: 'single use · expires in ' + ttlMin + ' minutes · plaintext is never stored',
    };
  };

  const deny = (reason, extra = {}) => ({ ok: false, reason, ...extra });

  const redeem = async (env, ctx, o = {}) => {
    const chat = String(o.chat || '');
    const from = String(o.user || o.from || chat);
    if (!chat) return deny('no-chat');
    if (locked(env)) return deny('locked');
    if (o.chat_type && o.chat_type !== 'private') return deny('private-only');
    if (from && chat && from !== chat) return deny('identity-mismatch');
    const bucket = QV.tokenBucket('owner:redeem:' + chat, 6, 3);
    if (!bucket.take()) return deny('slow-down');
    const raw = String(o.code || '').trim();
    if (normalize(raw).length < 6 || normalize(raw).length > 32) return deny('bad-format');
    const fails = num0(await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:owner:fail:' + chat, 0), 0));
    if (fails >= 12) return deny('too-many-attempts', { retry_after: RETRY_WINDOW });
    const digest = await digestOf(env, raw);
    const fp = digest.slice(0, 12);
    /* replay gate first: the marker is what makes a claim atomic */
    const used = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:owner:claim:used:' + fp, null), null);
    if (used) return deny('already-used');
    const rec = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:owner:claim:' + fp, null), null);
    if (!rec || !rec.digest) {
      await bumpFail(env, chat);
      return deny('unknown-or-expired');
    }
    if (Number(rec.exp) && Number(rec.exp) * 1000 < Date.now()) return deny('expired');
    if (!QV.timingSafeEqual(digest, String(rec.digest))) {
      await bumpFail(env, chat);
      return deny('unknown-or-expired');
    }
    const now = Math.floor(Date.now() / 1000);
    const claim = await QV.d1.run(env,
      'INSERT OR IGNORE INTO qv_kv (key,value,expires_at) VALUES (?,?,?)',
      'qv:owner:claim:used:' + fp,
      JSON.stringify({ chat: mask(chat), at: now * 1000, fp }), now + 86400 * 30);
    const changes = claim && claim.meta ? Number(claim.meta.changes || 0) : Number(claim && claim.changes || 0);
    if (changes !== 1) return deny('already-used');
    /* first claim wins the owner role; later ones are promoted to plain admin,
       and a race that somehow produced two owners is repaired deterministically */
    const existing = await QV.safeAsync(() => QV.d1.one(env, `SELECT telegram_id FROM qv_admins WHERE role = 'owner' LIMIT 1`), null);
    const role = existing ? 'admin' : 'owner';
    const name = String(o.name || '').slice(0, 40);
    await QV.d1.run(env,
      `INSERT INTO qv_admins (telegram_id, name, role, added_at) VALUES (?,?,?,unixepoch())
       ON CONFLICT(telegram_id) DO UPDATE SET role = excluded.role, name = excluded.name`,
      chat, name, role);
    if (role === 'owner') {
      await QV.safeAsync(() => QV.d1.run(env,
        `UPDATE qv_admins SET role = 'admin' WHERE role = 'owner' AND telegram_id <> (
           SELECT telegram_id FROM qv_admins WHERE role = 'owner' ORDER BY added_at ASC, telegram_id ASC LIMIT 1)`), null);
    }
    await QV.safeAsync(() => QV.d1.Kv.del(env, 'qv:owner:claim:' + fp), null);
    await QV.safeAsync(() => QV.d1.Kv.del(env, 'qv:owner:fail:' + chat), null);
    await QV.safeAsync(() => QV.d1.Kv.set(env, 'qv:owner:meta', {
      at: now * 1000, chat: mask(chat), role, via: o.via || 'telegram', fp,
    }, 0), null);
    await QV.safeAsync(() => QV.emit(env, 'owner:claim', role === 'owner' ? 'warn' : 'info', {
      message: `telegram ${role} bound (${mask(chat)})`, ctx,
    }), null);
    return { ok: true, chat, role, masked: mask(chat), first: role === 'owner' };
  };

  const bumpFail = async (env, chat) => {
    const cur = num0(await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:owner:fail:' + chat, 0), 0));
    await QV.safeAsync(() => QV.d1.Kv.set(env, 'qv:owner:fail:' + chat, cur + 1, RETRY_WINDOW), null);
  };

  const add = async (env, ctx, chat, role = 'admin', name = '') => {
    const id = await resolveTarget(env, chat);
    if (!id) return { ok: false, error: 'a numeric telegram chat id (or a known fingerprint) is required' };
    const r = ['owner', 'admin', 'viewer'].includes(role) ? role : 'admin';
    const count = await QV.safeAsync(() => QV.d1.one(env, `SELECT COUNT(*) AS n FROM qv_admins`), { n: 0 });
    if (r !== 'viewer' && Number(count && count.n || 0) >= num(env, 'OWNER_MAX_ADMINS', 8, 1, 50)) {
      return { ok: false, error: 'OWNER_MAX_ADMINS reached' };
    }
    await QV.d1.run(env,
      `INSERT INTO qv_admins (telegram_id, name, role, added_at) VALUES (?,?,?,unixepoch())
       ON CONFLICT(telegram_id) DO UPDATE SET role = excluded.role, name = excluded.name`,
      id, String(name || '').slice(0, 40), r);
    QV.emit(env, 'owner:add', 'info', { message: `telegram ${r} added (${mask(id)})`, ctx });
    return { ok: true, telegram_id: id, role: r };
  };

  const remove = async (env, ctx, chat) => {
    const id = await resolveTarget(env, chat);
    if (!id) return { ok: false, error: 'unknown admin' };
    if (envIds(env).includes(id)) return { ok: false, error: 'the env-configured id cannot be removed' };
    await QV.d1.run(env, `DELETE FROM qv_admins WHERE telegram_id = ?`, id);
    await QV.safeAsync(() => QV.emit(env, 'owner:remove', 'warn', { message: `telegram admin removed (${mask(id)})`, ctx }), null);
    return { ok: true, removed: id };
  };

  const rotate = async (env, ctx) => {
    const rows = await QV.safeAsync(() => QV.d1.all(env,
      `SELECT key FROM qv_kv WHERE key LIKE 'qv:owner:claim:%' AND key NOT LIKE 'qv:owner:claim:used:%'`), []) || [];
    let n = 0;
    for (const r of rows) { await QV.safeAsync(() => QV.d1.Kv.del(env, r.key), null); n++; }
    await QV.safeAsync(() => QV.emit(env, 'owner:rotate', 'info', { message: `${n} pending owner code(s) revoked`, ctx }), null);
    return { ok: true, revoked: n };
  };

  const status = async (env) => {
    const res = await resolve(env);
    const meta = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:owner:meta', null), null);
    const pending = await QV.safeAsync(() => QV.d1.one(env,
      `SELECT COUNT(*) AS n FROM qv_kv WHERE key LIKE 'qv:owner:claim:%' AND key NOT LIKE 'qv:owner:claim:used:%'
         AND (expires_at IS NULL OR expires_at > unixepoch())`), { n: 0 });
    const queued = await QV.safeAsync(() => QV.d1.Kv.get(env, 'qv:owner:queue', []), []) || [];
    return {
      env_configured: res.env.length > 0,
      env_ids: res.env.map(mask),
      claimed: res.owners.length > 0,
      owner: res.owner ? mask(res.owner.telegram_id) : null,
      owners: res.owners.length,
      admins: await Promise.all(res.admins.map(async (a) => ({
        /* the raw chat id never leaves this module: callers get a masked form
           for display and a non-reversible fingerprint for addressing */
        id: mask(a.telegram_id), fp: await fpOf(env, a.telegram_id),
        role: a.role, source: a.source, name: a.name || null, added_at: a.added_at || null,
      }))),
      pending_codes: Number(pending && pending.n || 0),
      queued_alerts: Array.isArray(queued) ? queued.length : 0,
      locked: locked(env),
      /* diagnostics: where the HMAC pepper comes from.  `d1` means fingerprints
         survive rotating ADMIN_PASSWORD / the bot token; `env` means the
         operator pinned OWNER_PEPPER; anything else is a node without durable
         storage, where nothing else works either */
      pepper_source: await QV.safeAsync(() => pepperSource(env), 'ephemeral'),
      claimed_at: meta && meta.at ? meta.at : null,
      mode: locked(env) ? 'env-only' : (res.owners.length ? 'bound' : 'claimable'),
    };
  };

  /** called from the boot sequence: an env id is always materialised in D1 so
      role lookups, notifications and the admin list agree with each other */
  const sync = async (env, ctx) => {
    /* commit the pepper on the first boot rather than on first use: a node that
       has never minted a code would otherwise report `pepper_source: 'derived'`
       and the console would warn about fingerprints that are about to become
       stable anyway.  One INSERT OR IGNORE per deployment, then it is a read. */
    await QV.safeAsync(() => pepperOf(env), null);
    const ids = envIds(env);
    for (const id of ids) {
      const row = await QV.safeAsync(() => QV.d1.one(env, `SELECT role FROM qv_admins WHERE telegram_id = ?`, id), null);
      if (!row) {
        await QV.safeAsync(() => QV.d1.run(env, `INSERT OR IGNORE INTO qv_admins (telegram_id, name, role) VALUES (?, 'env owner', 'owner')`, id), null);
      } else if (row.role !== 'owner') {
        await QV.safeAsync(() => QV.d1.run(env, `UPDATE qv_admins SET role = 'owner' WHERE telegram_id = ?`, id), null);
      }
    }
    return { ids: ids.length, pepper: await QV.safeAsync(() => pepperSource(env), 'ephemeral') };
  };

  QV.owner = {
    /* introspection */
    ALPHABET, mask, envIds, resolve, recipientIds, roleOf, isAdmin, isOwner: async (env, chat) => (await roleOf(env, chat)) === 'owner',
    unclaimed, rowsOf, status, locked, byFp, resolveTarget,
    /* keyed handles — never reversible, safe to transport */
    tag, fpOf, digestOf, pepperSource,
    /* lifecycle */
    invite, redeem, add, remove, rotate, sync, deepLink,
    /* notification plumbing (used by the telegram module) */
    queueAlert, drainQueue, requeueAlerts, queueLen,
    KEYS: { claim: 'qv:owner:claim:', used: 'qv:owner:claim:used:' },
  };
})();
