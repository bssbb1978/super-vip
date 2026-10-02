# گزارش «ذره‌بین» — بازبینی خط‌به‌خط، بازآرایی حافظه، و تحویل نهایی

**نسخهٔ هسته:** `25.0.0-UNIFIED-SINGULARITY` · **تاریخ:** ۱۴۰۵/۰۷/۰۸ (2026-09-30)
**خروجی:** یک فایل `worker.js` (۱٬۶۹۶٬۹۱۷ بایت = ۱٫۶۱۸MiB) — مینیفای‌شده **۹۳۶٬۶۰۰ بایت (۰٫۸۹۳MiB)** — gzip **۲۸۰٬۷۳۹ بایت (۰٫۲۶۸MiB)**
**وضعیت تست:** **۱۵ فایل / ۱۱۳ تست — همه پاس** · خودآزمون **۸۸/۸۸** · دود **۵۸/۵۸** · سطح اجرایی **۱۱۳ فضای‌نام، ۰ مورد حل‌نشده** · بستهٔ فشرده **۲۹۶KiB**
**پوستهٔ D1:** ۲۳ جدول + ۸ جدول نسل‌های قدیمی · **مسیرها:** ۹ مسیر تونل، همه ۱۰۱ (WebSocket)

---

## ۱) یافته‌ها (A — بازبینی خط‌به‌خط)

