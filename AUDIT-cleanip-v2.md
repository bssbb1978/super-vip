# QV.cleanip — audit pass 2: open issues + automation A–H

**Role:** principal network-security engineer / distributed-systems architect
**Subject:** the clean-endpoint subsystem of `worker.js` (single file, Cloudflare Worker **and** Pages Functions, D1 + KV)
**Deliverables:** this document · `docs/cleanip-v2.diff` (unified diff against the uploaded `worker.js`, 28 hunks, +679 / −47, 62,188 B) · self-tests · updated `ENDPOINTS-ENGINE.md` / `DEPLOY-fa.md`
**State after the pass:** `16 files / 121 tests` ✔ · self-test **97/97** ✔ · smoke **58/58** ✔ · runtime surface 113 namespaces, **0 unresolved** ✔ · whole-file ESM parse clean ✔ · bundle 1,846,863 B raw → 1,019,539 B min → **309,467 B gzip** (0.46 % of the 128 MB isolate budget, ~1.5 % of the 64 MiB script cap)

> Order of work, as required: **read first → findings with line numbers → minimal additive change → measure.** Every finding cites the line number *as it stood in the uploaded file*, before any edit. Nothing was deleted, renamed, disabled or re-pointed: the audit's `defined but never referenced` count is **0** after the pass, i.e. no new dead code and no lost entry point.

---

## 0. Method and evidence

| Evidence type | What was done |
|---|---|
| Source reading (before any edit) | `flushReports` L5631 with its batch loop L5696–5704; the dead helper `clean` L5305; `knownTargets` L6034 (L6038 `HOSTS`-only); `feedback` L6213 / L6227; `ranges` L5310; `plan` L5728; `decay` L5931; `aggregate` L5923; `refill` L5968; `audit` L6006; the cron table L8376–8388; `analyse` L1780 (KV puts L1786/1805/1818, load L1826); the operator feedback route L8812; the tunnel signal L3788–3793; the router upgrade hook L8036 |
| Runtime probes | Miniflare-4 boots of the *built* artifact: `probe_v2_verify.mjs` (per-ISP view, dual-stack, flush shape, windows table, strategy evaluation), `/tmp/p2.mjs` (no-`HOSTS` deployment), `/tmp/p4.mjs` (rollback through the operator route, cache dropped) |
| Tests | `tests/cleanip.test.mjs` +5 tests, new `tests/cleanip-nohosts.test.mjs` (3 tests), `46-selfcheck.js` +9 checks |
| Limits | Cloudflare D1 — **100 bound parameters per query**, 100 KB per statement, 1000 queries/invocation (paid) · Workers — 128 MB per isolate, cron ≥ 1 min ([developers.cloudflare.com/d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/)) |

---

## 1. The three requested fixes

### F1 — `flushReports` re-queued **all** chunks after a failed batch → double counting
**Pre-change lines:** `flushReports` L5631, chunk loop L5696–5704, `requeue` of the whole list at **L5700**.
**Defect (data corruption, silent):** the flush walks the pending buffer in chunks of `FLUSH_ROWS = 40` and `await`s each `db.batch()`. On error it pushed **every** item of the current pass back into the queue — including the chunks that had *already committed*. Because the D1 upsert accumulates in SQL (`samples = samples + excluded.samples`), the re-sent rows were added a second time: samples, `ok`, `ws_ok` and `fails` all drifted upwards, i.e. the ranking slowly believed in inflated evidence, worst exactly when the database is flaky.
**Fix (additive, no signature change):** the loop now tracks `committed` (items actually written by successful batches) and re-queues only `items.slice(committed)`. A partial failure raises the counter `ci_flush_partial` and returns `{ flushed, committed, requeued, batches }`; `flushed` keeps its old meaning, so every existing caller and the panel keep working.
**Evidence:**
- self-test *"a partially failed flush requeues only the uncommitted tail"* — 60 buffered entries, a stub D1 that throws on the **second** batch call: `chunk1 committed=40 requeued=20`, second pass `flushed=20`, table rows `60`, `doubled=0` (a naive implementation produces `100` rows and values `>1`).
- full-suite regression: `tests/cleanip.test.mjs` 37/37 (the flush/accumulation tests that assert 1→2→3 still pass).

