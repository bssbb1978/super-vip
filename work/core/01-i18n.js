/* ═══════════════════════════════════════════════════════════════════════════
 * A1a · i18n — every user-visible string in one table (fa / en / ar)
 * ═══════════════════════════════════════════════════════════════════════════
 *  Used by the Telegram bot, the panels, the API and the notification layer,
 *  so the whole product speaks the operator's language without duplication.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function i18n() {
  const STRINGS = {
    fa: {
      hello: 'سلام', menu: 'منو', cancel: 'انصراف', back: 'بازگشت', save: 'ذخیره', done: 'انجام شد',
      quota_cut: '⛔️ سهمیه شما تمام شد.\nمصرف: {used} از {total}\nکانفیگ‌های شما موقتاً قطع شد.',
      quota_warn: '⚠️ {pct}٪ از سهمیه شما مصرف شده.\n{used} از {total}',
      expired: '⛔️ اشتراک شما منقضی شد.',
      revived: '✅ اشتراک شما فعال شد.',
      user_created: '✅ کاربر {name} ساخته شد.', user_deleted: '🗑 کاربر {name} حذف شد.',
      limit_sessions: '⛔️ تعداد دستگاه‌های همزمان شما از حد مجاز ({max}) گذشت.',
      blocked_port: '⛔️ اتصال به پورت {port} مجاز نیست.',
      probe_blocked: '⛔️ درخواست مشکوک مسدود شد.',
      attack: '🚨 حمله/اسکن از {ip} شناسایی شد.',
      strategy_changed: '🛡 استراتژی به «{shape}» تغییر کرد.',
      sni_found: '🎭 {n} SNI جدید تأیید شد: {top}',
      ip_scanned: '🌐 {n} آی‌پی تمیز پیدا شد. بهترین: {best} ({ms}ms)',
      dns_poison: '🧪 پاسخ مسموم برای {domain} شناسایی و با {source} جایگزین شد.',
      backup_done: '💾 پشتیبان ساخته شد ({size}).',
      selftest: '🧪 خودآزمون: {summary}',
      welcome: 'خوش آمدید', unknown_cmd: 'دستور ناشناخته.', not_allowed: 'دسترسی ندارید.',
      panel: 'پنل', config: 'کانفیگ', usage: 'مصرف', help: 'راهنما',
    },
    en: {
      hello: 'Hello', menu: 'Menu', cancel: 'Cancel', back: 'Back', save: 'Save', done: 'Done',
      quota_cut: '⛔️ Quota exhausted.\nUsed: {used} of {total}\nYour configs have been cut.',
      quota_warn: '⚠️ {pct}% of the quota is used.\n{used} of {total}',
      expired: '⛔️ Your subscription expired.',
      revived: '✅ Your subscription is active again.',
      user_created: '✅ User {name} created.', user_deleted: '🗑 User {name} deleted.',
      limit_sessions: '⛔️ Too many simultaneous devices (limit {max}).',
      blocked_port: '⛔️ Connections to port {port} are not allowed.',
      probe_blocked: '⛔️ Suspicious request blocked.',
      attack: '🚨 Scan/attack detected from {ip}.',
      strategy_changed: '🛡 Strategy switched to “{shape}”.',
      sni_found: '🎭 {n} new SNI verified: {top}',
      ip_scanned: '🌐 {n} clean IPs found. Best: {best} ({ms}ms)',
      dns_poison: '🧪 Poisoned answer for {domain} detected and replaced via {source}.',
      backup_done: '💾 Backup created ({size}).',
      selftest: '🧪 Self-test: {summary}',
      welcome: 'Welcome', unknown_cmd: 'Unknown command.', not_allowed: 'Not allowed.',
      panel: 'Panel', config: 'Config', usage: 'Usage', help: 'Help',
    },
    ar: {
      hello: 'مرحبا', menu: 'القائمة', cancel: 'إلغاء', back: 'رجوع', save: 'حفظ', done: 'تم',
      quota_cut: '⛔️ انتهت الحصة.\nالمستخدم: {used} من {total}', quota_warn: '⚠️ استُهلك {pct}% من الحصة.',
      expired: '⛔️ انتهى اشتراكك.', revived: '✅ تم تنشيط اشتراكك.',
      user_created: '✅ تم إنشاء المستخدم {name}.', user_deleted: '🗑 تم حذف {name}.',
      limit_sessions: '⛔️ عدد الأجهزة تجاوز الحد ({max}).', blocked_port: '⛔️ المنفذ {port} غير مسموح.',
      probe_blocked: '⛔️ تم حظر طلب مشبوه.', attack: '🚨 هجوم/فحص من {ip}.',
      strategy_changed: '🛡 تم تغيير الاستراتيجية إلى «{shape}».', sni_found: '🎭 {n} SNI جديد: {top}',
      ip_scanned: '🌐 {n} عناوين نظيفة. الأفضل: {best}', dns_poison: '🧪 تم تصحيح رد مسموم لـ {domain}.',
      backup_done: '💾 تم إنشاء نسخة احتياطية ({size}).', selftest: '🧪 الاختبار: {summary}',
      welcome: 'مرحبا', unknown_cmd: 'أمر غير معروف.', not_allowed: 'غير مسموح.',
      panel: 'لوحة', config: 'الإعداد', usage: 'الاستخدام', help: 'مساعدة',
    },
  };

  const i18n = (key, vars, lang) => {
    const l = lang || i18n.lang;
    const table = STRINGS[l] || STRINGS.fa;
    const raw = table[key] ?? STRINGS.fa[key] ?? STRINGS.en[key] ?? key;
    return String(raw).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined ? vars[k] : ''));
  };
  i18n.lang = 'fa';
  i18n.setLang = (l) => { i18n.lang = STRINGS[l] ? l : 'fa'; return i18n.lang; };
  i18n.langs = Object.keys(STRINGS);
  i18n.table = STRINGS;
  i18n.has = (key, lang) => !!(STRINGS[lang || 'fa'] && STRINGS[lang || 'fa'][key]);

  QV.i18n = i18n;
})();