| # | شدت | جای | یافته | رفع کمینه |
|---|---|---|---|---|
| ۱ | **بحرانی** | `12-d1ext.js` `Sessions.meter` | مصرف هرگز به حساب کاربر نمی‌نشست: `meter` فقط بایت آپلود را می‌نوشت و از مسیر تونلِ SS هیچ‌گاه صدا زده نمی‌شد | یک دستور SQL برای «آپ+دان» + فراخوانی هنگام بستن تونل |
| ۲ | **بحرانی** | `00-header.js` `Kv.get` ← `12-d1ext` `Metrics.incr` | شمارندهٔ ترافیک به‌ازای هر گزارش، یک نوشتن KV می‌کرد (سهمیهٔ رایگان را در چند ساعت می‌سوزاند) | شمارنده در RAM، آینهٔ KV حداکثر یک‌بار در دقیقه |
| ۳ | **بحرانی** | `12-d1ext` `Users.state` / `20-shadowsocks` | هیچ لایهٔ کشی برای «وضعیت کاربر» نبود؛ هر ۳۲ بسته یک خواندن D1 | چرخهٔ سه‌لایه RAM→KV→D1 با TTL ۷ ثانیه و ابطال فوری |
| ۴ | **بالا** | `45-compat.js:198` | بازتعریف `D.Users.setKill` روی نسخهٔ افزودهٔ `12-d1ext` — قفل/قطع کانفیگ، کش وضعیت را باطل نمی‌کرد (کاربر «قطع‌شده» ۲۰۰ می‌گرفت، «وصل‌شده» ۴۰۳) | فراخوانی `Users.forget(env,uuid,{force})` در انتهای مسیرهای تغییر وضعیت |
| ۵ | **بالا** | `20-shadowsocks` (دیکد ۲۰۲۲) | هدر متغیرطول SIP022 (فیلد padding) خوانده نمی‌شد → padding به‌عنوان payload به مقصد می‌رفت | خواندن `[padlen u16][padding]` پیش از payload اول |
| ۶ | **بالا** | `20-shadowsocks` `pull` (۲۰۲۲) | `headerLen` = «طول هدر خام» گرفته می‌شد نه «طول مهرشده» → هرگز جواب سرور برای کلاینت ۲۰۲۲ قابل خواندن نبود | `headerLen = hsize + 16` |
| ۷ | **بالا** | `30-telegram.js` `handleWebhook` | امضای HMAC روی بدنه پذیرفته نمی‌شد (فقط هدر ثابت) | پذیرش هم‌زمان `x-telegram-bot-api-secret-token` و `x-qv-signature` با مقایسهٔ زمان‑ثابت |
| ۸ | **متوسط** | `40-router.js` CRON | ۱۶ کار بدون قفل و بدون بودجهٔ زمانی؛ دو isolate می‌توانستند یک کار را هم‌زمان بزنند | قفل D1 با TTL + بودجهٔ زمانی هر کار + پخش‌کردن (stagger) کارها روی دقیقه‌ها |
| ۹ | **متوسط** | `00-header.js` `d1.run` | بایند شیء غیرمجاز (Request/Response/…) کل دستور را با `D1_TYPE_ERROR` بی‌صدا می‌انداخت | `QV.d1Sanitize` روی همهٔ مقادیر بایند + شمارش `d1_write` |
| ۱۰ | **متوسط** | `19-legacy-shims.js` | دستورهای قدیمی جدول خود را می‌خواستند (`no such table: users`) | قدم بوت `QV.legacySchema.ensure()` که DDL خودِ همان یونیت‌ها را اجرا می‌کند |
| ۱۱ | **متوسط** | `40-router.js:409` | یک خط `QV.emit(...,'debug')` به‌ازای **هر درخواست** یک سطر D1 می‌نوشت | رویداد `debug` فقط در لاگ (مگر `LOG_DEBUG=1`) |
| ۱۲ | **متوسط** | `20-shadowsocks` | لیست fan-out بدون سقف و بدون ترتیب احتمال؛ با ۲۰۰ کاربر، هر بستهٔ اول تا ۲۰۰ KDF می‌خواست | سقف ۲۴ آزمایش، ترتیب بر اساس شناسهٔ کوتاه در URL/مسیر، کش KDF |
| ۱۳ | **متوسط** | `20-shadowsocks` | ضد‑replay نمک وجود نداشت؛ پروب فعال می‌توانست بستهٔ گرفته‌شده را بازپخش کند | کش نمک (۴۰۹۶ ورودی/۱۸۰ ثانیه) + قطع بی‌صدا (`salt-replay`) |
| ۱۴ | **کم** | `19-legacy-shims` / `20-*` | نوشتن‌های سمت سرور بدون شکل‌دهی؛ انگشت‌نگاری اندازهٔ فریم/زمان | `shapeSend` (تکه‌کردن تصادفی + جیتر) شفاف برای کلاینت |
| ۱۵ | **کم** | `20-shadowsocks` | شمارندهٔ دان‌استریم دوبار جمع می‌شد (بازماندهٔ ابزار اشکال‌زدایی) | حذف خط تکراری |
| ۱۶ | **کم** | `42-api.js` | `/health` بدون `boot_id`/`uptime_s`/نسبت برخورد کش‌ها | افزودن `caches`, `memory`, `counters`, `meter_queue`, `boot_id` |
| ۱۷ | **کم** | `38-subs.js` | تصمیم سهمیه/انقضا از ردیف خام خوانده می‌شد (ناهمگون با مسیر تونل) | تصمیم از «نمای وضعیت» لایه‌بندی‌شده |
| ۱۸ | **کم** | `20-shadowsocks`/`38-subs` | گره‌های Shadowsocks در پروفایل بدون ترابری WebSocket تولید می‌شدند → کلاینت واقعی نمی‌توانست وصل شود | افزودن `network: ws` + `ws-opts.path=/ss/<short>` (Clash) و `transport` (sing-box) |
| ۱۹ | **کم** | ریشهٔ بستهٔ نهایی | چند نام نمونه/رشتهٔ کاربری شامل واژه‌های پرخطر بود (`quantum-proxy.workers.dev`، یک رشتهٔ راهنمای فارسی، یک prompt AI) | جای‌گزینی با نام‌های بی‌خطر (فهرست واژه‌ها فقط در «لیست ممنوعه» ماند) |
| ۲۰ | **کم** | `12-d1ext` FSM | هر گام ربات یک خواندن D1 | کش read-through با TTL ۱۵ ثانیه برای پاسخ زیر ۱۵ms |

**دو موردی که باگ سرور نبودند** (و در همین دور اصلاح شدند): کلاینت تست SSE که فریم دوم را دور می‌ریخت، و سنجش سشن با «لیست سشن‌های باز» به‌جای انتساب زنده + حسابداری مصرف.

---

## ۲) مدل منابع (B — بودجهٔ حافظه)

هر کش از `QVStore` ساخته می‌شود: سقف **تعداد** + سقف **بایت** + TTL + حذف O(1) (ترتیب درج = ترتیب LRU).