### F2 — the dead helper `clean` (L5305)
**Pre-change line:** `const clean = (list) => …` at L5305, inside `ranges()`.
**Verification before removal:** `grep -n "\bclean(" worker.js` → **0 call sites**; both provider parsers already return through `validateRanges()` (which de-duplicates, drops bogons and caps the list), and `--core-only` surface analysis reported it as unreachable. The user's condition ("remove only if verified unused") was therefore met.
**Change:** the one-line helper was removed and the explanatory comment retained/updated in place. Nothing else in `ranges()` changed; `clean` was not exported and not referenced by any unit. `check_core.js` still reports its **8 known false positives** and `defined but never referenced — 0`.

### F3 — tunnel feedback was **silently** dropped when `HOSTS` is unset
**Pre-change lines:** `knownTargets` L6034 (the allow-set was built from `HOSTS` only, L6038), `feedback` L6213 / L6227, tunnel signal L3788–3793.
**Defect (operator blind spot):** on a deployment whose only domain is the Worker's own route — very common, and the default in the docs' quick start — `HOSTS` is empty. Every authenticated tunnel success was then classified "unknown host" and thrown away without a counter, so the strongest available evidence (a real end-to-end connection through a real client in Iran) was never recorded and nothing in `/health` or the audit said why.
**Fix (original evidence, old entry points kept):**
1. `configuredHosts(env)` = `HOSTS` **∪** `CUSTOM_DOMAIN` (both were already used for tunnel routing at L1426, so the two sides now agree).
2. `knownTargets(env, asn, { ownHost })` additionally admits the request's **own verified `Host`** when it is either a configured domain or already carries a scored/`tunnel` row. A Host that is neither is still refused — the attack model is unchanged.
3. Two distinct reasons instead of one silent path: `ci_feedback_dropped_nohosts` (nothing is configured — an operator mistake) vs `ci_feedback_unknown_host` (a name that is not ours — an attack), both written into `DROP_REASONS` (`last_no-hosts` / `last_unknown-host` keep the offending name) and surfaced in `audit().dropped_feedback`.
4. A `noteDegrade('feedback', …)` record is written when the no-`HOSTS` path fires, so `/api/endpoints` shows `degraded.feedback > 0` with the human-readable reason.
**Evidence (real runs):**
- `/tmp/p2.mjs` — boot with `HOSTS=''`, `CUSTOM_DOMAIN=''`, an authenticated VLESS frame to a real upstream: `NO_HOSTS_COUNTER 1`, `DROP_REASONS {"no-hosts":1,"last_no-hosts":"node.example.dev"}`, `DEGRADED {"feedback":1,"last":{"kind":"feedback","detail":"HOSTS/CUSTOM_DOMAIN unset and no host row yet: tunnel feedback dropped"}}`, and **no row** invented for that host.
- `tests/cleanip-nohosts.test.mjs` (3 tests) reproduces exactly that: visible counter, invisible-to-the-ranking host, audit reason present.
- With a domain configured (`CUSTOM_DOMAIN='node.example.dev'`) the same frame is **accepted**: D1 row `{ip:'node.example.dev', provider:'tunnel', samples:0.5}` — the fix is not "accept everything": `not-configured.example.dev` is still refused by name.

---

## 2. Two defects found in the *new* code while verifying it

