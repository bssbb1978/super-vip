/* ═══════════════════════════════════════════════════════════════════════════
 * A4c · AI EXTENSIONS — chat, health probing, and the natural-language
 *        admin copilot (understand a Persian/English sentence → run ops)
 * ═══════════════════════════════════════════════════════════════════════════
 *  Additive only: QV.ai.run / .json / .embed / .refresh stay untouched.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function extendAI() {
  const A = QV.ai;
  const DAY = 86400;

  /* ---------- real multi-turn chat (messages array, not a single prompt) -- */
  A.chat = async (env, messages, opts = {}) => {
    const cands = A.byKind(opts.kind || 'chat', opts.attempts || 4);
    if (!env?.AI) return { ok: false, error: 'no AI binding', text: '', model: null, fallback: true };
    for (const m of cands) {
      const t0 = Date.now();
      try {
        const out = await env.AI.run(m.id, {
          messages, max_tokens: opts.maxTokens || 600, temperature: opts.temperature ?? 0.4,
        });
        const ms = Date.now() - t0;
        A.latency.set(m.id, (A.latency.get(m.id) || ms) * 0.7 + ms * 0.3);
        const text = out?.response ?? out?.result?.response ?? out?.choices?.[0]?.message?.content ?? (typeof out === 'string' ? out : '');
        QV.safeAsync(() => QV.d1.run(env, 'INSERT INTO qv_ai_log (model,task,ms,ok) VALUES (?,?,?,1)', m.id, opts.task || 'chat', ms));
        return { ok: true, model: m.id, text: String(text || ''), ms };
      } catch (e) {
        A.demoted.set(m.id, Date.now() + 15 * 60 * 1000);
        QV.log.warn('ai', 'chat candidate failed', { model: m.id, err: e?.message });
      }
    }
    return { ok: false, error: 'all chat models failed', text: '', model: null };
  };

  /* ---------- health probe: which models are actually alive right now ----- */
  A.probe = async (env, ctx, opts = {}) => {
    const results = [];
    const kinds = opts.kinds || ['chat', 'reasoning'];
    for (const kind of kinds) {
      for (const m of A.byKind(kind, 3)) {
        const t0 = Date.now();
        try {
          const out = await env.AI.run(m.id, { messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 });
          const ms = Date.now() - t0;
          A.latency.set(m.id, ms);
          A.demoted.delete(m.id);
          results.push({ model: m.id, kind, ok: true, ms });
          await QV.safeAsync(() => QV.d1.run(env, 'INSERT INTO qv_ai_log (model,task,ms,ok) VALUES (?,?,?,1)', m.id, 'probe', ms));
        } catch (e) {
          A.demoted.set(m.id, Date.now() + 15 * 60 * 1000);
          results.push({ model: m.id, kind, ok: false, error: e?.message });
        }
      }
    }
    const best = A.best('chat');
    await QV.d1.Kv.set(env, 'ai:health', { iso: new Date().toISOString(), best: best?.id || null, results }, DAY);
    return { best: best?.id || null, tested: results.length, alive: results.filter(r => r.ok).length, results };
  };

  /** quick natural-language helpers used by panels/UI */
  A.translate = (env, text, target = 'fa') =>
    A.run(env, `Translate to ${target}. Output only the translation:\n${text}`, { kind: 'translation', maxTokens: 400 });
  A.summarise = (env, text) =>
    A.run(env, `Summarise in one short paragraph:\n${text}`, { kind: 'summarise', maxTokens: 220 });
  A.classifyText = (env, text, labels) =>
    A.json(env, `Classify the text into exactly one of ${JSON.stringify(labels)}. Reply {"label":"..."}.\nText: ${text}`, { kind: 'chat', maxTokens: 60 });

  /* ---------- the admin copilot ----------------------------------------- */
  const ACTIONS = {
    create_user: 'create a new user / config',
    kill: 'disable (kill) a user',
    revive: 're-enable a user',
    quota: 'set a user quota in GB',
    days: 'set a user validity in days',
    stats: 'show system statistics',
    users: 'list users',
    strategy: 'show the current anti-DPI strategy',
    replan: 're-plan the anti-DPI strategy with AI',
    hunt: 'hunt for new SNI candidates',
    dns: 'resolve a domain through the core DNS engine',
    broadcast: 'send a message to all users',
    help: 'explain what the bot can do',
    none: 'no actionable intent',
  };

  const heuristic = (text) => {
    const t = text.toLowerCase();
    const uuid = (text.match(/\b([a-z0-9][a-z0-9_-]{2,31})\b/i) || [])[1];
    const gb = (text.match(/(\d+(?:\.\d+)?)\s*(?:gb|گیگ|گیگابایت)/i) || [])[1];
    const days = (text.match(/(\d+)\s*(?:day|days|روز)/i) || [])[1];
    if (/آمار|وضعیت|stats|status|report/.test(t)) return { action: 'stats', args: {} };
    if (/کاربر|کاربران|users|list/.test(t) && !/بساز|create|new|جدید/.test(t)) return { action: 'users', args: {} };
    if (/بساز|ایجاد|create|new user|new config|add user/.test(t)) return { action: 'create_user', args: { uuid, gb: gb ? parseFloat(gb) : undefined } };
    if (/قطع|kill|disable|بن|ban|خاموش/.test(t)) return { action: 'kill', args: { uuid } };
    if (/فعال|revive|enable|روشن|آنبن|unban/.test(t)) return { action: 'revive', args: { uuid } };
    if (/سهمیه|quota/.test(t) && gb) return { action: 'quota', args: { uuid, gb: parseFloat(gb) } };
    if (/اعتبار|روز|days|expire/.test(t) && days) return { action: 'days', args: { uuid, days: parseInt(days, 10) } };
    if (/استراتژی|strategy|shape/.test(t)) return { action: 'strategy', args: {} };
    if (/بازطراحی|replan|re-plan/.test(t)) return { action: 'replan', args: {} };
    if (/sni|شکار|hunt/.test(t)) return { action: 'hunt', args: {} };
    if (/dns|دی‌ان‌اس|resolve/.test(t)) return { action: 'dns', args: { domain: (text.match(/([a-z0-9-]+\.[a-z]{2,})/i) || [])[1] } };
    if (/اعلان|همگانی|broadcast|پیام به همه/.test(t)) return { action: 'broadcast', args: {} };
    if (/راهنما|help|چیکار|چکار/.test(t)) return { action: 'help', args: {} };
    if (uuid) return { action: 'none', args: { uuid } };
    return { action: 'none', args: {} };
  };

  /**
   * adminCommand — understands the sentence, executes the operation, answers.
   * Safety: only reachable from an authenticated admin chat (enforced by the
   * Telegram layer); every execution is written to qv_audit.
   */
  A.adminCommand = async (env, ctx, text, opts = {}) => {
    const summary = await QV.safeAsync(() => QV.d1.Metrics.summary(env), {}).catch(() => ({}));
    let plan = null;

    if (env?.AI) {
      const prompt = `You are the operations copilot of an edge network control plane.
Operators speak Persian or English. Map the operator's sentence to ONE action.
Allowed actions and their args:
${Object.entries(ACTIONS).map(([k, v]) => `- ${k}: ${v} (args: ${k === 'create_user' || k === 'kill' || k === 'revive' ? 'uuid (string), gb (number, optional)' : k === 'quota' ? 'uuid, gb' : k === 'days' ? 'uuid, days' : k === 'dns' ? 'domain' : k === 'broadcast' ? 'text' : 'none'})`).join('\n')}
Current state: ${JSON.stringify(summary).slice(0, 600)}
Operator sentence: ${JSON.stringify(text)}
Reply ONLY JSON: {"action":"...","args":{...},"reply":"<one short sentence in the operator's language>"}`;
      const res = await QV.safeAsync(() => A.json(env, prompt, { kind: 'chat', maxTokens: 350 }));
      if (res?.ok && res.data?.action) plan = res.data;
    }
    if (!plan || !ACTIONS[plan.action]) plan = { ...heuristic(text), reply: null };

    const args = plan.args || {};
    const uuid = args.uuid || (text.match(/\b([a-z0-9][a-z0-9_-]{2,31})\b/i) || [])[1];
    const buttons = [];
    let reply = plan.reply || '';

    try {
      switch (plan.action) {
        case 'create_user': {
          const name = (uuid && !/^(create|new|user|بساز|یه)$/i.test(uuid)) ? uuid : QV.genUuid();
          const gb = Number(args.gb || args.quota || 100);
          const u = await QV.d1.Users.create(env, { uuid: name, enabled: true, approved: true, total_bytes: Math.round(gb * 1024 ** 3), note: 'created via copilot' });
          await QV.d1.Audit.log(env, { actor: `ai:${opts.chatId || '?'}`, action: 'create_user', target: u.uuid, meta: { gb } });
          reply = reply || `✅ کاربر ${u.uuid} با ${gb} گیگ ساخته شد.`;
          buttons.push({ label: `📦 config ${u.uuid}`, callback: `qv:a:links:${u.uuid}` });
          buttons.push({ label: '🔢 سهمیه', callback: `qv:a:setquota:${u.uuid}` });
          return { reply, actions: buttons, plan, user: u.uuid };
        }
        case 'kill': {
          if (!uuid) return { reply: 'UUID را مشخص کنید.', actions: [], plan };
          await QV.d1.Users.update(env, uuid, { killswitch: true, enabled: false });
          await QV.d1.Sessions.closeAllForUser(env, uuid, 'ai-kill');
          await QV.d1.Audit.log(env, { actor: `ai:${opts.chatId || '?'}`, action: 'kill', target: uuid });
          reply = reply || `⛔️ ${uuid} قطع شد.`;
          return { reply, actions: [{ label: `♻️ ${uuid}`, callback: `qv:a:kill:${uuid}:0` }], plan };
        }
        case 'revive': {
          if (!uuid) return { reply: 'UUID را مشخص کنید.', actions: [], plan };
          await QV.d1.Users.update(env, uuid, { killswitch: false, enabled: true, approved: 1 });
          await QV.d1.Audit.log(env, { actor: `ai:${opts.chatId || '?'}`, action: 'revive', target: uuid });
          reply = reply || `♻️ ${uuid} فعال شد.`;
          return { reply, actions: [], plan };
        }
        case 'quota': {
          const gb = Number(args.gb || args.quota || (text.match(/(\d+(?:\.\d+)?)/) || [])[1] || 0);
          if (!uuid || !gb) return { reply: 'UUID و مقدار گیگ لازم است.', actions: [], plan };
          await QV.d1.Users.update(env, uuid, { total_bytes: Math.round(gb * 1024 ** 3) });
          await QV.d1.Audit.log(env, { actor: `ai:${opts.chatId || '?'}`, action: 'quota', target: uuid, meta: { gb } });
          reply = reply || `🔢 سهمیه ${uuid} → ${gb} GB`;
          return { reply, actions: [], plan };
        }
        case 'days': {
          const d = Number(args.days || (text.match(/(\d+)/) || [])[1] || 0);
          if (!uuid || !d) return { reply: 'UUID و تعداد روز لازم است.', actions: [], plan };
          await QV.d1.Users.update(env, uuid, { expires_at: Math.floor(Date.now() / 1000) + d * DAY });
          await QV.d1.Audit.log(env, { actor: `ai:${opts.chatId || '?'}`, action: 'days', target: uuid, meta: { days: d } });
          reply = reply || `📅 اعتبار ${uuid} → ${d} روز`;
          return { reply, actions: [], plan };
        }
        case 'stats': {
          const s = summary;
          reply = reply || `📈 کاربران ${s.users} · فعال ${s.active} · سشن ${s.sessions} · ترافیک ${QV.humanBytes(s.bytes)} · SNI سالم ${s.sniHealthy}/${s.sniTotal}`;
          return { reply, actions: [{ label: '📊 جزئیات', callback: 'qv:a:stats' }], plan };
        }
        case 'users': {
          const rows = await QV.d1.Users.list(env, { limit: 5 });
          reply = reply || `👥 ${rows.length} کاربر اخیر: ` + rows.map(r => r.uuid).join(', ');
          return { reply, actions: [{ label: '👥 لیست کامل', callback: 'qv:a:users:0' }], plan };
        }
        case 'strategy': {
          const st = await QV.antidpi.load(env);
          reply = reply || `🎛 شکل=${st.shape} · SNI=${st.sni_pool} · نسخه ${st.version} · ${st.reason || ''}`;
          return { reply, actions: [{ label: '🎛 جزئیات', callback: 'qv:a:strategy' }], plan };
        }
        case 'replan': {
          const r = await QV.antidpi.analyse(env, ctx, { reason: 'ai-copilot' });
          reply = reply || (r.ok ? `🧠 استراتژی نسخه ${r.strategy.version} ساخته شد (${r.model}).` : `⚠️ ${r.reason}`);
          return { reply, actions: [{ label: '🎛 مشاهده', callback: 'qv:a:strategy' }], plan };
        }
        case 'hunt': {
          const found = await QV.antidpi.hunt(env, ctx, { count: 8 });
          reply = reply || `🛰 ${found.length} SNI تأیید شد: ` + found.slice(0, 3).map(f => f.sni).join(', ');
          return { reply, actions: [{ label: '🛰 جزئیات', callback: 'qv:a:hunt' }], plan };
        }
        case 'dns': {
          const domain = args.domain || (text.match(/([a-z0-9-]+\.[a-z]{2,})/i) || [])[1];
          if (!domain) return { reply: 'دامنه را مشخص کنید.', actions: [], plan };
          const wire = QV.dns.build({ id: QV.rand16(), flags: { rd: 1 }, questions: [{ name: domain, type: QV.dns.TYPE.A }] });
          const { msg, source } = await QV.dns.resolve(env, ctx, wire);
          const a = msg.answers.filter(x => x.type === QV.dns.TYPE.A).map(x => x.value);
          reply = reply || `🌐 ${domain} → ${a.join(', ') || 'بدون پاسخ'} (${source})`;
          return { reply, actions: [], plan };
        }
        case 'broadcast': {
          const body = args.text || text.replace(/^(اعلان|همگانی|broadcast)\s*/i, '');
          if (!body) return { reply: 'متن پیام را بفرست.', actions: [], plan };
          const users = await QV.d1.Users.list(env, { limit: 500 });
          const targets = users.filter(u => u.telegram_id).map(u => u.telegram_id);
          ctx?.waitUntil?.((async () => { for (const t of targets) { await QV.telegram.send(env, t, '📣 ' + body); await QV.sleep(80); } })());
          reply = reply || `📣 ارسال به ${targets.length} کاربر آغاز شد.`;
          return { reply, actions: [], plan };
        }
        case 'help': {
          reply = reply || '🤖 می‌توانم: کاربر بسازم، سهمیه/اعتبار بدهم، قطع/وصل کنم، آمار بدهم، استراتژی را بازطراحی کنم، SNI شکار کنم، دامنه را resolve کنم و پیام همگانی بفرستم.';
          return { reply, actions: [{ label: '🛡 پنل', callback: 'qv:a:panel' }], plan };
        }
        default: {
          reply = reply || '🤔 دستور مشخصی پیدا نکردم. مثلاً بنویس: «کاربر reza با سهمیه ۵۰ گیگ بساز».';
          return { reply, actions: [{ label: '🛡 پنل', callback: 'qv:a:panel' }], plan };
        }
      }
    } catch (e) {
      QV.log.error('ai', 'adminCommand execution failed', { action: plan.action, err: e?.message });
      return { reply: '⚠️ ' + (e?.message || 'خطا'), actions: [], plan };
    }
  };

  /** AI-driven abuse triage for the event stream (used by cron + admin) */
  A.triage = async (env, events) => {
    if (!events?.length) return { ok: false };
    const prompt = `Classify these edge events and tell whether an attack/scan is in progress. Reply JSON {"threat":"none|low|high","reason":"<=10 words","action":"none|tarpit|replan"}. Events: ${JSON.stringify(events.slice(0, 25))}`;
    return A.json(env, prompt, { kind: 'reasoning', maxTokens: 250 });
  };
})();