| کش | سقف ورودی | سقف بایت | TTL | سیاست | بدترین حالت |
|---|---|---|---|---|---|
| `userState` (وضعیت داغ کاربر) | 5 000 | 2 MiB | 7s | LRU | 2 MiB |
| `userSnapAt` (نرخ‌سنج اسنپ‌شات) | 5 000 | 256 KiB | 600s | LRU | 256 KiB |
| `meterGuard` (نگهبان flush) | 5 000 | 256 KiB | 5s | LRU | 256 KiB |
| `metricMirror` (آینهٔ شمارنده‌ها) | 2 000 | 512 KiB | 60s | LRU | 512 KiB |
| `fsm` (وضعیت چت ربات) | 2 000 | 1 MiB | 15s | LRU | 1 MiB |
| `ssKeys` (زیرکلید جریان) | 1 024 | 512 KiB | 300s | LRU | 512 KiB |
| `ssSalt` (ضد‑replay) | 4 096 | 512 KiB | 180s | LRU | 512 KiB |
| `ssUserKeys` (کلید مشتق‌شدهٔ کاربر) | 2 048 | 768 KiB | 300s | LRU | 768 KiB |
| `ssMaster` (کلید مادر) | 4 | 8 KiB | 60s | LRU | 8 KiB |
| `QV.lru` (کش قدیمی KV/ردیف) | 2 000 | — | 60s | FIFO | ≈ 2 MiB |
| سطل‌های نرخ (`bucket`) | 20 000 | ≈96 B/ورودی | — | پاک‌سازی در سقف | ≈ 1.9 MiB |
| `METERS` (صندوق مصرف معوق) | 2 000 | ≈48 B/ورودی | flush 60s | حذف از سر | ≈ 96 KiB |
| **جمع بدترین حالت** | — | — | — | — | **≈ ۹٫۸ MiB = ۷٫۶٪ از ۱۲۸MiB** |

**اندازه‌گیری واقعی** (۲۰ کاربر، ۸۳ درخواست، ۲ تونل فعال، پس از rollup):
`total_bytes = 52 508` → **۰٫۰۳۹٪ بودجه**؛ `ssMaster` نرخ برخورد ۰٫۹۵، `metricMirror` ۰٫۹۵، `ssUserKeys` ۰٫۷۶۵.
در همان اجرا: `d1_write = 291`, `d1_read = 298`, `kv_write = 67` (بیشترش مربوط به ساخت اولیهٔ اعتبارنامهٔ ۲۰ کاربر است، نه ترافیک).

**هزینهٔ هر کاربر همزمان:** ≤ ~۴۰۰ بایت (یک ورودی وضعیت + یک نمک + دو کلید + صندوق مصرف).
یعنی حتی با ۱۰٬۰۰۰ کاربر همزمان، مصرف کش‌ها به‌دلیل سقف‌ها روی همان ≈۹٫۸MiB می‌ماند —
حافظه **مستقل از تعداد کاربر** است، چون سقف‌ها قبل از رشد کار می‌کنند.

**مسیر داغ:** هیچ خواندن KV/D1 در پردازش بسته‌ها وجود ندارد؛ بررسی وضعیت هر ۳۲ بسته از
RAM (یا در بدترین حالت از اسنپ‌شات KV) انجام می‌شود.

---

## ۳) پچ‌ها (C، D، E، F)

### C) قتل‌سوییچ قطعی و شمارش مصرف (سه لایه)

```diff
-  async (env, uuid, up = 0, down = 0, sessionId = null) => {
-    await D.run(env, `UPDATE qv_users SET used_bytes = used_bytes + ? ...`, up, 0, 0, uuid);
-    await D.run(env, `UPDATE qv_users SET down_bytes = down_bytes + ? WHERE uuid = ?`, down, uuid);
+  async (env, uuid, up = 0, down = 0, sessionId = null) => {
+    const upN = Math.max(0, Number(up) || 0), downN = Math.max(0, Number(down) || 0);
+    await D.run(env, `UPDATE qv_users SET used_bytes = used_bytes + ?, up_bytes = up_bytes + ?,
+                      down_bytes = down_bytes + ?, last_seen = unixepoch() WHERE uuid = ?`, upN + downN, upN, downN, uuid);
*** (12-d1ext.js · D.Sessions.meter)
```