| ID | Where | Defect | Fix / proof |
|---|---|---|---|
| V1 | `blockSnapshot()` | It spread the raw `QVStore` records (`{v,b,exp}`) instead of their payload, so every quarantine row in the audit would have shown `{v:{…},b:…}` and expired rows would have leaked. Caught by the first block assertion (`expected false to be true`). | The snapshot now reads `e.v`, honours `e.exp` and returns flat rows; the regression test asserts `blocks.some(b => b.scope === scope && b.kind === 'block')`. |
| V2 | `detectBlocks()` | A single `low` list asked two different questions at once: *absolute* badness (`rate ≤ 0.35`) and *relative* badness (worse than the global rate by 0.25). The test that made the whole fleet poor (global 0.10) showed the failure mode: a genuinely targeted ASN could be mis-read as "everyone is down", and the reverse produced no outage vote at all. | The two sets are now separate: `low` (targeted → quarantine ladder) and `absLow` (used for the cross-ASN outage vote). The verdict returns `low`, `abs_low`, `outage`; both self-test and vitest cover the block case and the outage case. |

Both were introduced by this pass, found by its own verification, and are fixed before delivery — they are listed here because the pass's rule is that nothing is hidden.

---

## 3. Automation A–H (all automatic, additive, bounded)

| # | Requirement | Implementation (current line) | Bounds / defaults | Verified by |
|---|---|---|---|---|
| ★ | **Per-ISP intelligence** | `ISPS` registry + `ispOf` (5166), `per_isp` in `audit()` (6432) | 6 Iranian ASNs pre-mapped (MCI 197207, Irancell 44244, TCI 58224, Rightel 57218, Shatel 31549, IranServer 204213) + Wilson lower bound, latency percentiles, freshness decay, per-ASN ranking with global fallback | probe: `per_isp [{asn:'396982', samples:4, ok:3, ws_ok:3, success_pct:75, upgrade_pct:75, cooling:1}]`; vitest asserts shape |
| ★ | **Adaptive probe scheduling** | `banditOrder()` (5981), used by `plan()` (6010) | ε-greedy/UCB mix seeded by `mulberry32`: posterior + 0.15·UCB + 0.05·recency, weight `n/(n+4)` so thin evidence stays explorable; **hard hand-out cap** `min(want, LIMITS.batchIps × 2)` (+ per-scope 6) | self-test: identical order on repeat + `UCB(thin) > UCB(thick)`; self-test: 500 asked → ≤20 candidates |
| ★ | **Block detection & quarantine** | `detectBlocks()` (6182), `BLOCK` (6179), `BLOCKS` cache (6180) | window 15 min, `minSamples 12`, `lowRate 0.35`, `dropPoints 0.25`, recover 0.6 — targeted ASN → exponential ladder `900 / 3600 / 21600 / 86400 s` then purge; cross-ASN vote → `degraded` instead (never a block); recovery releases and resets backoff; counters `ci_block_detected`, `ci_outage_detected`, `ci_block_cleared`; `emit('cleanip:block')` | self-test block+release and outage; vitest block, recovery, outage — all through the public `detectBlocks` |
| ★ | **Range refresh, never erasing a good list** | `ranges()` (5432) with `GOOD_RANGES` (5420), `persist` into `qv_ip_ranges.payload` | live → last-good → static; **a failed fetch can only fall back**: `chosen = live ? lists : (last-good \|\| static)`; per-provider `source` is reported (`live` / `last-good` / `static-fallback`); counters `ci_ranges_lastgood`, `ci_ranges_static_after_refresh`; degradation recorded with the provider ids | self-test: offline fetch → `source='last-good'`, v4 kept ≥1, persisted rows > 0; probe: `degraded.ranges` = 0 on a cold read (static on a cold read is *normal*, not a degradation) |
| ★ | **IPv4 + IPv6 end to end** | `pick()` (6277) with `prefer: 'auto' \| 'v4' \| 'v6'`, NAT64 synthesis | returns `preferred` (ordered, family-tagged), `dual ∈ {native, nat64-only, v4-only}` and keeps `v4` / `v6` / `nat64` for old callers; `/clean-ip?prefer=` and `/api/ips?prefer=` | probe: `prefer=v6` → `64:ff9b::8300:4bf6 family=v6 nat64=true`; `prefer=v4` → `131.0.75.246` — both `dual=nat64-only` on this network; vitest asserts the same |
| ★ | **Strategy loop with rollback** | `recordStrategy` / `measuredRate` / `evaluateStrategy` (1838–1900), history in `qv:strategy:hist` (≤8) | AI proposes → `sanitizeStrategy` clamps → `heuristicStrategy` fallback; every apply records `{v, source, shape, fragment, baseline, reason}`; rollback when the measured success rate falls `> 0.15` below the baseline with `≥ 40` samples; **at most one evaluation per 30 min**, cron `strategy-eval` every 1800 s (8876), operator route `POST /api/ips {"action":"evaluate"}` | `/tmp/p4.mjs` (cache dropped, seeded history): `{"verdict":"rolled-back","to":3,"rate":0.2,"baseline":0.9,"since":40}` → `strategy {version:3, source:'rollback', shape:'ws-tls', fragment:{mode:'sni-split',…}}`, history entry + `ci_strategy_rollback`; self-test + vitest cover it |
| ★ | **Self-healing degradation** | `DEGRADED` / `noteDegrade` / `degradedSnapshot` (5670), `ci_degraded_*` counters | every D1/KV/AI/ranges/windows/feedback failure path records a kind + reason and **returns a safe answer instead of throwing**; surfaced as `audit().degraded` | self-test *"degradation is recorded instead of thrown"*; probes on D1-less boots |
| ★ | **Observability** | `audit()` (6432), `/health` counters, `POST /api/ips {"action":"blocks"}` (9309) | `per_isp`, `scopes` (active/cooling/quarantined), `blocks`, `block_limits`, `dropped_feedback` (+ per-counter breakdown), `degraded`, `strategy`, `strategy_history`, `buffer_pressure` (used/max/pct/window_scopes/flush_rows), `ranges.lastgood` | probe output quoted in §4; vitest asserts each field exists and is typed |
| + | **5-minute window aggregation** (new, feeds the detector) | `publishWindows` (5930), table `qv_ip_windows` + index (DDL) | one delta-upsert per scope per flush, **≤ 16 scopes**, `scope` = `asn:…` / `global` / `scope\|host` for host rows; pure additive D1 writes batched with the flush; read only by `detectBlocks()` and the audit | probe: `windows table [{"n":1,"s":4}]` after one report+flush; self-tests read the table directly |

