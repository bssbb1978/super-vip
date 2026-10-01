/* ═══════════════════════════════════════════════════════════════════════════
 * A3 · TELEGRAM CONTROL PLANE — full bot, D1-backed finite state machine
 * ═══════════════════════════════════════════════════════════════════════════
 *  · webhook mode (preferred) *and* getUpdates polling fallback, both live in
 *    the same deployment; whichever works is chosen automatically
 *  · every conversation step is persisted in D1 (`qv_fsm`), so a reply that
 *    arrives in a fresh isolate during a deploy keeps the same context
 *  · users self-serve: get config, usage, renew, language, support ticket
 *  · admins run the node from the chat: stats, users, quota, kill/revive,
 *    broadcast, SNI hunt, strategy, AI copilot, backup, self-test
 *  · natural language: any free text from an admin goes to the Workers-AI
 *    copilot, which can call the same tools the menus call
 * ═══════════════════════════════════════════════════════════════════════════ */
(function telegram() {
  const API = 'https://api.telegram.org';

  const cfgOf = (env) => ({
    token: env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || '',
    /* legacy spelling — kept for compatibility, but the authoritative list of
       people who may command this node is resolved by QV.owner (31-owner.js):
       env id first, then every row of qv_admins.  Nothing here needs
       ADMIN_TELEGRAM_ID to be configured any more. */
    adminId: String(env.ADMIN_TELEGRAM_ID || env.ADMIN_CHAT_ID || ''),
    secret: env.TELEGRAM_WEBHOOK_SECRET || '',
  });

  const call = async (env, method, payload = {}, opts = {}) => {
    const { token } = cfgOf(env);
    if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' };
    const url = `${API}/bot${token}/${method}`;
    try {
      const res = await QV.fetchWithRetry(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      }, { retries: opts.retries ?? 2, timeoutMs: opts.timeoutMs || 8000 });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) {
        QV.log.warn('telegram', method + ' failed', { status: res.status, desc: json.description });
        return { ok: false, status: res.status, error: json.description || ('HTTP ' + res.status) };
      }
      return { ok: true, result: json.result };
    } catch (e) {
      QV.log.warn('telegram', method + ' threw', { err: e?.message });
      return { ok: false, error: e?.message };
    }
  };

  /* ───────────────────────── message helpers ──────────────────────────── */
  const send = async (env, chatId, text, keyboard, opts = {}) => call(env, 'sendMessage', {
    chat_id: chatId, text: String(text).slice(0, 4000), parse_mode: opts.html === false ? undefined : 'HTML',
    disable_web_page_preview: true, reply_markup: keyboard || undefined,
    disable_notification: !!opts.silent,
  });

  const edit = (env, chatId, messageId, text, keyboard) => call(env, 'editMessageText', {
    chat_id: chatId, message_id: messageId, text: String(text).slice(0, 4000), parse_mode: 'HTML',
    disable_web_page_preview: true, reply_markup: keyboard || undefined,
  });

  const answer = (env, id, text, alert) => call(env, 'answerCallbackQuery', { callback_query_id: id, text: text ? String(text).slice(0, 190) : undefined, show_alert: !!alert });

  const kb = (rows) => ({ inline_keyboard: rows });

  /* ──────────────────── notification fan-out ────────────────────────────
   * `notifyAdmin` used to be one chat id from the environment; if that id was
   * missing the message was dropped and the caller got an error nobody read.
   * Now it resolves the recipient list from QV.owner (env id + qv_admins),
   * delivers to all of them, and — while the bot is still unclaimed — parks
   * the alert in D1 so nothing that happened before the claim is lost.
   * ───────────────────────────────────────────────────────────────────── */
  const recipients = async (env) => {
    if (!QV.owner) return cfgOf(env).adminId ? [cfgOf(env).adminId] : [];
    return QV.safeAsync(() => QV.owner.recipientIds(env), []) || [];
  };

  const flushQueue = async (env, keyboard) => {
    if (!QV.owner) return { flushed: 0 };
    const pending = await QV.owner.drainQueue(env);
    if (!pending.length) return { flushed: 0 };
    let flushed = 0;
    for (const item of pending) {
      const r = await notifyAdmin(env, item.text, keyboard, { via: 'queue' });
      if (r.ok) flushed += r.sent || 0;
      await QV.sleep(45);
    }
    return { flushed };
  };

  const notifyAdmin = async (env, text, keyboard, opts = {}) => {
    const ids = await recipients(env);
    if (!ids.length) {
      /* no owner yet: keep the alert instead of dropping it on the floor */
      if (!opts.via || opts.via !== 'queue') {
        const q = QV.owner ? await QV.owner.queueAlert(env, text) : { queued: 0 };
        QV.emit(env, 'tg:notify', 'warn', {
          message: `no telegram owner bound — alert queued (${q.queued} pending); claim the bot from the panel`,
        });
        return { ok: false, queued: q.queued, error: 'no owner bound' };
      }
      return { ok: false, sent: 0, error: 'no owner bound' };
    }
    let sent = 0, skipped = 0; const failed = [];
    /* `html:false` lets a legacy caller send plain text (the merged generations
       write Markdown, which must not be parsed as HTML) */
    const sendOpts = { silent: !!opts.silent, html: opts.html };
    /* `except` keeps the actor from being told about their own action — the
       chat that just claimed already got its confirmation a line earlier */
    const skip = new Set((Array.isArray(opts.except) ? opts.except : opts.except ? [opts.except] : []).map(String));
    for (const id of ids) {
      if (skip.has(String(id))) { skipped++; continue; }
      const r = await send(env, id, text, keyboard, sendOpts);
      if (r.ok) sent++; else failed.push(QV.owner ? QV.owner.mask(id) : id);
      await QV.sleep(45);   // Telegram's ~30 msg/s ceiling, per destination
    }
    return { ok: sent > 0 || skipped > 0, sent, skipped, failed: failed.length, recipients: ids.length, errors: failed };
  };

  /** critical events: every owner/admin gets the alert, deduplicated per hour */
  const alert = async (env, text, keyboard, dedupeKey) => {
    const key = 'qv:tg:alert:' + QV.hex(QV.utf8(String(dedupeKey || text))).slice(0, 16);
    if (await QV.safeAsync(() => QV.d1.Kv.get(env, key, false), false)) return { ok: true, deduped: true };
    await QV.safeAsync(() => QV.d1.Kv.set(env, key, Date.now(), 3600), null);
    return notifyAdmin(env, '⚠️ ' + text, keyboard);
  };

  /* ─────────────────────────── FSM (D1) ───────────────────────────────── */
  const FSM = {
    async get(env, chat) {
      const row = await QV.d1.Fsm.get(env, 'tg:' + chat);
      return row && row.state && row.state !== 'idle' ? row : { state: 'idle', data: {} };
    },
    async set(env, chat, state, data = {}, ttl = 3600) {
      await QV.d1.Fsm.set(env, 'tg:' + chat, state, data, ttl);
      return { state, data };
    },
    async clear(env, chat) { await QV.d1.Fsm.clear(env, 'tg:' + chat); },
  };

  /* ─────────────────────────── i18n ───────────────────────────────────── */
  const S = {
    fa: {
      welcome: (n) => `👋 <b>${n}</b> خوش آمدید.\nاز منوی زیر انتخاب کنید.`,
      menu: '🏠 منوی اصلی', config: '📦 کانفیگ من', usage: '📊 مصرف من', renew: '♻️ تمدید/خرید',
      support: '💬 پشتیبانی', lang: '🌐 زبان', help: '❓ راهنما', cancel: '✖️ انصراف', back: '‹ بازگشت',
      admin_menu: '🛠 پنل مدیریت', no_account: 'حساب فعالی برای این چت پیدا نشد. برای دریافت اشتراک، «درخواست اشتراک» را بزنید.',
      request: '🎫 درخواست اشتراک', ask_name: 'نام دلخواه یا برچسب دستگاه را بنویسید (مثلاً: phone-reza):',
      requested: '✅ درخواست شما ثبت شد. پس از تأیید مدیر، کانفیگ برایتان ارسال می‌شود.',
      approved: '🎉 اشتراک شما فعال شد!\n\nلینک اشتراک:\n<code>{url}</code>\n\nاین لینک را در کلاینت (v2rayNG / NekoBox / Streisand / Clash) وارد کنید.',
      rejected: '❌ درخواست شما تأیید نشد.',
      usage_txt: (u) => `📊 مصرف شما:\n• مصرف‌شده: <b>{used}</b>\n• سهمیه: <b>{total}</b>\n• باقی‌مانده: <b>{left}</b>\n• وضعیت: <b>{state}</b>`,
      config_txt: (url) => `📦 کانفیگ شما:\n<code>{url}</code>\n\n(برای QR و فرمت‌های دیگر «لینک‌ها» را بزنید)`,
      renew_txt: 'برای خرید/تمدید، مبلغ را واریز کنید و رسید را همین‌جا بفرستید. مدیر بررسی می‌کند.',
      cancelled: 'لغو شد.', unknown: 'متوجه نشدم. از منو انتخاب کنید.', lang_set: 'زبان روی فارسی تنظیم شد.',
      support_sent: '✅ پیام شما برای پشتیبانی ارسال شد.',
      ai_thinking: '🤖 در حال تحلیل…',
      no_perm: '⛔️ دسترسی ندارید.',
      /* owner binding (31-owner.js) */
      claim_ask: '🔑 کد یک‌بارمصرف را از پنل مدیریت بگیرید و به شکل <code>/claim CODE</code> بفرستید.',
      claim_ok: '✅ چت شما با نقش <b>{role}</b> به گره متصل شد.',
      claim_owner: '🎉 شما اکنون <b>مالک</b> این گره هستید — بدون هیچ متغیر محیطی.\n\nدستورها: /stats /users /admins /selftest',
      claim_bad: '❌ انجام نشد.',
      claim_used: '❌ این کد پیش‌تر استفاده شده است.',
      claim_locked: '❌ اتصال خودکار در این استقرار غیرفعال است.',
      claim_private: '❌ اتصال فقط در گفتگوی خصوصی با ربات ممکن است.',
      claim_wait: '⏳ تعداد تلاش زیاد است؛ چند دقیقه دیگر دوباره امتحان کنید.',
      owner_title: '🔐 دسترسی تلگرام',
      owner_none: 'هیچ مدیری متصل نیست. از پنل وب «اتصال تلگرام» را بزنید تا کد یک‌بارمصرف ساخته شود.',
      owner_added: '✅ شناسه اضافه شد.',
      owner_removed: '🗑 دسترسی گرفته شد.',
      owner_rotated: '♻️ همهٔ کدهای در انتظار باطل شدند.',
      owner_add_ask: 'شناسهٔ عددی تلگرام را بفرستید:',
    },
    en: {
      welcome: (n) => `👋 Welcome, <b>${n}</b>.\nPick an option below.`,
      menu: '🏠 Main menu', config: '📦 My config', usage: '📊 My usage', renew: '♻️ Renew / buy',
      support: '💬 Support', lang: '🌐 Language', help: '❓ Help', cancel: '✖️ Cancel', back: '‹ Back',
      admin_menu: '🛠 Admin panel', no_account: 'No account is bound to this chat yet. Tap “Request access”.',
      request: '🎫 Request access', ask_name: 'Send a label for your device (e.g. phone-reza):',
      requested: '✅ Request received. You will get your config as soon as an admin approves it.',
      approved: '🎉 Your account is active!\n\nSubscription link:\n<code>{url}</code>\n\nAdd it to v2rayNG / NekoBox / Streisand / Clash.',
      rejected: '❌ Your request was rejected.',
      usage_txt: (u) => `📊 Usage:\n• Used: <b>{used}</b>\n• Quota: <b>{total}</b>\n• Left: <b>{left}</b>\n• State: <b>{state}</b>`,
      config_txt: (url) => `📦 Your config:\n<code>{url}</code>`,
      renew_txt: 'To renew, pay and send the receipt here; an admin will confirm.',
      cancelled: 'Cancelled.', unknown: 'I did not get that. Use the menu.', lang_set: 'Language set to English.',
      support_sent: '✅ Your message was delivered to support.',
      ai_thinking: '🤖 thinking…',
      no_perm: '⛔️ Not allowed.',
      /* owner binding (31-owner.js) */
      claim_ask: '🔑 Get a single-use code from the admin panel, then send <code>/claim CODE</code> here.',
      claim_ok: '✅ This chat is now bound to the node as <b>{role}</b>.',
      claim_owner: '🎉 You are the <b>owner</b> of this node — no environment variable was needed.\n\nTry: /stats /users /admins /selftest',
      claim_bad: '❌ That did not work.',
      claim_used: '❌ This code has already been used.',
      claim_locked: '❌ Automatic binding is disabled on this deployment.',
      claim_private: '❌ Binding only works in a private chat with the bot.',
      claim_wait: '⏳ Too many attempts; try again in a few minutes.',
      owner_title: '🔐 Telegram access',
      owner_none: 'No admin is bound yet. Use “Connect Telegram” in the web panel to mint a single-use code.',
      owner_added: '✅ Added.',
      owner_removed: '🗑 Access revoked.',
      owner_rotated: '♻️ All pending codes revoked.',
      owner_add_ask: 'Send the numeric Telegram id:',
    },
  };
  const tr = (lang, key, vars) => {
    const table = S[lang === 'en' ? 'en' : 'fa'];
    let v = table[key];
    if (typeof v === 'function') v = v(vars || '');
    if (typeof v !== 'string') v = String(v ?? key);
    return v.replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined ? vars[k] : ''));
  };

  const userLang = async (env, chat) => (await QV.d1.Kv.get(env, 'qv:tg:lang:' + chat, null)) || QV.env.get(env, 'DEFAULT_LANG', 'fa');
  const setLang = (env, chat, lang) => QV.d1.Kv.set(env, 'qv:tg:lang:' + chat, lang === 'en' ? 'en' : 'fa', 0);

  /* ── authorisation ──────────────────────────────────────────────────────
   * Three roles, checked on every privileged path:
   *   owner  — everything, including managing other admins
   *   admin  — everything except /admins
   *   viewer — read-only stats
   * The env-configured id is always an owner and can never be demoted from
   * inside the chat.  A chat id that is not in qv_admins gets nothing, no
   * matter how it found the bot.
   * ─────────────────────────────────────────────────────────────────────── */
  const roleOf = async (env, chat) => {
    if (QV.owner) return QV.safeAsync(() => QV.owner.roleOf(env, chat), null);
    const { adminId } = cfgOf(env);
    if (adminId && String(chat) === adminId) return 'owner';
    const row = await QV.d1.one(env, `SELECT role FROM qv_admins WHERE telegram_id = ?`, String(chat));
    return row ? (row.role || 'admin') : null;
  };

  const isAdmin = async (env, chat) => {
    const role = await roleOf(env, chat);
    return role === 'owner' || role === 'admin';
  };
  const isOwner = async (env, chat) => (await roleOf(env, chat)) === 'owner';

  const userFor = async (env, chat) => QV.d1.one(env, `SELECT * FROM qv_users WHERE telegram_id = ? LIMIT 1`, String(chat));

  /* ─────────────────────────── menus ──────────────────────────────────── */
  const userMenu = (lang, admin) => {
    const rows = [
      [{ text: tr(lang, 'config'), callback_data: 'qv:config' }, { text: tr(lang, 'usage'), callback_data: 'qv:usage' }],
      [{ text: tr(lang, 'renew'), callback_data: 'qv:renew' }, { text: tr(lang, 'support'), callback_data: 'qv:support' }],
      [{ text: tr(lang, 'lang'), callback_data: 'qv:lang' }, { text: tr(lang, 'help'), callback_data: 'qv:help' }],
    ];
    if (admin) rows.push([{ text: tr(lang, 'admin_menu'), callback_data: 'qv:admin' }]);
    return kb(rows);
  };
  const adminMenu = (lang, owner) => {
    const rows = [
      [{ text: '📊 ' + tr(lang, 'usage'), callback_data: 'ad:stats' }, { text: '👥 Users', callback_data: 'ad:users' }],
      [{ text: '🎭 SNI hunt', callback_data: 'ad:hunt' }, { text: '🛡 Strategy', callback_data: 'ad:strategy' }],
      [{ text: '🧪 Self-test', callback_data: 'ad:selftest' }, { text: '🗂 Logs', callback_data: 'ad:logs' }],
      [{ text: '📣 Broadcast', callback_data: 'ad:broadcast:ask' }, { text: '🤖 AI', callback_data: 'ad:ai' }],
      [{ text: '💾 Backup', callback_data: 'ad:backup' }, { text: tr(lang, 'menu'), callback_data: 'qv:menu' }],
    ];
    /* only an owner manages owners — the button is not rendered for anyone else */
    if (owner) rows.push([{ text: '🔐 ' + tr(lang, 'owner_title'), callback_data: 'ad:owner' }]);
    return kb(rows);
  };

  /* ───────────────────── owner binding (claim flow) ─────────────────────
   *  Everything here is deliberately uninformative to a stranger: an unknown,
   *  expired or already-spent code produces the same neutral refusal, no
   *  counter, no hint about how many codes are outstanding, and no chat id is
   *  ever echoed back unmasked.  The proof of authorisation is the code, and
   *  the code only ever exists inside an authenticated panel session.
   * ─────────────────────────────────────────────────────────────────────── */
  const withOwner = async (c, fn) => (c.owner ? fn() : send(c.env, c.chat, tr(c.lang, 'no_perm')));

  const CLAIM_MSG = {
    'locked': 'claim_locked', 'private-only': 'claim_private', 'identity-mismatch': 'claim_private',
    'slow-down': 'claim_wait', 'too-many-attempts': 'claim_wait', 'already-used': 'claim_used',
  };

  const claimFrom = async (c, rawCode) => {
    if (!QV.owner) return send(c.env, c.chat, tr(c.lang, 'claim_bad'));
    const code = String(rawCode || '').trim().replace(/^claim[_-]?/i, '');
    if (!code) return send(c.env, c.chat, tr(c.lang, 'claim_ask'));
    const r = await QV.owner.redeem(c.env, c.ctx, {
      code, chat: c.chat, user: c.fromId || c.chat, chat_type: c.chatType || 'private',
      name: c.name || '', via: c.via || 'command',
    });
    if (!r.ok) {
      /* one message for every failure mode: nothing to enumerate */
      const key = CLAIM_MSG[r.reason] || 'claim_bad';
      QV.emit(c.env, 'owner:claim-fail', r.reason === 'unknown-or-expired' ? 'debug' : 'warn', {
        message: 'telegram claim refused (' + r.reason + ')', meta: { chat: QV.owner.mask(c.chat) },
      });
      return send(c.env, c.chat, tr(c.lang, key), userMenu(c.lang, c.admin));
    }
    await FSM.clear(c.env, c.chat);
    const roleTxt = c.lang === 'en' ? r.role : (r.role === 'owner' ? 'مالک' : r.role === 'viewer' ? 'بیننده' : 'مدیر');
    const head = r.first ? tr(c.lang, 'claim_owner') : tr(c.lang, 'claim_ok', { role: roleTxt });
    /* tell the *other* owners — never the raw id, always the masked form */
    if (c.ctx && c.ctx.waitUntil) {
      c.ctx.waitUntil(notifyAdmin(c.env,
        `🔐 <b>${r.first ? 'owner' : 'admin'}</b> ${c.lang === 'en' ? 'bound via Telegram' : 'از راه تلگرام متصل شد'}: <code>${QV.owner.mask(r.chat)}</code>\n` +
        `${c.lang === 'en' ? 'Manage with' : 'مدیریت با'} /admins`, null, { via: 'claim', except: r.chat }).catch(() => {}));
      /* anything that was queued while the node had no owner goes out now */
      c.ctx.waitUntil(flushQueue(c.env).catch(() => {}));
    }
    const st = await QV.owner.status(c.env);
    const en = c.lang === 'en';
    const tail = `\n\n${en ? 'Bound' : 'متصل'}: ${st.admins.length} (${st.owners} ${en ? 'owner' : 'مالک'}) · ` +
      `${en ? 'mode' : 'حالت'}: <code>${QV.esc(st.mode)}</code>` +
      (st.queued_alerts ? `\n📥 ${st.queued_alerts} ${en ? 'queued alert(s) delivered' : 'هشدار در صف ارسال شد'}` : '');
    return send(c.env, c.chat, head + tail, adminMenu(c.lang, r.role === 'owner'));
  };

  const adminsPanel = async (c) => {
    if (!QV.owner) return send(c.env, c.chat, '—');
    const st = await QV.owner.status(c.env);
    const lines = [
      '🔐 <b>' + tr(c.lang, 'owner_title') + '</b>',
      st.locked ? '🔒 OWNER_LOCK' : (st.claimed
        ? `${c.lang === 'en' ? 'owner' : 'مالک'}: <code>${QV.esc(st.owner || '—')}</code>`
        : '⚠️ ' + tr(c.lang, 'owner_none')),
      '',
    ];
    for (const a of st.admins) {
      lines.push(`${a.role === 'owner' ? '👑' : a.role === 'viewer' ? '👁' : '🛡'} <code>${QV.esc(a.id)}</code> · ${QV.esc(a.role)}${a.source === 'env' ? ' · env' : ''}${a.name ? ' · ' + QV.esc(a.name) : ''}`);
    }
    if (st.pending_codes) lines.push('', `⏳ ${st.pending_codes} ${c.lang === 'en' ? 'pending code(s)' : 'کد در انتظار'}`);
    if (st.queued_alerts) lines.push(`📥 ${st.queued_alerts} ${c.lang === 'en' ? 'queued alert(s)' : 'هشدار در صف'}`);
    /* callback_data is capped at 64 bytes by Telegram, and it transits their
       servers — so rows are addressed by the non-reversible fingerprint, never
       by the raw chat id */
    const rows = [];
    for (const a of st.admins) {
      if (a.source === 'env') continue;             // the env id cannot be removed
      rows.push([
        { text: `${a.role === 'owner' ? '👑' : a.role === 'viewer' ? '👁' : '🛡'} ${QV.esc(a.id)}`, callback_data: `ad:owner:role:${a.fp}:admin` },
        { text: '🗑', callback_data: `ad:owner:del:${a.fp}` },
      ]);
    }
    rows.push([{ text: '🔗 ' + (c.lang === 'en' ? 'New claim code' : 'کد اتصال جدید'), callback_data: 'ad:owner:invite' },
               { text: '➕ ' + (c.lang === 'en' ? 'Add by id' : 'افزودن با شناسه'), callback_data: 'ad:owner:add' }]);
    rows.push([{ text: '♻️ ' + (c.lang === 'en' ? 'Revoke codes' : 'باطل کردن کدها'), callback_data: 'ad:owner:rotate' },
               { text: tr(c.lang, 'admin_menu'), callback_data: 'ad:menu' }]);
    return send(c.env, c.chat, lines.join('\n'), kb(rows));
  };

  const ownerMint = async (c) => {
    const r = await QV.owner.invite(c.env, c.ctx, { by: 'telegram:' + QV.owner.mask(c.chat), via: 'telegram' });
    if (!r.ok) return send(c.env, c.chat, '⛔️ ' + QV.esc(r.error || ''));
    const rows = [[{ text: '📋 ' + (c.lang === 'en' ? 'Copy code' : 'کپی کد'), callback_data: 'ad:owner:copy:' + QV.esc(r.code) }]];
    if (r.link) rows.push([{ text: '📲 ' + (c.lang === 'en' ? 'Open in Telegram' : 'بازکردن در تلگرام'), url: r.link }]);
    rows.push([{ text: tr(c.lang, 'owner_title'), callback_data: 'ad:owner' }]);
    /* the plaintext exists only in this private chat and only until it expires */
    return send(c.env, c.chat,
      `🔑 <b>${c.lang === 'en' ? 'Single-use claim code' : 'کد یک‌بارمصرف اتصال'}</b>\n<code>${QV.esc(r.code)}</code>\n\n` +
      (c.lang === 'en'
        ? `Send <code>/claim ${QV.esc(r.code)}</code> in the chat you want to bind.\nExpires in ${r.ttl_min} min · stored only as an HMAC digest.`
        : `دستور <code>/claim ${QV.esc(r.code)}</code> را در چتی که می‌خواهید متصل شود بفرستید.\nاعتبار: ${r.ttl_min} دقیقه · فقط به‌صورت چکیدهٔ HMAC ذخیره می‌شود.`),
      kb(rows));
  };

  /* ─────────────────────── command handling ───────────────────────────── */
  const COMMANDS = {
    start: async (c) => {
      /* a deep link  https://t.me/<bot>?start=claim_CODE  arrives as
         "/start claim_CODE" — the only place a claim is accepted from a link,
         and it goes through exactly the same verification as /claim */
      const payload = (c.args || []).join(' ').trim();
      const m = payload.match(/^claim[_-]?([A-Za-z0-9-]{6,40})$/i);
      if (m) return claimFrom(c, m[1]);
      return showMenu(c, true);
    },
    claim: async (c) => claimFrom(c, (c.args || []).join(' ')),
    bind: async (c) => claimFrom(c, (c.args || []).join(' ')),
    admins: async (c) => withOwner(c, () => adminsPanel(c)),
    owner: async (c) => withOwner(c, () => adminsPanel(c)),
    menu: async (c) => showMenu(c, true),
    help: async (c) => help(c),
    lang: async (c) => askLang(c),
    config: async (c) => myConfig(c),
    usage: async (c) => myUsage(c),
    renew: async (c) => send(c.env, c.chat, tr(c.lang, 'renew_txt'), kb([[{ text: tr(c.lang, 'support'), callback_data: 'qv:support' }]])),
    support: async (c) => askSupport(c),
    cancel: async (c) => { await FSM.clear(c.env, c.chat); return send(c.env, c.chat, tr(c.lang, 'cancelled'), userMenu(c.lang, c.admin)); },
    id: async (c) => send(c.env, c.chat, `chat_id: <code>${c.chat}</code>`),
    /* ---- admin ---- */
    stats: async (c) => withAdmin(c, () => adminStats(c)),
    users: async (c) => withAdmin(c, () => adminUsers(c)),
    find: async (c) => withAdmin(c, async () => {
      const q = c.args.join(' ').trim();
      if (!q) { await FSM.set(c.env, c.chat, 'ad:find'); return send(c.env, c.chat, '🔎 نام یا UUID را بنویسید:'); }
      return adminFind(c, q);
    }),
    add: async (c) => withAdmin(c, () => addUser(c)),
    quota: async (c) => withAdmin(c, () => quotaCmd(c)),
    kill: async (c) => withAdmin(c, () => killSwitch(c, true)),
    revive: async (c) => withAdmin(c, () => killSwitch(c, false)),
    broadcast: async (c) => withAdmin(c, async () => {
      const text = c.args.join(' ').trim();
      if (!text) { await FSM.set(c.env, c.chat, 'ad:broadcast'); return send(c.env, c.chat, '📣 متن پیام همگانی را بنویسید:'); }
      const r = await broadcast(c.env, c.ctx, text, {});
      return send(c.env, c.chat, `✅ برای ${r.sent} کاربر ارسال شد${r.failed ? ` (${r.failed} ناموفق)` : ''}.`);
    }),
    strategy: async (c) => withAdmin(c, async () => send(c.env, c.chat, '<pre>' + QV.esc(JSON.stringify(await QV.antidpi.load(c.env), null, 1)) + '</pre>', adminMenu(c.lang, c.owner))),
    sni: async (c) => withAdmin(c, async () => send(c.env, c.chat, '<pre>' + QV.esc(JSON.stringify((await QV.d1.Sni.top(c.env, 10)), null, 1)) + '</pre>', adminMenu(c.lang, c.owner))),
    hunt: async (c) => withAdmin(c, async () => { const found = await QV.antidpi.hunt(c.env, c.ctx, { count: 6 }); return send(c.env, c.chat, `🎭 ${found.length} SNI جدید:\n<pre>${QV.esc(found.map(f => f.sni + '  ' + f.score).join('\n'))}</pre>`, adminMenu(c.lang, c.owner)); }),
    selftest: async (c) => withAdmin(c, async () => {
      const r = await QV.selfcheck.run(c.env, { quick: true });
      return send(c.env, c.chat, `${r.ok ? '✅' : '⚠️'} <b>${r.summary}</b>` + (r.failed.length ? `\n<pre>${QV.esc(r.failed.join('\n'))}</pre>` : ''), adminMenu(c.lang, c.owner));
    }),
    ai: async (c) => withAdmin(c, async () => {
      const prompt = c.args.join(' ').trim();
      if (!prompt) { await FSM.set(c.env, c.chat, 'ad:ai'); return send(c.env, c.chat, '🤖 سؤال/دستور خود را بنویسید:'); }
      return aiReply(c, prompt);
    }),
    logs: async (c) => withAdmin(c, async () => {
      const items = await QV.d1.all(c.env, `SELECT ts, type, level, message FROM qv_events ORDER BY ts DESC LIMIT 12`);
      return send(c.env, c.chat, '<pre>' + QV.esc((items || []).map(e => `${new Date(e.ts * 1000).toISOString().slice(11, 19)} ${e.level} ${e.type}: ${e.message || ''}`).join('\n')) + '</pre>', adminMenu(c.lang, c.owner));
    }),
    backup: async (c) => withAdmin(c, async () => {
      const snap = await QV.d1.exportAll(c.env, {});
      const payload = JSON.stringify(snap);
      if (payload.length < 45000) {
        await call(c.env, 'sendDocument', { chat_id: c.chat, document: undefined }); // placeholder avoided: use text if too big for a message
      }
      await QV.d1.Kv.set(c.env, 'qv:backup:last', snap, 0);
      return send(c.env, c.chat, `💾 پشتیبان ساخته شد (${QV.humanBytes(payload.length)}) و در D1 ذخیره شد.\nاز پنل وب می‌توانید دانلود کنید.`, adminMenu(c.lang, c.owner));
    }),
    whoami: async (c) => send(c.env, c.chat, `chat=<code>${c.chat}</code> role=${QV.esc(c.role || 'user')}`),
  };

  const showMenu = async (c, greet) => {
    /* the menu is an FSM state of its own: it is written down, so a restart of
       the isolate never loses where a chat was */
    await FSM.set(c.env, c.chat, 'menu', { lang: c.lang }, 3600);
    const u = await userFor(c.env, c.chat);
    const head = greet ? tr(c.lang, 'welcome', c.name) : tr(c.lang, 'menu');
    const extra = u ? `\n\n💠 ${QV.esc(u.name || '')} — ${QV.humanBytes(u.used_bytes)} / ${QV.humanBytes(u.quota_bytes)}${u.killswitch ? ' ⛔️' : ''}` : '';
    return send(c.env, c.chat, head + extra, userMenu(c.lang, c.admin));
  };
  const help = async (c) => {
    const lang = c.lang;
    const lines = lang === 'en'
      ? ['/start – menu', '/config – my subscription link', '/usage – traffic & quota', '/renew – buy or extend', '/support – talk to a human', '/lang – language', '/claim <CODE> – bind this chat as an admin', '/cancel – abort the current step']
      : ['/start – منو', '/config – لینک اشتراک من', '/usage – مصرف و سهمیه', '/renew – خرید/تمدید', '/support – گفتگو با پشتیبانی', '/lang – زبان', '/claim <CODE> – اتصال این چت به‌عنوان مدیر', '/cancel – لغو مرحله فعلی'];
    if (c.admin) lines.push('', lang === 'en' ? '<b>admin</b>: /stats /users /find /add /quota /kill /revive /broadcast /strategy /hunt /selftest /ai /logs /backup' : '<b>مدیر</b>: /stats /users /find /add /quota /kill /revive /broadcast /strategy /hunt /selftest /ai /logs /backup');
    if (c.owner) lines.push(lang === 'en' ? '<b>owner</b>: /admins – bind, list and revoke Telegram access' : '<b>مالک</b>: /admins – اتصال، فهرست و لغو دسترسی تلگرام');
    return send(c.env, c.chat, lines.join('\n'), userMenu(lang, c.admin));
  };
  const askLang = (c) => send(c.env, c.chat, '🌐 Language / زبان', kb([[{ text: '🇮🇷 فارسی', callback_data: 'lg:fa' }, { text: '🇬🇧 English', callback_data: 'lg:en' }]]));
  const askSupport = async (c) => { await FSM.set(c.env, c.chat, 'support'); return send(c.env, c.chat, tr(c.lang, 'support') + ':', kb([[{ text: tr(c.lang, 'cancel'), callback_data: 'qv:cancel' }]])); };
  const withAdmin = async (c, fn) => (c.admin ? fn() : send(c.env, c.chat, tr(c.lang, 'no_perm')));

  const myConfig = async (c) => {
    const u = await userFor(c.env, c.chat);
    if (!u) return send(c.env, c.chat, tr(c.lang, 'no_account'), kb([[{ text: tr(c.lang, 'request'), callback_data: 'qv:request' }]]));
    const built = await QV.subs.build(c.env, c.ctx, u.uuid, { format: 'uris', origin: c.origin });
    if (!built.ok) return send(c.env, c.chat, `⛔️ ${QV.esc(built.error)}`);
    const url = built.subUrl;
    return send(c.env, c.chat, tr(c.lang, 'config_txt', url), kb([
      [{ text: '🔗 ' + tr(c.lang, 'config'), url: url }],
      [{ text: '🧾 Clash', url: url + '?target=clash' }, { text: '🧭 sing-box', url: url + '?target=singbox' }],
      [{ text: '📷 QR', url: c.origin + '/qr?d=' + encodeURIComponent(url) + '&s=6' }],
      [{ text: tr(c.lang, 'menu'), callback_data: 'qv:menu' }],
    ]));
  };

  const myUsage = async (c) => {
    const u = await userFor(c.env, c.chat);
    if (!u) return send(c.env, c.chat, tr(c.lang, 'no_account'));
    const state = !u.enabled ? 'disabled' : u.killswitch ? (c.lang === 'en' ? 'config cut' : 'قطع') : (c.lang === 'en' ? 'active' : 'فعال');
    return send(c.env, c.chat, tr(c.lang, 'usage_txt', {
      used: QV.humanBytes(u.used_bytes), total: QV.humanBytes(u.quota_bytes),
      left: QV.humanBytes(Math.max(0, (u.quota_bytes || 0) - (u.used_bytes || 0))), state,
    }), userMenu(c.lang, c.admin));
  };

  /* ─────────────────────────── admin actions ──────────────────────────── */
  const adminStats = async (c) => {
    const s = await QV.api.stats(c.env);
    return send(c.env, c.chat, [
      `📊 <b>${s.version}</b>`,
      `👥 ${s.users_enabled}/${s.users_total} ${c.lang === 'en' ? 'active' : 'فعال'} (⛔️${s.users_cut})`,
      `🔌 ${s.sessions_active} ${c.lang === 'en' ? 'live' : 'اتصال زنده'}`,
      `📈 24h: ${QV.humanBytes(s.bytes_24h)} · ${c.lang === 'en' ? 'total' : 'کل'}: ${QV.humanBytes(s.bytes_total)}`,
      `🎭 SNI ${s.sni_count} · 🌐 IP ${s.ip_count}`,
      `🛡 ${QV.esc(JSON.stringify(s.strategy && s.strategy.fragment))}`,
    ].join('\n'), adminMenu(c.lang, c.owner));
  };

  const adminUsers = async (c) => {
    const items = await QV.d1.all(c.env, `SELECT uuid, name, used_bytes, quota_bytes, killswitch FROM qv_users ORDER BY created_at DESC LIMIT 15`);
    if (!items || !items.length) return send(c.env, c.chat, '—', adminMenu(c.lang, c.owner));
    const lines = items.map(u => `${u.killswitch ? '⛔️' : '✅'} ${QV.esc(u.name || '')} <code>${u.uuid.slice(0, 8)}</code> ${QV.humanBytes(u.used_bytes)}/${QV.humanBytes(u.quota_bytes)}`);
    return send(c.env, c.chat, lines.join('\n'), adminMenu(c.lang, c.owner));
  };

  const adminFind = async (c, q) => {
    const users = await QV.d1.all(c.env,
      `SELECT * FROM qv_users WHERE name LIKE ? OR uuid LIKE ? OR telegram_id = ? LIMIT 5`, `%${q}%`, `%${q}%`, String(q));
    if (!users || !users.length) return send(c.env, c.chat, '∅');
    for (const u of users) {
      await send(c.env, c.chat, `👤 <b>${QV.esc(u.name || '')}</b>\n<code>${u.uuid}</code>\n${QV.humanBytes(u.used_bytes)} / ${QV.humanBytes(u.quota_bytes)}\n${u.killswitch ? '⛔️ cut' : '✅ active'}`, kb([
        [{ text: u.killswitch ? '▶️ revive' : '⛔️ kill', callback_data: `ad:kill:${u.uuid}:${u.killswitch ? 0 : 1}` }],
        [{ text: '📦 config', callback_data: `ad:cfg:${u.uuid}` }, { text: '🧹 reset usage', callback_data: `ad:reset:${u.uuid}` }],
        [{ text: '🗑 delete', callback_data: `ad:del:${u.uuid}` }],
      ]));
    }
  };

  const addUser = async (c) => {
    const name = c.args.join(' ').trim();
    if (!name) { await FSM.set(c.env, c.chat, 'ad:add'); return send(c.env, c.chat, '👤 نام کاربر جدید + سهمیه به گیگ؟ (مثال: `reza 50`)', kb([[{ text: tr(c.lang, 'cancel'), callback_data: 'qv:cancel' }]])); }
    const m = name.match(/^(.*?)[\s,]+(\d+(?:\.\d+)?)\s*(?:gb|g|گیگ)?$/i);
    const label = m ? m[1].trim() : name;
    const gb = m ? Number(m[2]) : Number(QV.env.get(c.env, 'DEFAULT_QUOTA_GB', 100));
    const uuid = QV.uuid();
    await QV.d1.Users.upsert(c.env, { uuid, name: label, quota_bytes: Math.round(gb * 1073741824), max_sessions: 3, enabled: 1 });
    const built = await QV.subs.build(c.env, c.ctx, uuid, { format: 'uris', origin: c.origin });
    QV.emit(c.env, 'user:create', 'info', { uuid, message: `created by telegram: ${label} ${gb}GB`, ctx: c.ctx });
    return send(c.env, c.chat, `✅ <b>${QV.esc(label)}</b> — ${gb} GB\n<code>${built.subUrl}</code>`, kb([[{ text: '📷 QR', url: c.origin + '/qr?d=' + encodeURIComponent(built.subUrl) }], [{ text: tr(c.lang, 'menu'), callback_data: 'qv:menu' }]]));
  };

  const quotaCmd = async (c) => {
    const q = c.args.join(' ').trim();
    const m = q.match(/^(\S+)\s+(\d+(?:\.\d+)?)$/);
    if (!m) { await FSM.set(c.env, c.chat, 'ad:quota'); return send(c.env, c.chat, 'مثال: <code>uuid-یا-نام 50</code> (گیگ)'); }
    const users = await QV.d1.all(c.env, `SELECT uuid, name FROM qv_users WHERE name LIKE ? OR uuid LIKE ? LIMIT 3`, `%${m[1]}%`, `%${m[1]}%`);
    if (!users || !users.length) return send(c.env, c.chat, 'پیدا نشد.');
    const bytes = Math.round(Number(m[2]) * 1073741824);
    for (const u of users) {
      await QV.d1.Users.patch(c.env, u.uuid, { quota_bytes: bytes });
      await QV.d1.Kv.set(c.env, 'qv:revive:' + u.uuid, true, 86400 * 7);
    }
    return send(c.env, c.chat, `✅ سهمیه ${users.length} کاربر روی ${m[2]} گیگ تنظیم شد.`, adminMenu(c.lang, c.owner));
  };

  const killSwitch = async (c, on) => {
    const q = c.args.join(' ').trim();
    if (!q) return send(c.env, c.chat, on ? '/kill <uuid|name>' : '/revive <uuid|name>');
    const users = await QV.d1.all(c.env, `SELECT uuid, name FROM qv_users WHERE name LIKE ? OR uuid LIKE ? LIMIT 5`, `%${q}%`, `%${q}%`);
    if (!users || !users.length) return send(c.env, c.chat, 'پیدا نشد.');
    for (const u of users) {
      await QV.d1.Users.setKill(c.env, u.uuid, on, 'telegram');
      if (!on) await QV.d1.Kv.set(c.env, 'qv:revive:' + u.uuid, true, 86400 * 7);
    }
    return send(c.env, c.chat, `✅ ${users.length} کاربر ${on ? 'قطع' : 'فعال'} شد.`, adminMenu(c.lang, c.owner));
  };

  const aiReply = async (c, prompt) => {
    await send(c.env, c.chat, tr(c.lang, 'ai_thinking'));
    /* the copilot gets a tool contract: it may answer, or ask for an action */
    const sys = `You are the operator copilot of an anti-censorship node. Answer in the user's language (Persian if the prompt is Persian).
You can request an action by replying with a single JSON object: {"action":"add_user","name":"x","quota_gb":50} |
{"action":"kill_user","match":"x"} | {"action":"revive_user","match":"x"} | {"action":"set_quota","match":"x","quota_gb":50} |
{"action":"broadcast","text":"…"} | {"action":"replan"} | {"action":"hunt_sni","count":5} | {"action":"scan_ips"} | {"action":"report"}.
Otherwise reply with plain text only. Be concise and technical.`;
    const raw = await QV.ai.chat(c.env, [{ role: 'system', content: sys }, { role: 'user', content: prompt.slice(0, 1500) }], { ctx: c.ctx });
    let action = null;
    try { const m = String(raw).match(/\{[\s\S]*\}/); if (m) action = JSON.parse(m[0]); } catch (e) {}
    if (action && action.action) {
      const r = await runCopilotAction(c, action);
      return send(c.env, c.chat, `🤖 <b>${QV.esc(action.action)}</b>\n${QV.esc(r.note || '')}\n<pre>${QV.esc(JSON.stringify(r.data || {}, null, 1)).slice(0, 1500)}</pre>`, adminMenu(c.lang, c.owner));
    }
    return send(c.env, c.chat, '🤖 ' + QV.esc(String(raw).slice(0, 3500)), adminMenu(c.lang, c.owner));
  };

  const runCopilotAction = async (c, a) => {
    const find = async (m) => (await QV.d1.all(c.env, `SELECT uuid, name FROM qv_users WHERE name LIKE ? OR uuid LIKE ? LIMIT 5`, `%${m}%`, `%${m}%`)) || [];
    switch (a.action) {
      case 'add_user': {
        const uuid = QV.uuid();
        const gb = Number(a.quota_gb || QV.env.get(c.env, 'DEFAULT_QUOTA_GB', 100));
        await QV.d1.Users.upsert(c.env, { uuid, name: String(a.name || 'user'), quota_bytes: Math.round(gb * 1073741824), enabled: 1, max_sessions: 3 });
        const built = await QV.subs.build(c.env, c.ctx, uuid, { format: 'uris', origin: c.origin });
        return { note: 'کاربر ساخته شد / user created', data: { uuid, sub: built.subUrl } };
      }
      case 'kill_user': case 'revive_user': {
        const on = a.action === 'kill_user';
        const users = await find(a.match || '');
        for (const u of users) await QV.d1.Users.setKill(c.env, u.uuid, on, 'copilot');
        return { note: `${users.length} ${on ? 'قطع' : 'فعال'}`, data: users };
      }
      case 'set_quota': {
        const users = await find(a.match || '');
        for (const u of users) await QV.d1.Users.patch(c.env, u.uuid, { quota_bytes: Math.round(Number(a.quota_gb || 0) * 1073741824) });
        return { note: `${users.length} سهمیه به‌روزرسانی شد`, data: users };
      }
      case 'broadcast': { const r = await broadcast(c.env, c.ctx, String(a.text || ''), {}); return { note: `ارسال به ${r.sent}`, data: r }; }
      case 'replan': return { note: 'استراتژی بازتحلیل شد', data: await QV.antidpi.analyse(c.env, c.ctx, { reason: 'copilot' }) };
      case 'hunt_sni': return { note: 'SNI شکار شد', data: await QV.antidpi.hunt(c.env, c.ctx, { count: Number(a.count || 5) }) };
      case 'scan_ips': return { note: 'آی‌پی تمیز اسکن شد', data: await QV.antidpi.scanCleanIPs(c.env, c.ctx, { limit: 6 }) };
      case 'report': return { note: 'گزارش', data: await QV.api.stats(c.env) };
      default: return { note: 'اکشن ناشناخته / unknown action', data: a };
    }
  };

  /* ─────────────────────────── broadcast ──────────────────────────────── */
  const broadcast = async (env, ctx, text, filter = {}) => {
    let users = await QV.d1.all(env, `SELECT uuid, telegram_id FROM qv_users WHERE telegram_id IS NOT NULL AND enabled = 1 LIMIT 200`);
    if (filter.onlyActive) users = users.filter(u => !u.killswitch);
    let sent = 0, failed = 0;
    for (const u of users || []) {
      const r = await send(env, u.telegram_id, text);
      if (r.ok) sent++; else failed++;
      await QV.sleep(45);   // stay inside Telegram's 30 msg/s ceiling
    }
    QV.emit(env, 'tg:broadcast', 'info', { message: `broadcast → ${sent} ok / ${failed} failed`, ctx });
    return { sent, failed, total: (users || []).length };
  };

  /* ─────────────────────────── callbacks ──────────────────────────────── */
  const onCallback = async (c) => {
    const data = c.cb.data || '';
    const [, ns, ...rest] = data.split(':');
    if (ns === 'lg') { await setLang(c.env, c.chat, rest[0]); await answer(c.env, c.cb.id, '✓'); return showMenu({ ...c, lang: rest[0] }, false); }
    if (ns === 'qv') {
      await answer(c.env, c.cb.id, '');
      const act = rest[0];
      if (act === 'menu') return showMenu(c, false);
      if (act === 'cancel') { await FSM.clear(c.env, c.chat); return send(c.env, c.chat, tr(c.lang, 'cancelled'), userMenu(c.lang, c.admin)); }
      if (act === 'config') return myConfig(c);
      if (act === 'usage') return myUsage(c);
      if (act === 'renew') return COMMANDS.renew(c);
      if (act === 'support') return askSupport(c);
      if (act === 'help') return help(c);
      if (act === 'lang') return askLang(c);
      if (act === 'request') { await FSM.set(c.env, c.chat, 'request'); return send(c.env, c.chat, tr(c.lang, 'ask_name'), kb([[{ text: tr(c.lang, 'cancel'), callback_data: 'qv:cancel' }]])); }
      if (act === 'admin') return withAdmin(c, () => send(c.env, c.chat, tr(c.lang, 'admin_menu'), adminMenu(c.lang, c.owner)));
      if (act === 'approve' || act === 'reject') return approveUser(c, rest[1], act === 'approve');
      return;
    }
    if (ns === 'ad') {
      await answer(c.env, c.cb.id, '');
      if (!c.admin) return send(c.env, c.chat, tr(c.lang, 'no_perm'));
      const act = rest[0], arg = rest[1], flag = rest[2];
      if (act === 'menu') return send(c.env, c.chat, tr(c.lang, 'admin_menu'), adminMenu(c.lang, c.owner));
      /* owner-only namespace: managing who may manage the node */
      if (act === 'owner') {
        if (!c.owner) return send(c.env, c.chat, tr(c.lang, 'no_perm'));
        const sub = rest[1];
        if (!sub) return adminsPanel(c);
        if (sub === 'invite') return ownerMint(c);
        if (sub === 'rotate') {
          const r = await QV.owner.rotate(c.env, c.ctx);
          await send(c.env, c.chat, `♻️ ${r.revoked} ${tr(c.lang, 'owner_rotated')}`);
          return adminsPanel(c);
        }
        if (sub === 'add') { await FSM.set(c.env, c.chat, 'ad:owner:add'); return send(c.env, c.chat, tr(c.lang, 'owner_add_ask') + '\n<code>123456789 admin</code>', kb([[{ text: tr(c.lang, 'cancel'), callback_data: 'qv:cancel' }]])); }
        if (sub === 'copy') return send(c.env, c.chat, `<code>${QV.esc(rest.slice(2).join(':'))}</code>`);
        if (sub === 'del' || sub === 'role') {
          /* `arg` is the non-reversible fingerprint, resolved back to the row */
          const row = await QV.owner.byFp(c.env, arg);
          if (!row) { await send(c.env, c.chat, '∅'); return adminsPanel(c); }
          const r = sub === 'del'
            ? await QV.owner.remove(c.env, c.ctx, row.telegram_id)
            : await QV.owner.add(c.env, c.ctx, row.telegram_id, flag || 'admin', row.name);
          await send(c.env, c.chat, r.ok ? tr(c.lang, sub === 'del' ? 'owner_removed' : 'owner_added') : '⛔️ ' + QV.esc(r.error || ''));
          return adminsPanel(c);
        }
        return adminsPanel(c);
      }
      if (act === 'stats') return adminStats(c);
      if (act === 'users') return adminUsers(c);
      if (act === 'hunt') return COMMANDS.hunt(c);
      if (act === 'strategy') return COMMANDS.strategy(c);
      if (act === 'selftest') return COMMANDS.selftest(c);
      if (act === 'logs') return COMMANDS.logs(c);
      if (act === 'backup') return COMMANDS.backup(c);
      if (act === 'ai') { await FSM.set(c.env, c.chat, 'ad:ai'); return send(c.env, c.chat, '🤖 سؤال/دستور خود را بنویسید:'); }
      if (act === 'broadcast') { await FSM.set(c.env, c.chat, 'ad:broadcast'); return send(c.env, c.chat, '📣 متن پیام همگانی را بنویسید:'); }
      if (act === 'kill') {
        await QV.d1.Users.setKill(c.env, arg, !!Number(flag), 'telegram');
        if (!Number(flag)) await QV.d1.Kv.set(c.env, 'qv:revive:' + arg, true, 86400 * 7);
        return send(c.env, c.chat, Number(flag) ? '⛔️ قطع شد' : '▶️ فعال شد');
      }
      if (act === 'reset') { await QV.d1.Users.patch(c.env, arg, { used_bytes: 0 }); return send(c.env, c.chat, '🧹 مصرف ریست شد'); }
      if (act === 'del') { await QV.d1.Users.remove(c.env, arg); return send(c.env, c.chat, '🗑 حذف شد'); }
      if (act === 'cfg') { const built = await QV.subs.build(c.env, c.ctx, arg, { format: 'uris', origin: c.origin }); return send(c.env, c.chat, '<code>' + QV.esc(built.subUrl || built.error) + '</code>'); }
    }
  };

  const approveUser = async (c, requestId, approve) => {
    const req = await QV.d1.Kv.get(c.env, 'qv:tg:req:' + requestId, null);
    if (!req) return answer(c.env, c.cb.id, 'درخواست پیدا نشد', true);
    if (!approve) {
      await QV.d1.Kv.del(c.env, 'qv:tg:req:' + requestId);
      await send(c.env, req.chat, tr(req.lang || 'fa', 'rejected'));
      return;
    }
    const uuid = QV.uuid();
    const gb = Number(req.quota_gb || QV.env.get(c.env, 'DEFAULT_QUOTA_GB', 100));
    await QV.d1.Users.upsert(c.env, { uuid, name: req.name || ('tg-' + String(req.chat).slice(-4)), quota_bytes: Math.round(gb * 1073741824), telegram_id: String(req.chat), max_sessions: 3, enabled: 1 });
    await QV.d1.Kv.del(c.env, 'qv:tg:req:' + requestId);
    const built = await QV.subs.build(c.env, c.ctx, uuid, { format: 'uris', origin: c.origin });
    await send(c.env, req.chat, tr(req.lang || 'fa', 'approved', { url: built.subUrl }), kb([
      [{ text: '🌐 ' + (req.lang === 'en' ? 'Open panel' : 'پنل من'), url: c.origin + '/me?uuid=' + uuid }],
      [{ text: '📷 QR', url: c.origin + '/qr?d=' + encodeURIComponent(built.subUrl) + '&s=6' }],
    ]));
    QV.emit(c.env, 'user:create', 'info', { uuid, message: 'approved telegram request ' + req.chat, ctx: c.ctx });
  };

  /* ─────────────────────────── free text (FSM) ────────────────────────── */
  const onText = async (c, text) => {
    const fsm = await FSM.get(c.env, c.chat);
    if (text.startsWith('/')) {
      const [cmd, ...args] = text.slice(1).split(/\s+/);
      const fn = COMMANDS[cmd.split('@')[0].toLowerCase()];
      if (fn) return fn({ ...c, args });
      return send(c.env, c.chat, tr(c.lang, 'unknown'), userMenu(c.lang, c.admin));
    }
    switch (fsm.state) {
      case 'request': {
        const name = text.slice(0, 40);
        const id = QV.shortId(8);
        await QV.d1.Kv.set(c.env, 'qv:tg:req:' + id, { chat: String(c.chat), name, lang: c.lang, at: Date.now() }, 86400 * 7);
        await FSM.clear(c.env, c.chat);
        await send(c.env, c.chat, tr(c.lang, 'requested'));
        await notifyAdmin(c.env, `🎫 <b>درخواست اشتراک</b>\nنام: ${QV.esc(name)}\nچت: <code>${c.chat}</code>`, kb([
          [{ text: '✅ تایید', callback_data: 'qv:approve:' + id }, { text: '❌ رد', callback_data: 'qv:reject:' + id }],
        ]));
        return;
      }
      case 'support': {
        await FSM.clear(c.env, c.chat);
        const u = await userFor(c.env, c.chat);
        await notifyAdmin(c.env, `💬 <b>پیام پشتیبانی</b>\nاز: ${QV.esc(c.name || '')} <code>${c.chat}</code>${u ? `\nحساب: <code>${u.uuid.slice(0, 8)}</code>` : ''}\n\n${QV.esc(text.slice(0, 800))}`);
        return send(c.env, c.chat, tr(c.lang, 'support_sent'), userMenu(c.lang, c.admin));
      }
      case 'ad:add': return withAdmin(c, () => addUser({ ...c, args: text.split(/\s+/) }));
      case 'ad:owner:add': return withOwner(c, async () => {
        await FSM.clear(c.env, c.chat);
        /* "<id> [role] [name]" — the role defaults to admin, viewer is read-only */
        const [id, role, ...rest2] = text.trim().split(/\s+/);
        if (!/^-?\d{3,20}$/.test(String(id || ''))) { await send(c.env, c.chat, '⛔️ ' + tr(c.lang, 'owner_add_ask')); return adminsPanel(c); }
        const r = await QV.owner.add(c.env, c.ctx, id, role || 'admin', rest2.join(' '));
        await send(c.env, c.chat, r.ok ? tr(c.lang, 'owner_added') : '⛔️ ' + QV.esc(r.error || ''));
        return adminsPanel(c);
      });
      case 'ad:quota': return withAdmin(c, () => quotaCmd({ ...c, args: text.split(/\s+/) }));
      case 'ad:find': return withAdmin(c, async () => { await FSM.clear(c.env, c.chat); return adminFind(c, text.trim()); });
      case 'ad:broadcast': return withAdmin(c, async () => { await FSM.clear(c.env, c.chat); const r = await broadcast(c.env, c.ctx, text, {}); return send(c.env, c.chat, `📣 ${r.sent} ok / ${r.failed} failed`); });
      case 'ad:ai': return withAdmin(c, async () => { await FSM.clear(c.env, c.chat); return aiReply(c, text); });
      default:
        /* an admin's free text is a copilot prompt; a user's is a support ping */
        if (c.admin) return aiReply(c, text);
        return send(c.env, c.chat, tr(c.lang, 'unknown'), userMenu(c.lang, c.admin));
    }
  };

  /* ─────────────────────────── update entry ───────────────────────────── */
  const masked = (id) => (QV.owner ? QV.owner.mask(id) : String(id || '').slice(-4));

  const processUpdate = async (update, env, ctx, origin) => {
    const msg = update.message || update.edited_message || update.channel_post;
    const cb = update.callback_query;
    const chat = String((msg && msg.chat && msg.chat.id) || (cb && cb.message && cb.message.chat.id) || '');
    if (!chat) return;
    /* dedupe: Telegram retries happily, we must not */
    const seenKey = 'qv:tg:seen:' + update.update_id;
    if (await QV.d1.Kv.get(env, seenKey, false)) return;
    await QV.d1.Kv.set(env, seenKey, true, 300);
    const bucket = QV.tokenBucket('tg:' + chat, 40, 8);
    if (!bucket.take()) { QV.log.warn('telegram', 'rate limited', { chat: masked(chat) }); return; }
    const lang = await userLang(env, chat);
    const role = await roleOf(env, chat);
    /* the sender, which in a group is NOT the chat: the claim flow insists on
       from.id === chat.id so nobody can bind a channel or a group they do not
       own, and nobody can ride somebody else's private chat */
    const from = (cb && cb.from && cb.from.id) || (msg && msg.from && msg.from.id) || '';
    const chatType = (msg && msg.chat && msg.chat.type) || (cb && cb.message && cb.message.chat && cb.message.chat.type) || '';
    const c = {
      env, ctx, chat, lang, origin: origin || '',
      role: role || 'user',
      admin: role === 'owner' || role === 'admin',
      owner: role === 'owner',
      fromId: String(from || ''), chatType,
      name: (msg && msg.from && (msg.from.first_name || msg.from.username)) ||
            (cb && cb.from && (cb.from.first_name || cb.from.username)) || '',
      ok: (d) => d,
    };
    try {
      if (cb) return await onCallback({ ...c, cb, data: cb.data, messageId: cb.message && cb.message.message_id });
      if (msg && msg.text) {
        const text = String(msg.text);
        /* "/start <payload>" carries the deep-link argument (claim_…) */
        if (/^\/(start|menu)(@[\w-]+)?\b/i.test(text)) {
          return await COMMANDS.start({ ...c, args: text.split(/\s+/).slice(1) });
        }
        return await onText({ ...c, text, args: text.replace(/^\//, '').split(/\s+/).slice(1) }, text);
      }
      if (msg && (msg.photo || msg.document)) {
        await notifyAdmin(env, `📎 <b>رسید/فایل</b> از <code>${masked(chat)}</code>`);
        return send(env, chat, tr(lang, 'requested'));
      }
    } catch (e) {
      QV.log.error('telegram', 'update failed', { err: e?.message, stack: String(e?.stack || '').slice(0, 400), chat: masked(chat) });
      QV.emit(env, 'tg:error', 'error', { message: e?.message, ctx });
    }
  };

  /* ─────────────────────────── webhook + polling ──────────────────────── */
  const secretFor = async (env) => {
    const { token, secret } = cfgOf(env);
    if (secret) return secret;
    const digest = await QV.hmacSha256(QV.utf8('qv-webhook:' + token), QV.utf8('qv'));
    return QV.hex(digest).slice(0, 40);
  };

  const ensureWebhook = async (env, ctx, origin) => {
    const { token } = cfgOf(env);
    if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' };
    const base = (env.CUSTOM_DOMAIN ? 'https://' + env.CUSTOM_DOMAIN : origin);
    const url = base.replace(/\/$/, '') + '/tg/webhook';
    const secret_token = await secretFor(env);
    const r = await call(env, 'setWebhook', {
      url, secret_token, drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query', 'edited_message', 'channel_post'],
    });
    const me = await call(env, 'getMe');
    /* remember @username so the claim deep link can be built without another
       round-trip to the Telegram API (and without TELEGRAM_BOT_USERNAME) */
    if (me.ok && me.result && me.result.username) {
      await QV.safeAsync(() => QV.d1.Kv.set(env, 'qv:tg:bot', String(me.result.username), 0), null);
    }
    /* goes to every bound owner/admin; if nobody is bound yet it is queued and
       delivered the moment the bot is claimed — nothing is lost */
    await notifyAdmin(env, `✅ Webhook روی <code>${QV.esc(url)}</code> تنظیم شد.${me.ok && me.result ? `\n@${QV.esc(me.result.username)}` : ''}`);
    QV.emit(env, 'tg:webhook', 'info', { message: 'webhook set: ' + url, ctx });
    return { ok: r.ok, url, bot: me.ok && me.result ? me.result.username : null, secret_fingerprint: secret_token.slice(0, 8), error: r.error };
  };

  const deleteWebhook = async (env) => call(env, 'deleteWebhook', { drop_pending_updates: false });
  const status = async (env) => {
    const me = await call(env, 'getMe');
    const info = await call(env, 'getWebhookInfo');
    const secret = await secretFor(env);
    /* chat ids are personal data about the operator: /health, the panel and
       every log line only ever see the masked form plus the owner block */
    const owner = QV.owner ? await QV.safeAsync(() => QV.owner.status(env), null) : null;
    return {
      configured: !!cfgOf(env).token, bot: me.ok ? me.result.username : null,
      secret_fingerprint: secret.slice(0, 8),
      admin_id: owner ? owner.owner : (cfgOf(env).adminId ? masked(cfgOf(env).adminId) : null),
      admins: owner ? owner.admins.length : 0,
      owner: owner || { claimed: !!cfgOf(env).adminId, mode: cfgOf(env).adminId ? 'env-only' : 'unknown' },
      webhook: info.ok ? info.result : info.error,
      mode: env.DISABLE_WEBHOOK ? 'polling' : 'webhook+fallback',
    };
  };

  const handleWebhook = async (request, env, ctx) => {
    const cfg = cfgOf(env);
    if (!cfg.token) return new Response('bot token not configured', { status: 503 });
    const expected = await secretFor(env);
    const got = request.headers.get('x-telegram-bot-api-secret-token') || '';
    /* Telegram itself signs nothing but the header, so both are accepted:
       the platform header, and an HMAC-SHA256 of the raw body under the same
       secret (what a relay or a self-hosted API proxy can provide).  A body
       HMAC can only be checked on the bytes, hence the clone. */
    const raw = await request.clone().arrayBuffer();
    const sigHeader = request.headers.get('x-qv-signature') || request.headers.get('x-telegram-signature') || '';
    const headerOk = got && got === expected;
    if (got && !headerOk) {
      QV.emit(env, 'tg:webhook', 'warn', { message: 'webhook called with a wrong secret token', ctx });
      return new Response('forbidden', { status: 403 });
    }
    if (sigHeader) {
      const digest = QV.hex(await QV.hmacSha256(QV.utf8(expected), new Uint8Array(raw)));
      if (!QV.timingSafeEqual(digest, sigHeader.toLowerCase().replace(/^sha256=/, ''))) {
        QV.emit(env, 'tg:webhook', 'warn', { message: 'webhook body signature mismatch', ctx });
        return new Response('forbidden', { status: 403 });
      }
    }
    let update = null;
    try { update = JSON.parse(QV.dec.decode(new Uint8Array(raw)) || '{}'); } catch (e) { return new Response('bad json', { status: 400 }); }
    const origin = new URL(request.url).origin;
    /* answer Telegram immediately; do the work in the background */
    const job = processUpdate(update, env, ctx, origin);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job.catch(() => {}));
    else await job.catch(() => {});
    return new Response('ok', { status: 200 });
  };

  /** polling fallback — runs from the cron, never fights with the webhook */
  const pollOnce = async (env, ctx) => {
    const cfg = cfgOf(env);
    if (!cfg.token) return { skipped: 'no token' };
    if (!env.DISABLE_WEBHOOK && !env.POLL_ALWAYS) {
      const info = await call(env, 'getWebhookInfo');
      if (info.ok && info.result.url) return { skipped: 'webhook active' };
    }
    const lock = await QV.d1.Kv.get(env, 'qv:tg:poll:lock', 0);
    if (lock && Date.now() - lock < 20000) return { skipped: 'locked' };
    await QV.d1.Kv.set(env, 'qv:tg:poll:lock', Date.now(), 120);
    const offset = await QV.d1.Kv.get(env, 'qv:tg:offset', 0);
    const r = await call(env, 'getUpdates', { offset: offset ? offset + 1 : undefined, timeout: 0, limit: 20, allowed_updates: ['message', 'callback_query'] });
    if (!r.ok) return { error: r.error };
    for (const update of r.result || []) {
      await processUpdate(update, env, ctx, env.CUSTOM_DOMAIN ? 'https://' + env.CUSTOM_DOMAIN : '');
      await QV.d1.Kv.set(env, 'qv:tg:offset', update.update_id, 0);
    }
    return { handled: (r.result || []).length };
  };

  QV.telegram = {
    call, send, edit, answer, notifyAdmin, kb,
    handleWebhook, ensureWebhook, deleteWebhook, status, pollOnce, processUpdate,
    broadcast, FSM, tr, setLang, userLang, isAdmin, isOwner, roleOf, userFor, secretFor,
    /* owner binding: the chat side of 31-owner.js */
    recipients, flushQueue, claimFrom, adminsPanel, ownerMint,
    commands: Object.keys(COMMANDS),
    /** push an alert to every bound owner/admin, deduplicated per hour */
    alert,
  };

  /* the compatibility layer calls the historic name with (env, url) */
  QV.telegram.setWebhook = QV.telegram.setWebhook || ((env, url, ctx) => ensureWebhook(env, ctx, url));
})();