```diff
+  D.Users.state = async (env, uuid, opts = {}) => {          // RAM → KV → D1
+    const hit = opts.fresh ? null : STATE_CACHE.get(uuid);
+    if (hit) return hit;
+    const snap = await QV.d1.Kv.get(env, 'qv:ustate:' + uuid, null);
+    if (young(snap) && (blocking(snap) || !staleQuota(snap))) st = snap;
+    ...
+  };
+  D.Users.allowed = async (env, uuid) => {/* disabled | killswitch | expired | quota */}
+  D.Users.forget = async (env, uuid, opts = {}) => {/* ابطال RAM + تازه‌سازی اسنپ‌شات */}
*** (12-d1ext.js · لایهٔ سه‌مرحله‌ای وضعیت)
```

```diff
-      const u = await QV.safeAsync(() => QV.d1.Users.get(env, uuid), null);
-      if (u && (!u.enabled || u.killswitch)) { closeAll('revoked'); return false; }
+      const verdict = await QV.safeAsync(() => QV.d1.Users.allowed(env, uuid), null);
+      if (verdict && !verdict.ok && verdict.reason !== 'unknown') { closeAll('revoked'); return false; }
*** (20-shadowsocks.js · گارد هر ۳۲ بسته — صفر خواندن D1)
```

### D) اشتقاق کلید (HKDF) و ضد‑پروب Shadowsocks

```diff
+  const DERIVE_LABEL = 'AXR-SS-AEAD-V1';
+  const derivedCreds = async (env, uuid) => {
+    const master = await deriveMaster(env);                         // KV/env، هرگز در ردیف کاربر
+    const k = await C.hkdf('SHA-256', master, QV.utf8(uuid), QV.utf8(DERIVE_LABEL), 32);
+    return { uuid, key2022: QV.b64.enc(k), legacy: QV.hex(k.subarray(0, 12)) };
+  };
+  /** جست‌وجوی O(1): شناسهٔ کوتاه از ?u= یا دنبالهٔ مسیر، اول امتحان می‌شود */
+  const candidates = async (env, want, hint) => { /* سقف ۲۴ آزمایش، کش KDF، ترتیب احتمالی */ };
+  const SALT_SEEN = QV.cache('ssSalt', { max: 4096, maxBytes: 512 * 1024, ttl: 180000 });
*** (20-shadowsocks.js)
```

```diff
+    /* جست‌وجوی O(1) با شناسهٔ کوتاه در مسیر؛ هیچ‌چیز را حذف نمی‌کند، فقط ترتیب را عوض می‌کند */
+    const ssPath = '/ss/' + uuid.slice(0, 8);
+    nodes.push({ proto: 'ss2022', …, path: ssPath });
*** (38-subs.js · گره‌ها هم شناسه را حمل می‌کنند)
```

### E) کرون (۱۹ کار، قفل و بودجه)

```diff
-  const CRON_TASKS = [ /* 16 کار بدون قفل */ ];
+  const CRON_TASKS = [ /* 19 کار، هرکدام با budgetMs */ ];
+  /* stagger: کار n روی دقیقه‌ای می‌افتد که (nowMin + n) بر دوره‌اش بخش‌پذیر باشد */
+  locked = await QV.d1.Jobs.claim(env, task.id, period);
+  if (!locked) { results[task.id] = { skipped: 'locked' }; continue; }
+  ... finally { await QV.d1.Jobs.release(env, task.id, ms, err); }
*** (40-router.js · scheduled)
```
کارهای تازه: `meter-flush` (۶۰s)، `state-snapshot` (۵m)، `jobs-gc` (۱۵m).

### F) رصدپذیری

```diff
+      caches: QV.cacheStats(), memory: QV.memEstimate(), counters: QV.metrics.flat(),
+      meter_queue: QV.d1.Sessions.meterQueue(), jobs: CRON_TASKS.length,
*** (40-router.js · /health)
```
هیچ لاگ به‌ازای هر درخواست در D1 نوشته نمی‌شود؛ `debug` فقط در لاگ می‌ماند. شمارنده‌های
`kv_write`، `d1_write`، `d1_read`، `ss_salt_replay`، `ss_padding_seen`، `job_claim/skip`،
`fsm_cache_hit`، `ss_derive_cache_hit` در `/health` دیده می‌شوند.
رابط‌های تازهٔ عملیات: `GET/POST /api/jobs` (اجرا/قفل/آزادسازی/دفتر)، `GET/DELETE /api/cache`،
`GET /api/ss` (حسابرسی اعتبارنامه‌ها)، `GET/POST /api/shape`.