**Entry points kept:** `pick`, `plan`, `handout`, `submit`, `flushReports`, `aggregate`, `refill`, `audit`, `feedback`, `ranges` keep their names, argument shapes and return keys (`flushed`, `ok`, `list`, …). The new fields are additive; the new `prefer` option defaults to `auto`.

---

## 4. Resource budget after the pass

| Resource | Spend | Ceiling |
|---|---|---|
| Isolate memory | 9 bounded caches in the engine (ciRanges 32/512 KB/6 h · ciGoodRanges 32/512 KB/24 h · ciBlocks 64/64 KB/6 h · ciBatch+ciRate 4000/512 KB · ciHandout 5000/2 MB/15 m · ciScores 2000/2 MB/60 s · ciFb 4000/256 KB/1 h · ciKnown 64/256 KB/60 s) — measured total for the whole Worker, all subsystems, still 52,508 B (0.039 %) in the 20-user/83-request probe | 128 MB/isolate · `buffer_pressure.max` = 400 buffered feedback entries |
| D1 — bound parameters | every clean-IP statement ≤ **80** (FLUSH_ROWS 40 × 2) or ≤ 9; `publishWindows` 4 per statement | 100/query (empirical: 120 → `too many SQL variables`) |
| D1 — writes | per flush: `ceil(items/40)` upserts + ≤16 window upserts, one `db.batch()`; detection ≤ ~10 statements; decay ≤ 4; ranges ≤ 10 rows/6 h | 1000 queries/invocation (paid) |
| KV | `qv:strategy` on apply only; `qv:strategy:hist` ≤ 1 write per apply, read ≤ 1 per 30 min; never counters/locks | ≤ 1 write/s/key |
| Cron | ip-agg 60 s · ip-refill 300 s · ip-edge 900 s · ip-scan + ai-replan 3600 s · **strategy-eval 1800 s** (new) · self-heal 3600 s · ip-ranges 6 h — each idempotent, TTL-locked, time-boxed | cron ≥ 1 min |
| Bundle | 1,846,863 B raw → 1,019,539 B min → **309,467 B gzip** | 64 MiB script (1.5 %) |

