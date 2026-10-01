/* ═══════════════════════════════════════════════════════════════════════════
 * A4c · DOMESTIC AI — the node thinks on its own, with no binding at all
 * ═══════════════════════════════════════════════════════════════════════════
 *  Workers AI is optional.  When the binding exists the strongest model is
 *  used; when it does not — or when the account's AI quota is exhausted, or
 *  the operator runs on Pages without AI — this engine still answers:
 *
 *   · it turns Persian/English operator sentences into structured actions
 *     (create/limit/cut a user, re-plan the strategy, hunt SNI, scan IPs …)
 *   · it scores traffic, SNI health and quota risk with plain arithmetic
 *     (EWMA + heuristics — fully deterministic, testable, offline)
 *   · it writes the same JSON contract the remote copilot writes, so the bot,
 *     the API and the panels do not care which brain answered
 * ═══════════════════════════════════════════════════════════════════════════ */
(function localAI() {
  const NUM = /(\d+(?:[.,]\d+)?)/;
  const num = (s, dflt = 0) => {
    const m = String(s).match(NUM);
    return m ? Number(m[1].replace(',', '.')) : dflt;
  };

  /* ── intent patterns: fa + en, tolerant of typos and mixed scripts ───── */
  const INTENTS = [
    { id: 'add_user', fa: /(کاربر|یوزر|یوزر جدید|اکانت)\s*(جدید|بساز|اضافه|ایجاد)|بساز\s*کاربر/, en: /(create|add|new|make)\s+(a\s+)?(user|account|config)/i, quota: /(\d+(?:[.,]\d+)?)\s*(gb|گیگ|gig|g)\b/i },
    { id: 'kill_user', fa: /(قطع|ببند|غیرفعال|خاموش)\s*(کن)?\s*(کاربر|کانفیگ)?/, en: /(cut|kill|disable|block|ban|revoke)\s+(the\s+)?(user|config|account)?/i },
    { id: 'revive_user', fa: /(فعال|وصل|روشن|برگردان)\s*(کن)?/, en: /(revive|enable|unblock|restore|unban)/i },
    { id: 'set_quota', fa: /(سهمیه|محدودیت|کوتا|حجم)/, en: /(quota|limit|cap)\b/i },
    { id: 'broadcast', fa: /(اطلاعیه|همگانی|پیام\s*به\s*همه|برودکست)/, en: /broadcast|announce|tell everyone/i },
    { id: 'replan', fa: /(استراتژی|مقاوم|ضد\s*دی\s*پی|ضدDPI|فیلترشکن|دور\s*بزن|بهینه)/, en: /(strategy|evade|anti[- ]?dpi|stealth|optimis|optimiz|resilien)/i },
    { id: 'hunt_sni', fa: /(اس\s*ان\s*آی|شکار\s*sni|اسنی)/, en: /(sni|hunt|find\s+domain)/i },
    { id: 'scan_ips', fa: /(آی\s*پی\s*تمیز|ایپی|آیپی|اسکن)/, en: /(clean\s*ip|ip\s*scan|scan\s*ip)/i },
    { id: 'stats', fa: /(وضعیت|آمار|گزارش|چطوره|چند تا)/, en: /(status|stats|report|how many|health)/i },
    { id: 'dns', fa: /(دی\s*ان\s*اس|dns|نات64|nat64|رزولور)/i, en: /(dns|nat64|resolver|doh)/i },
    { id: 'help', fa: /(کمک|راهنما|چیکار)/, en: /(help|what can you|guide)/i },
  ];

  const matchIntent = (text) => {
    const q = String(text || '');
    for (const i of INTENTS) if (i.fa.test(q) || i.en.test(q)) return i.id;
    return 'chat';
  };

  /** pull a name/label out of the sentence (latin or persian words) */
  const matchName = (text) => {
    const q = String(text || '');
    const quoted = q.match(/["“'«]([^"”'»]{2,32})["”'»]/);
    if (quoted) return quoted[1];
    const after = q.match(/(?:کاربر|برای|user|for|named|name)\s+([A-Za-z0-9_\-.@]{2,32})/);
    if (after) return after[1];
    const words = q.split(/[\s,;]+/).filter(w => /^[A-Za-z0-9_\-.@]{3,32}$/.test(w) &&
      !/^(create|add|new|make|user|account|config|quota|gb|gig|the|for|named|name|revive|kill|cut|disable|enable|block|ban|restore|status|stats|report|sni|hunt|scan|clean|dns|help|please)$/i.test(w));
    return words.length ? words[0] : null;
  };

  /* ── the deterministic brain ─────────────────────────────────────────── */
  const parse = (text) => {
    const intent = matchIntent(text);
    const q = {};
    if (intent === 'add_user') {
      q.action = 'add_user';
      q.name = matchName(text) || ('user-' + QV.shortId(4));
      const gb = String(text).match(/(\d+(?:[.,]\d+)?)\s*(gb|گیگ|gig|g|گیگابایت)\b/i);
      q.quota_gb = gb ? Number(gb[1].replace(',', '.')) : Number(QV.env.DEFAULTS.DEFAULT_QUOTA_GB);
    } else if (intent === 'kill_user' || intent === 'revive_user') {
      q.action = intent;
      q.match = matchName(text) || '';
    } else if (intent === 'set_quota') {
      q.action = 'set_quota';
      q.match = matchName(text) || '';
      q.quota_gb = num(text, 0);
    } else if (intent === 'hunt_sni') {
      q.action = 'hunt_sni';
      q.count = num(text, 5);
    } else if (intent === 'scan_ips') {
      q.action = 'scan_ips';
    } else if (intent === 'replan') {
      q.action = 'replan';
    } else if (intent === 'broadcast') {
      q.action = 'broadcast';
      q.text = String(text).replace(/^.*?(?:بگو|بنویس|broadcast|announce)[:：]?\s*/i, '').slice(0, 500);
    } else if (intent === 'stats') {
      q.action = 'report';
    }
    return q;
  };

  /** analytics the operator asks for most: a plain-language status report */
  const report = async (env, ctx) => {
    const s = await QV.safeAsync(() => QV.api.stats(env), null);
    if (!s) return 'وضعیت در دسترس نیست / status unavailable';
    const lines = [
      `QV ${s.version}`,
      `👥 ${s.users_enabled}/${s.users_total} فعال · ⛔️ ${s.users_cut} قطع`,
      `🔌 ${s.sessions_active} اتصال زنده`,
      `📈 ۲۴ ساعت: ${QV.humanBytes(s.bytes_24h)} · کل: ${QV.humanBytes(s.bytes_total)}`,
      `🎭 SNI ${s.sni_count} · 🌐 IP ${s.ip_count} · شیپ ${s.strategy && s.strategy.active_shape}`,
      `🛡 fragment: ${s.strategy && s.strategy.fragment ? s.strategy.fragment.mode + ' ' + s.strategy.fragment.size + 'B' : '—'}`,
      s.health ? `🧩 d1=${s.health.d1 ? '✔' : '✖'} kv=${s.health.kv ? '✔' : '✖'} ai=${s.health.ai ? '✔' : '✖'}` : '',
    ].filter(Boolean);
    void ctx;
    return lines.join('\n');
  };

  /** risk scoring: who is over quota, who is about to be (no AI needed) */
  const riskReport = async (env) => {
    const rows = await QV.safeAsync(() => QV.d1.all(env,
      `SELECT uuid, tag, used_bytes, total_bytes, expires_at, killswitch FROM qv_users WHERE enabled = 1`), []) || [];
    const now = Math.floor(Date.now() / 1000);
    const scored = rows.map(u => {
      const pct = u.total_bytes ? u.used_bytes / u.total_bytes : 0;
      const daysLeft = u.expires_at ? Math.round((u.expires_at - now) / 86400) : null;
      const risk = Math.min(100, Math.round(pct * 80 + (daysLeft !== null && daysLeft < 7 ? (7 - Math.max(0, daysLeft)) * 4 : 0) + (u.killswitch ? 20 : 0)));
      return { uuid: u.uuid, tag: u.tag, used: u.used_bytes, total: u.total_bytes, pct: Math.round(pct * 100), days_left: daysLeft, risk };
    }).sort((a, b) => b.risk - a.risk);
    return scored.slice(0, 10);
  };

  /** SNI suggestion without any model: local heuristic + the live pool */
  const suggestSni = async (env, asn, country) => {
    const pool = await QV.safeAsync(() => QV.d1.Sni.top(env, 12), []) || [];
    const domestic = (asn || '').startsWith('AS58') || (country || '').toUpperCase() === 'IR';
    const ranked = pool.map(p => ({
      sni: p.sni,
      score: Math.round((p.score || 0) + (domestic && /\.ir$/.test(p.sni) ? 12 : 0) + (p.latency_ms ? Math.max(0, 30 - p.latency_ms / 20) : 0)),
      latency_ms: p.latency_ms,
    })).sort((a, b) => b.score - a.score);
    return { pick: ranked[0] ? ranked[0].sni : null, ranked: ranked.slice(0, 5), note: domestic ? 'carrier is Iranian: domestic SNI is preferred' : 'international profile' };
  };

  /** the answer() contract mirrors the remote copilot: text or {action,…} */
  const answer = async (text, env, opts = {}) => {
    const intent = matchIntent(text);
    const wantsAction = opts.actions !== false;
    if (wantsAction && intent !== 'chat' && intent !== 'help') {
      const action = parse(text);
      if (action.action) return JSON.stringify(action);
    }
    const lang = /[\u0600-\u06FF]/.test(String(text)) ? 'fa' : 'en';
    if (intent === 'stats') return report(env, opts.ctx);
    if (intent === 'dns') {
      const s = await QV.dns.stats(env);
      return lang === 'fa'
        ? `🧭 DNS: ${s.cached} پاسخ کش‌شده، ${s.upstreams.length} upstream، NAT64: ${s.nat64.map(p => p.prefix).join(', ')}\nDoH: ${s.doh_endpoint} — پورت ۵۳ در Workers ممکن نیست، پس DoH و DNS-over-tunnel ارائه می‌شود.`
        : `🧭 DNS: ${s.cached} cached answers, ${s.upstreams.length} upstreams, NAT64: ${s.nat64.map(p => p.prefix).join(', ')}\nDoH: ${s.doh_endpoint} (UDP/53 cannot be bound in Workers; DoH + DNS-over-tunnel are served instead).`;
    }
    if (intent === 'help') {
      return lang === 'fa'
        ? 'می‌توانم: کاربر بسازم («کاربر جدید رضا ۵۰ گیگ»)، سهمیه بدهم، کانفیگ کسی را قطع/وصل کنم، استراتژی را بازتحلیل کنم، SNI شکار کنم، آی‌پی تمیز اسکن کنم، وضعیت و گزارش بدهم.'
        : 'I can create users ("create user reza 50 gb"), set quotas, cut/revive configs, re-plan the strategy, hunt SNI, scan clean IPs and report status.';
    }
    /* free chat: answer from live telemetry instead of inventing numbers */
    const snap = await QV.safeAsync(() => QV.api.stats(env), null);
    if (!snap) return lang === 'fa' ? 'آمار زنده در دسترس نیست.' : 'Live telemetry is unavailable right now.';
    if (/آی\s*پی|ip/i.test(text)) {
      const best = (await QV.safeAsync(() => QV.d1.Ip.top(env, 3), [])) || [];
      return (lang === 'fa' ? 'بهترین آی‌پی‌های تمیز:\n' : 'Best clean IPs:\n') +
        best.map((b, i) => `${i + 1}. ${b.ip} — ${b.latency_ms || '?'}ms`).join('\n');
    }
    if (/sni|اس\s*ان\s*آی/i.test(text)) {
      const s = await suggestSni(env, opts.asn, opts.country);
      return (lang === 'fa' ? 'پیشنهاد SNI: ' : 'SNI suggestion: ') + (s.pick || '—');
    }
    return (lang === 'fa'
      ? `وضعیت: ${snap.users_enabled} کاربر فعال، ${snap.sessions_active} اتصال، SNI ${snap.sni_count}، IP ${snap.ip_count}. چه کاری انجام بدهم؟`
      : `${snap.users_enabled} active users, ${snap.sessions_active} sessions, ${snap.sni_count} SNI, ${snap.ip_count} IPs. What should I do?`);
  };

  QV.localAI = {
    answer, parse, matchIntent, report, riskReport, suggestSni, intents: INTENTS.map(i => i.id),
    /** the fallback chain: remote model → local brain (never throws) */
    think: async (env, prompt, opts = {}) => {
      const det = QV.env.detect(env);
      if (det.ai && !opts.forceLocal) {
        const remote = await QV.safeAsync(() => QV.ai.chat(env, [
          { role: 'system', content: QV.ai.systemPrompt(env) },
          { role: 'user', content: String(prompt).slice(0, 2000) },
        ], { ctx: opts.ctx }), null);
        if (remote && typeof remote === 'string' && remote.trim()) return { via: 'workers-ai', text: remote };
      }
      return { via: 'local', text: await answer(prompt, env, opts) };
    },
  };

  /* keep every AI entry point working without a binding */
  const baseRun = QV.ai.run, baseChat = QV.ai.chat;
  QV.ai.run = async (env, prompt, opts = {}) => {
    const det = QV.env.detect(env || {});
    if (det.ai && !opts.forceLocal) {
      const out = await QV.safeAsync(() => baseRun(env, prompt, opts), null);
      const text = typeof out === 'string' ? out : (out && (out.text || out.response || out.result)) || null;
      if (text) return text;
    }
    return answer(prompt, env || {}, opts);
  };
  QV.ai.chat = async (env, messages, opts = {}) => {
    const det = QV.env.detect(env || {});
    const last = Array.isArray(messages) ? [...messages].reverse().find(m => m.role === 'user') : null;
    const prompt = (last && last.content) || String(messages || '');
    if (det.ai && !opts.forceLocal) {
      const out = await QV.safeAsync(() => baseChat(env, messages, opts), null);
      const text = typeof out === 'string' ? out : (out && (out.text || out.response || out.result)) || null;
      if (text) return text;
    }
    return answer(prompt, env || {}, opts);
  };
})();