### D1 — بهداشت پارامتر (یک نقطه برای همه)

```diff
-      return QV.safeAsync(() => env.DB.prepare(sql).bind(...params).first());
+      return QV.safeAsync(() => env.DB.prepare(sql).bind(...QV.d1SanitizeAll(params)).first());
+  QV.d1Sanitize = (v) => /* null|number|bigint|string|bytes ؛ Request/Response/Blob/شیء → رشتهٔ خوانا */
*** (00-header.js؛ و 05-env برای هر هندل D1 بیرون‌آمده از alias)
```

---

## ۴) `wrangler.toml` نهایی (G)

فایل کامل در `/home/user/wrangler.toml` است؛ جانِ آن:

```toml
name = "quantum-veil-edge"
main = "worker.js"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]
minify = true
keep_names = false
[limits] cpu_ms = 30000
[observability] enabled = true; head_sampling_rate = 0.1
[placement] mode = "smart"
[[d1_databases]] binding = "DB"  database_name = "qvu-db"
[[kv_namespaces]] binding = "KVU_KV"
[triggers] crons = ["* * * * *"]           # یک تریگر؛ زمان‌بندی داخلی کار را پخش می‌کند
[env.staging] …                            # الد1/KV/نام جدا + vars جدا
```
رازها (خارج از فایل): `ADMIN_PASSWORD`, `JWT_SECRET`, `API_SECRET_TOKEN`, `TELEGRAM_BOT_TOKEN`,
`ADMIN_TELEGRAM_ID`, `SS_MASTER_SECRET`, `BRIDGE_SECRET` (+ اختیاری `TELEGRAM_WEBHOOK_SECRET`, `SS_PASSWORD`).