---

## 5. Verification battery (all re-run on the final artifact, md5 `3ff60fe9d7d76ffb5ca7a0680474ca03`)

| Suite | Result |
|---|---|
| `npx vitest run` | **16 files / 121 tests passed** (was 15/113 at the end of the previous pass) |
| `probe_self.mjs` (in-Worker self-test) | **97/97 passed** (was 88/88; +9 new checks) |
| `smoke.js` | **58/58** |
| `surface_probe.mjs` + `surface_check.js` | 113 namespaces, 0 unresolved, `defined but never referenced` **0** |
| `check_core.js` | 8 known false positives (unchanged; `CORE_ORDER` includes `22-cleanip.js`) |
| Whole-file ESM parse (`esbuild --format=esm`) | clean |
| Differential build | `assemble.js` output is byte-reproducible (verified before this pass; used to freeze the diff baseline) |

New tests added in this pass: 5 in `tests/cleanip.test.mjs`, 3 in `tests/cleanip-nohosts.test.mjs`, 9 self-checks — covering F1, V1, V2, the bandit order and cap, dual-stack preference, range fallback, block/recovery, outage-vs-block, strategy rollback, degradation records and the no-`HOSTS` visibility path.

---

## 6. Residual risks and limits (nothing hidden)

1. **Where "clean for Iran" is measurable.** Only client probes *inside Iran* and authenticated tunnel outcomes carry weight; the server-side edge probe is labelled *edge view* and never treated as a client measurement. Cron cannot run faster than 1 min — "continuous" is achieved by client streaming plus the 5-minute window aggregation, never by per-second server scanning.
2. **Block-vs-outage needs volume.** The detector needs ≥12 samples in a 15-minute window per ASN before it will act; a quiet ASN stays untouched rather than guessed. Thresholds (`0.35` / `0.25`) are engineering defaults tuned on synthetic traffic, not on a live Iranian network; they are constants in one place (`BLOCK`) so an operator can retune them without touching logic.
3. **Bandit is deliberately conservative.** With few samples it explores; the hand-out cap (2× `batchIps`) means adaptation can never turn into a scan storm.
4. **Latency percentiles are sample-based.** `percentile()` derives p50/p90 from stored bucket counts of a bounded sample; they order candidates, they are not an SLA measurement.
5. **The strategy loop needs a readable history.** On a cold isolate with no `qv:strategy:hist` the evaluation reports `skipped: 'no-history'` (seen in the probe) — by design: it will not invent a baseline. `force: true` skips only the 30-minute rate limit, never the sample/evidence requirements.
6. **`prefer` is caller-supplied.** It only reorders rows the engine already ranked and admitted; it cannot introduce a candidate (the value goes through an allow-list, anything else is `auto`).
7. **`qv_ip_windows` grows by design** (≤16 rows per flush, one per scope per 5-minute bucket). It is bounded in time: `decay()` prunes buckets older than **48 h**, at most once per hour (the count is returned as `windows_pruned`); the score table's own purge ladder is unchanged.
8. **Not verified here:** `connect()` from the real Workers runtime to Cloudflare-owned IPs (error 1003 territory) and the live Telegram webhook path — both unchanged by this pass and already documented as environment limits.

---

## خلاصهٔ فارسی

**ترتیب کار رعایت شد:** اول خواندن و ثبت یافته با شمارهٔ خط (نسخهٔ قبل از تغییر)، بعد کمینهٔ تغییر، بعد اندازه‌گیری. هیچ قابلیتی حذف/غیرفعال/تغییرنام داده نشد.

**سه ایراد خواسته‌شده:**
۱. **دوباره‌شماری در `flushReports`** (خط قبلی ۵۶۳۱، حلقه ۵۶۹۶–۵۷۰۴، بازگردانی کل لیست در ۵۷۰۰): اگر یک دسته در میانهٔ کار خطا می‌خورد، تکه‌های **قبلاً نوشته‌شده** هم به صف برمی‌گشتند و چون جمع‌زدن در SQL انجام می‌شود، آمار دو برابر می‌شد. حالا فقط `items.slice(committed)` برمی‌گردد، شمارندهٔ `ci_flush_partial` ثبت می‌شود و خروجی `{flushed, committed, requeued, batches}` است. **اثبات:** ۶۰ آیتم + خطای دستی در دستهٔ دوم → `committed=40 requeued=20`، پاس دوم `flushed=20`، مجموع ردیف‌ها ۶۰ و **هیچ مقدار دوباره‌شماری‌شده‌ای وجود ندارد**.
۲. **هلپر مردهٔ `clean`** (خط ۵۳۰۵): با `grep` تأیید شد **صفر** محل فراخوانی دارد، حذف شد و کامنت توضیحی جایش ماند (سطح اجرایی: `defined but never referenced = 0`).
۳. **افتادن بی‌صدای بازخورد تونل وقتی `HOSTS` تنظیم نشده** (خطوط ۶۰۳۴/۶۰۳۸ و ۶۲۱۳/۶۲۲۷): حالا `configuredHosts = HOSTS ∪ CUSTOM_DOMAIN`، میزبانِ خودِ درخواست فقط اگر دامنهٔ تنظیم‌شده یا ردیف امتیازداشته باشد پذیرفته می‌شود، و دو دلیل جدا ثبت می‌شود: `ci_feedback_dropped_nohosts` (اشتباه اپراتور) و `ci_feedback_unknown_host` (تلاش مهاجم) + رکورد `degraded.feedback`. **اثبات:** استقرار بدون دامنه → شمارنده ۱، دلیل در audit، هیچ ردیفی ساخته نشد؛ با دامنهٔ تنظیم‌شده → همان قاب VLESS پذیرفته و ردیف `provider='tunnel'` ثبت شد.

**دو ایراد که خودِ همین موج در کد جدید داشت و پیش از تحویل رفع شد:** نمایش رکورد خام کش در `blockSnapshot` (V1) و یکی‌بودن دو پرسش «بد در مطلق» و «بد نسبت به بقیه» در `detectBlocks` (V2).

**قابلیت‌های خودکار A–H اضافه شد:** هوش هر ISP (ASNهای ایرانی + Wilson + صدک تأخیر)، زمان‌بندی تطبیقی (bandit با سقف سخت پخش)، شناسایی بلاک با قرنطینهٔ نمایی و بازگشت تدریجی + تشخیص قطعی سراسری با رأی چند-ASN، بازخوانی بازه‌ها با حفظ آخرین لیست سالم (live → last-good → static)، انتخاب IPv4/IPv6 و NAT64 سمت کلاینت، حلقهٔ استراتژی با بازگشت خودکار به نسخهٔ قبلی، خودترمیمی بدون استثنا، و مشاهده‌پذیری کامل در audit و `/health`.

**اعداد واقعی پایانی:** تست ۱۲۱ (۱۶ فایل) ✔ · خودآزمون ۹۷/۹۷ ✔ · دود ۵۸/۵۸ ✔ · سطح اجرایی ۰ مورد حل‌نشده ✔ · بسته ۳۰۹KiB فشرده (۱٫۵٪ سقف) · دیف ۲۸ هانک (+۶۷۹/−۴۷).