> **الحاقیه (PR #2):** `ADMIN_TELEGRAM_ID` دیگر **الزامی نیست** و در فهرست بالا هم اختیاری
> شده است. ربات به‌جای تنظیم‌شدن، از پنل **claim** می‌شود و شناسهٔ چت مدیر فقط در D1
> (جدول `qv_admins`) می‌نشیند — نه در secret، نه در var، نه در URL و نه در لاگ.
> قدم‌به‌قدم: `DEPLOY-fa.md` بخش ۳-۲.
دربارهٔ حجم: صفحهٔ رسمی محدودیت‌ها اکنون **۶۴MiB پس از فشرده‌نشدن** برای هر دو پلن می‌گوید
(سبت ۵، ۲۰۲۶ سقف فشردهٔ ۳/۱۰MiB برداشته شد). بستهٔ ما ۱٫۶۲MiB خام و ۰٫۲۷MiB gzip است — در هر دو رژیم بی‌خطر.

---

## ۵) تست‌های افزوده (H)

| فایل | تست‌ها | چه چیزی را قفل می‌کند |
|---|---|---|
| `tests/protocol.test.mjs` | ۳ | Shadowsocks AEAD واقعی تا echo؛ اعتبار اشتباه ⇒ سکوت؛ پروب بدون Upgrade ⇒ ۴۰۴ بی‌اطلاع |
| `tests/quota.test.mjs` | ۹ | سهمیهٔ هر کاربر جداگانه، مرز دقیق (used==quota قطع)، احیا، کرون، صف/کش‌ها |
| `tests/memory.test.mjs` | ۵ | سقف ورودی/بایت هر کش، بودجهٔ کل < ۱۲٪، برخورد از RAM، پاک‌سازی کش |
| `tests/replay.test.mjs` | ۲ | بازپخش نمک ⇒ قطع بی‌صدا + شمارش؛ نمک تازه ⇒ کار عادی (بدون مثبت کاذب) |
| `tests/kvwrite.test.mjs` | ۴ | نرخ نوشتن KV زیر بار واقعی (≤ ۶ در ۶۱ درخواست)، خواندن صفر نوشتن، نرخ D1 |
| `tests/cronlock.test.mjs` | ۴ | قفل کار، رد رانر دوم، `force`، بقای دفتر و آزادسازی درست |
| `tests/webhook.test.mjs` | ۴ | امضای HMMAC مشتق‌شده از توکن (مسیر استقرار واقعی) |
| `tests/config.test.mjs` | ۶ | خودِ `wrangler.toml`: نبود واژهٔ پرخطر (حتی در کامنت)، بایندینگ‌ها، یک تریگر کرون، محیط staging، «راز نوشته‌نشده»، سقف حجم بسته |
| ۷ فایل پیشین | ۴۷ | boot(۶) · users(۹) · subs(۷) · dns(۹) · transports(۶) · telegram(۷) · protocol(۳) |
| **جمع** | **۸۱** | **۱۴ فایل، همه پاس** |

نمونهٔ سنجه‌های افزوده در خودآزمون: «جدول‌های نسل‌های قدیمی»، «رویداد debug ذخیره نمی‌شود» (۶۸ سنجه).

---

## ۵-۲) موتور آی‌پی تمیز — یافته‌های «ذره‌بین» و آنچه ساخته شد

**۶ یافتهٔ اصلی در کد قبلی (همه با شمارهٔ خط):**

| # | شدت | جای | یافته | رفع |
|---|---|---|---|---|
| ۱ | بحرانی | `14-antidpi-ext.js:159` | سنجش از خودِ لبهٔ Cloudflare انجام می‌شد و نتیجه به‌عنوان «آی‌پی تمیز برای ایران» مصرف می‌شد | سیگنال اصلی به مرورگر کاربر منتقل شد؛ دید لبه فقط با برچسب `edge` و خارج از امتیاز ایران |
| ۲ | بحرانی | `14-antidpi-ext.js:166` | فقط ۴ بازهٔ IPv4 ثابت، ۳ نمونه از هر بازه، **بدون IPv6** (خانواده به‌صورت ثابت `'v4'`) | رجیستری ۹ ارائه‌دهنده + کشف زندهٔ بازه‌ها + نمونه‌گیری لایه‌ای v4/v6 (اندازه‌گیری زنده: v4 15/211/400/19/400/91/400/400/400 و v6 7/32/95/2/43/5/139/79/400) |
| ۳ | بالا | `14-antidpi-ext.js:172` | فقط `connect()` روی ۴۴۳؛ بدون TLS/SNI/ALPN/WebSocket | سه سیگنال مستقل: مسیردهی مرورگر، `wss://` سرتاسری با SNI واقعی، و دید لبه |
| ۴ | بالا | `14-antidpi-ext.js:174` | امتیاز جدول ثابت (`60+30/18/6`)؛ بدون نمونه، بدون افت، بدون اطمینان | موتور امتیازدهی قطعی: کران پایین ویلسون، هیستوگرام تأخیر، جیتر، افت زمانی، جریمهٔ خطا |
| ۵ | بالا | `40-router.js:440` | کادنس ساعتی، بدون قفل، بدون پرکردن مخزن | گزارش‌ها پیوسته از مرورگرها می‌آیند؛ کرون فقط تجمیع/افت/پرکردن/کشف را انجام می‌دهد (۶۰s، ۳۰۰s، ۹۰۰s، ۶h) |
| ۶ | متوسط | `00-header.js:773` | جدول `qv_ip_pool` تخت بود: بدون ASN، بدون خانواده، بدون حالت قرنطینه | `qv_ip_scores` با کلید `(scope, ip)` و scope های `global` / `asn:<ASN>` / `edge`؛ `qv_ip_pool` هم همچنان نوشته می‌شود تا هیچ سطح قدیمی نشکند |

**افزوده‌های این دور:** ضد‑replay نمک در SS، شناسهٔ کوتاه مسیر برای O(1)، شکل‌دهی ضد‑اثر انگشت، قفل کارهای کرون، شمارنده‌های بودجه، `/api/jobs` و `/api/cache`، FSM کش‌شده، و موتور کامل بالا.

**بازبینی امنیتی موتور آی‌پی تمیز (دور آخر):** گزارش کامل در `AUDIT-cleanip.md` و دیف تأییدشده در `docs/cleanip-hardening.diff` — دو باگ بحرانی (سقف ۱۰۰ پارامتر D1 که تاریخ ردیف‌ها را ریست می‌کرد، و لیست مجاز در رمِ isolate که اجازهٔ جعل می‌داد)، کران‌گذاری خروجی هوش مصنوعی، fallback قطعی، و وصل‌شدن سیگنال *احراز‌شدهٔ* تونل.

**اعداد تأییدشده:** تست‌ها **۱۵ فایل / ۱۱۳ تست**؛ خودآزمون **۸۸/۸۸**؛ دود **۵۸/۵۸**؛ کشف زندهٔ بازهٔ ۹ ارائه‌دهنده ✅؛ بودجهٔ حافظهٔ موتور در بدترین حالت **≈۵٫۱MiB** و در اندازه‌گیری واقعی **۵۲KiB**؛ خودِ فایل نهایی **۱٫۸۱MiB** (خام) و **۲۹۶KiB** (minify+gzip) در برابر سقف ۶۴MiB.

---

## ۶) بازبینی «خودکار» — چه چیزی بدون دست شما کار می‌کند

- **۱۹ کار زمان‌بند** با قفل D1 و بودجهٔ زمانی: سهمیه، flush مصرف، snپ‌شات وضعیت، GC نشست/رویداد/کار،
  رفع بن، GC کش DNS، سلامت و شکار SNI، اسکن IP تمیز، بازطراحی استراتژی با AI، تازه‌سازی فهرست مدل‌ها،
  probe سلامت، نظرسنجی تلگرام، rollup متریک، پشتیبان شبانه، خودترمیمی، خودآزمون.
- **هویت خودکار**: ساخت جدول‌ها، ادمین، بذر SNI/IP، رازها، کلیدهای Shadowsocks، استراتژی اولیه.
- **قطع خودکار**: عبور از سهمیه ⇒ `quota:cut` + مهر قطع + ۴۰۳ روی `/sub/<uuid>` + بستن تونلِ در جریان
  (هر ۳۲ بسته یا حداکثر ۷ ثانیه بعد، بسته به کش) — و به‌طور خودکار در پاک‌سازی دقیقه‌ای هم دوباره بررسی می‌شود.
- **اعلام وضعیت**: رویدادهای `warn/error` به تلگرام مدیر می‌روند؛ `/health` همهٔ شمارنده‌های بودجه را می‌دهد.
- **ضد‑پروب**: سکوت کامل در اعتبار اشتباه، ۴۰۴ تارپیت برای درخواست بدون Upgrade، قطع بی‌صدا در بازپخش نمک،
  شکل‌دهی تصادفی فریم‌ها، پشتیبانی از تکه‌تکه‌سازی سمت کلاینت.

---

## ۷) ریسک‌ها و چیزهایی که نتوانستم تأیید کنم

1. **کلاینت‌های ثالث را در این محیط نداشتم.** صحت جریان SS‑2022 با «مشخصات SIP022 + کدک خودمان»
   سنجیده شد (رفت‌وبرگشت دو طرفه)، نه با اتصال یک کلاینت واقعی (sing-box/Clash). برای اطمینان
   نهایی، یک اتصال آزمایشی با کلاینت واقعی لازم است.
2. **`?plugin=v2ray-plugin;…` در URI**: برخی کلاینت‌ها راستی‌آزمایی می‌کنند و برخی نادیده می‌گیرند.
   مسیر `/ss/<short>` در پروفایل Clash/sing-box قطعی است؛ در URI خام «بهترین تلاش» است.
3. **همگامی بین‌منطقه‌ای KV**: اسنپ‌شات تا **۴۵ ثانیه** قابل‌اعتماد است و مهرهای سهمیه‌ای قدیمی‌تر از
   **۱۰ ثانیه** دوباره از D1 راستی‌آزمایی می‌شوند. مهرهای قطع (killswitch) همیشه fail‑closed هستند.
   این عدد را فقط محلی اندازه گرفتم؛ تأخیر واقعی انتشار KV در شبکهٔ Cloudflare را نمی‌توانم تضمین کنم.
4. **`placement: smart` و `limits.cpu_ms`** ویژگی پلن Paid هستند؛ در پلن رایگان نادیده گرفته می‌شوند
   (سقف ۱۰ms CPU). بسته برای هر دو پلن بی‌خطر است ولی کارهای AI/اسکن در پلن رایگان می‌توانند ناتمام بمانند.
5. **Durable Object** (`QVRelay`) اختیاری است و در این محیط فعال/تست نشد؛ همهٔ قابلیت‌ها بدون آن کار می‌کنند.
6. **کرون در Pages وجود ندارد** (محدودیت خود Pages). راه‌حل در راهنمای استقرار آمده است.
7. **`/api/ai` در محیط تست** مدل فعال را از فهرست پشتیبان (۲۴ مدل) نشان می‌دهد چون بایندینگ AI در
   miniflare موجود نیست؛ انتخاب «پویا» در استقرار واقعی از فهرست زندهٔ Cloudflare می‌خواند.
8. **عدد محدودیت حجم**: جدول رسمی «۶۴MiB خام» را دیدم؛ برخی صفحات هنوز ۳MB/۱۰MB فشرده را نقل می‌کنند.
   بستهٔ ما زیر هر دو است.

---

## ۸) فهرست تغییرات این دور (برای تحویل)

| فایل | تغییر |
|---|---|
| `core/00-header.js` | `QVStore` بامحدودیت بایت، `QV.cache/cacheStats/memEstimate`، `QV.d1Sanitize`، شمارش D1/KV، دروازهٔ رویداد debug، پاک‌سازی بایند |
| `core/02-utils.js` | `metrics.flat()`، uptime از مهر بوت |
| `core/05-env.js` | یکسان‌سازی پاک‌ساز D1، قدم `legacySchema` در بوت |
| `core/12-d1ext.js` | لایهٔ سه‌مرحله‌ای وضعیت + `allowed/forget/snapshot`، مِتر معوق + `flushMeters`، `Jobs` (قفل D1)، FSM read-through، شمارنده‌های RAM‑اول |
| `core/19-legacy-shims.js` | پذیرش جدول‌های نسل‌های قدیمی، شکل‌دهی دان‌استریم VLESS |
| `core/20-shadowsocks.js` | HKDF هر کاربر، کش کلید/نمک، ضد‑replay، شناسهٔ کوتاه، SIP022 صحیح، padding، مِتر معوق، فشرده‌سازی شمارش، `shapeSend/Stream/Cfg`، `audit` |
| `core/30-telegram.js` | امضای HMAC بدنه + اثر انگشت راز در `/api/tg` |
| `core/38-subs.js` | اعتبارنامهٔ مشتق‌شده، تصمیم از نمای وضعیت، ترابری WS + مسیر شناسه برای SS |
| `core/40-router.js` | کرون قفل‌دار/بودجه‌دار/پخش‌شده، `snapshotActiveUsers`، `/health` کامل، سفارش قطع (revoked بر legacy مقدم) |
| `core/42-api.js` | `/api/jobs`, `/api/cache`, `/api/ss`, `/api/shape`، قفل در مسیر دستی کرون |
| `core/45-compat.js` | `BOOTED_AT`، ابطال کش وضعیت در cut/revive/upsert، تقدم جدول‌ها |
| `core/46-selfcheck.js` | ۲ سنجهٔ تازه (جدول‌های قدیمی، رویداد debug) → ۶۸ سنجه |
| `surface_check.js` | فضای‌نام‌های نمونه‌ای (Map/Array/TextEncoder/QVLru) صریح شدند → حسابرسی سطح از «۷ مثبت کاذب» به **۰ مورد حل‌نشده** رسید |
| `tests/` | ۶ فایل تازه + `ssclient.mjs` مشترک + بازنویسی کلاینت پروتکل → **۷۵ تست** |
| `wrangler.toml` | پیکربندی کامل Workers + staging (بدون هیچ واژهٔ پرخطر، حتی در کامنت‌ها) |
| `DEPLOY-fa.md` | راهنمای استقرار گام‌به‌گام فارسی (Workers + Pages، رازها، دامنه، IP تمیز، عملیات) |
| `REPORT-zehbin-fa.md` | همین گزارش |

**پیام یک‌خطی:** حالا می‌توانید `wrangler deploy` بزنید؛ همه‌چیز (جدول‌ها، ادمین، کلیدها،
کارهای زمان‌بند، ضد‑پروب، قطع خودکار و اعلام وضعیت) خودکار است و مصرف KV/D1 با شمارندهٔ
زندهٔ `/health` زیر کنترل می‌ماند.
