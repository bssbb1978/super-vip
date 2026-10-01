# QV.cleanip — audit & hardening pass

**Role:** principal network-security engineer / distributed-systems architect
**Subject:** the clean-endpoint subsystem of `worker.js` (Cloudflare Worker, single file, D1 + KV)
**Deliverables:** this audit · `docs/cleanip-hardening.diff` (generated with `diff -u`, 31 hunks)
**State after the pass:** `15 files / 113 tests` ✔ · self-test **88/88** ✔ · smoke **58/58** ✔ · runtime surface 113 namespaces, 0 unresolved ✔ · bundle 1.81 MB raw → 999 KB min → **302,593 B gzip** (1.4 % of the 64 MiB cap)

> Order of work, as required: **read first, then change.** Every finding below cites the file and the line number *as it stood before this pass*. Nothing was changed before it was reproduced or read; every fix carries the measurement that verifies it.

---

## 0. Method and evidence

| Evidence type | What was done |
|---|---|
| Source reading | `core/22-cleanip.js` (1,117 lines before the pass) read end to end, plus the call sites in `10-antidpi.js`, `12-d1ext.js`, `14-antidpi-ext.js`, `19-legacy-shims.js`, `25-dns.js`, `38-subs.js`, `40-router.js`, `42-api.js`, `46-selfcheck.js` |
| Runtime probes | Miniflare-4 boots of the built artifact: `probe_ci_live.mjs` (live provider discovery), `probe_fix_verify.mjs` (D1 limits, cold-isolate replay, accumulation), `probe_tunnel_fb.mjs` (real VLESS frame end to end) |
| Limits | Cloudflare D1 docs — **100 bound parameters per query**, per-statement limits apply inside `db.batch()` ([developers.cloudflare.com/d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/)) |
| Regression | `npx vitest run` (15 files / 113 tests), `/health?selftest=1&full=1` (88 checks), `smoke.js` (58), `surface_check.js`, `check_core.js` |

---

## 1. Findings (verified, with pre-change line numbers)

### 1.1 Correctness / data loss

| # | Sev | Location (before) | Finding | Fix |
|---|-----|-------------------|---------|-----|
| **B1** | **critical** | `22-cleanip.js:616–619` (`flushReports`) + `:606` (`take = min(size, 150)`) | The look-up `SELECT … WHERE (scope=? AND ip=?) OR …` binds **2 parameters per buffered row**, up to 150 rows ⇒ **300 bound parameters**. D1 allows **100**. The statement fails; `QV.safeAsync(…, [])` swallows the error; `prev` becomes `{}`, so the upsert writes the batch's *own* counts as absolute values — **the accumulated history of every busy row is reset**. Reproduced: 40 rows (80 params) `OK`, 50 rows (100 params) `OK`, **60 rows (120 params) → `D1_ERROR: too many SQL variables`**. | Chunked look-up (40 rows = 80 params) and chunked `db.batch` (≤40 statements); counters accumulated **by SQL** (`samples = samples + excluded.samples`) so a stale or failed read can no longer destroy history; `read_failed` reported per flush. Verified: 45-row flush → `{"flushed":45,"batches":2,"read_failed":0}`; two consecutive flushes of one key → `samples 2 → 3`. |
| **B2** | **critical** | `22-cleanip.js:542` (`HANDOUT.get(…) || { ips: [], … }`) + `:554` + `:578` | The allow-list ("only addresses we handed out may be reported") lived **only in isolate RAM**. The token is HMAC-signed and therefore portable, so a report replayed to any isolate that never issued the batch found an empty list — and `if (handout.ips.length && !handout.ips.includes(ip))` **short-circuits on empty**, accepting *any* address (and any host). | The signed payload now carries its own allow-list (`i`, `h`; ≤10 addresses, ≤3 handles, ≤2 KB enforced on verify); `verifyBatch` normalises it and rejects `batch-without-targets`; `submit` compares against the **token**, not the cache. Verified by wiping every isolate cache (`DELETE /api/cache`) and posting one report containing a foreign address and a handed-out one: `{"ok":true,"accepted":1,"rejected":1}` — the legit one still verifies off-cache, the invented one is refused. |
| **B3** | high | `22-cleanip.js:169–179` (`v4ToInt`) + `:552`/`:576` (intake) | Non-canonical spellings parsed: `Number('01')` ⇒ `104.16.0.01` and `104.16.0.1` are the same address but **two rows** under `PRIMARY KEY (scope, ip)`; the same held for zero-padded/expanded IPv6. One address, split score — and a client could deliberately split it. | `v4ToInt` accepts canonical octets only; new `canonIp()` (v4 **and** v6, zero-compressed) is applied at every intake and at hand-out. Verified in the self-test (7 spellings → 1 identity, `104.16.0.01` rejected) and by an upper-case IPv6 report landing in the same row. |
| **B4** | high | `22-cleanip.js:261` (`isUsable`) + `:164` (`EXCLUDE_V6` contains `64:ff9b::/96`) | The exclusion list used for **sampling** also gated **validation**, so every NAT64 output of the engine's own DNS64 mapping (`64:ff9b::x.y.z.w`) was `not-a-candidate`: `feedback()` refused IPv6-only subscribers' mappings outright, and `pick()` never validated its synthesized nodes at all. | `isUsable(ip, {nat64:true})` opts out of exactly the two well-known NAT64 prefixes; feedback accepts mappings; `pick()` now validates what it emits. Verified: mapped address accepted, row `family = 'v6'`. |
| **B5** | high | `22-cleanip.js:880` (`decay`) | The decay `UPDATE … WHERE updated_at < now-900` **never set `updated_at`**, so the predicate stayed true and each 60 s `ip-agg` tick subtracted another sample (`samples - 1`) and multiplied the score by 0.85 — a stale row decayed **once per minute**, not once per 15-minute window. | Decay bumps `updated_at`; `flushReports` writes `last_probe`, which also makes the "due for a re-check" filter in `plan()` (`:696`) work (it was inert). Verified: two consecutive ticks leave a freshly measured row untouched. |
| **B6** | medium | `12-d1ext.js:48` | The hot query `WHERE scope = ? ORDER BY score DESC LIMIT 400` cannot use `ix_ip_scores_rank(scope, state, score)` for ordering (no `state` equality) → sort of the whole scope range on every read. | Additive index `ix_ip_scores_scope_score(scope, score DESC)`. |
| **B7** | medium | `22-cleanip.js:325` (`clean`) + `:341` (fallback path) | Third-party answers were **parsed but never validated**: a live/RIPE list could contribute absurdly wide prefixes, bogons, or nested announcements (the sampler then draws the same scarce stratum twice); the curated fallback lists bypassed even `parseCidr`. | `validateRanges()` — family match, `/8`–`/32` (v4) and `/16`–`/128` (v6), base address must not be bogon/reserved, containment dedupe (outer prefix wins) — applied to **live and fallback** lists. Measured effect: Cloudflare unchanged (15 v4 / 7 v6, identical to the authoritative list); OVH v6 43 → **20** (nested announcements merged); Google/OVH/Gcore/CDN77/Akamai now keep up to 512 prefixes (the old 400 cap was an artefact of slicing before dedupe). |
| **B8** | low | `22-cleanip.js:337` + `:795` | `QV.fetchWithRetry(url, {}, { retries, timeoutMs, init: { headers } })` — `init` is **not** a recognised key of the helper (its signature is `(input, init, opts)`), so the custom `user-agent` never left the isolate (the timeout did apply). | Headers passed as the second argument. |
| **B9** | medium | `22-cleanip.js` `handlesFor` (before) | A batch could hand the browser the **same host twice** (`[node.example.dev, node2.example.dev, node.example.dev]` observed) — wasted battery, and the signed set (which dedupes) no longer matched the delivered list. | Dedupe by `host|port`, capped at `LIMITS.batchHosts`. Verified: the token's handle list equals the delivered list. |

### 1.2 Anti-DPI strategy layer

| # | Sev | Location (before) | Finding | Fix |
|---|-----|-------------------|---------|-----|
| **B10** | **critical** | `10-antidpi.js:187` | The Workers-AI answer was merged **straight into live transport parameters**: `const next = { ...state.strategy, ...res.data, … }` — no allow-list, no type check, no clamping, and `load()` trusted whatever sat in KV. A hallucinated `padding.max = 10**9`, a non-existent `shape`, or a `tarpit.delayMs` of an hour would all have been obeyed. Prompt wording is a *request*, not enforcement. | `sanitizeStrategy()`: `shape` and `sni_pool` are allow-listed; every number is clamped (fragment size 8–1200, delay/jitter ≤250, pacing 512–65536 / ≤200, padding 0–900 with `align ∈ {1,2,4,8,16,32}`, tarpit 200–15000, rotation ≥60 s); strings are control-character stripped; unknown keys are dropped. Applied to AI answers **and** to every storage read. |
| **B11** | high | `10-antidpi.js:173` and `:186` | No deterministic fallback: with no AI binding or a failed call, `analyse()` returned `{ok:false}` and the strategy silently **froze** at its previous value — the anti-DPI layer stops adapting exactly when the platform's AI is unavailable. | `heuristicStrategy()` — a pure function of the *measured* per-ASN rows (`ws_ok/samples`, `ok/samples`, quarantine count) with a fixed decision tree, no randomness, no external call; wired into all three failure paths (no binding, AI error, unusable answer). The strategy now records `source: 'ai' \| 'heuristic'`. Self-test pins determinism (identical JSON on repeat) and that the fallback's `shape` is always a real one. |

### 1.3 Signals — the "real-tunnel feedback" claim

| # | Sev | Location (before) | Finding | Fix |
|---|-----|-------------------|---------|-----|
| **B12** | high | `22-cleanip.js:1109` (`feedback`) — one caller, `42-api.js:294` | Tunnel feedback was **documented as a primary signal but never wired into a session**: no code path called it outside an admin API action. Worse, the obvious hook is unsafe — a probe of the built artifact showed `/ws`, `/ws/not-a-uuid` and `/vless` all answer **101 before authentication** (VLESS authenticates on the first frame *inside* the socket: `19-legacy-shims.js:81–91`). Scoring the upgrade would have let any socket inflate rows, and `?ep=<any address>` would have let it *invent* candidates. | Upgrade is now **observation only** (`ci_upgrade_seen`, no scoring). The authenticated signal is emitted at the one place where the user row, revocation, session limit and the upstream socket have all succeeded (`19-legacy-shims.js`), and `feedback()` may only **confirm known targets** — a configured handle for the host, an existing row for the address (60 s cache). Unknown input is counted (`ci_feedback_unknown_host` / `_unknown_ip`) and dropped. Verified end to end with a real VLESS header frame to a real upstream: row `{ip:'node.example.dev', scope:'asn:396982', provider:'tunnel', samples:0.5, ws_ok:0.5}`; the same session's `?ep=104.16.9.9` was refused and created **no** row. |

### 1.4 Dead code, inert fields, cosmetic

| # | Location (before) | Observation |
|---|-------------------|-------------|
| D1 | `12-d1ext.js:43–46` | `rtt_p95`, `edge_score`, `meta` are declared and never written. `rtt_p95` is the only one that would change behaviour — the p95 is approximated by the latency histogram instead; the columns are kept for schema stability (dropping them is a destructive migration). |
| D2 | `22-cleanip.js:696` | `last_probe` was read by `plan()`'s freshness filter and **never written** by anything ⇒ the filter never suppressed a row. Now written by every flush (and the decay guard depends on the same column). |
| D3 | `22-cleanip.js:429–430` | `confidence` was a byte-identical recomputation of `success` (same `wilsonLower(ok, samples)`), i.e. the audit column said the same thing twice. Kept for API compatibility; `parts` exposes the real ingredients (`base`, `fresh`, `jitter`, `penalty`). |
| D4 | `22-cleanip.js:937` | `if (!QV.env.get(env,'AI_LABEL','') && !(env.AI && QV.env.get(env,'AI_LABEL','')))` — the second clause is unreachable; the effective rule is "AI_LABEL must be set". |
| D5 | `22-cleanip.js:927` | `refill()` writes `score = excluded.score` for edge rows computed from a **single** sample, overwriting any accumulated score in scope `edge`. Harmless (that scope is never served) but noisy in the audit. |
| D6 | `22-cleanip.js:950–953` | `audit()` runs three sequential D1 queries per call; `families` counts `scope='global'` only, so handle rows are invisible there (visible in `recent`). Fine for an operator view; not a hot path. |
| D7 | `42-api.js:294` (before) | `action:'feedback'` accepted an arbitrary `ip`/`asn` from the admin — now funnelled through the same validation with an explicit `trusted: true` flag, so the *only* way to seed a candidate is an authenticated operator action, and it is visible as such (`provider: 'operator'`). |

---

## 2. What was *not* changed, and why

1. **The VLESS 101-before-authentication behaviour itself.** It is real and reported (B12), but it is the tunnel layer's semantics, not the endpoint engine's: the legacy handler authenticates in the WebSocket message listener, where it also enforces revocation, quota, port blocklist and session limits. Changing *when* the upgrade is answered would alter client compatibility; the correct architectural fix is the one applied here — **never treat the upgrade as a measurement**, and take the authenticated signal from the session path. Recommendation for the session layer: the same hook can be extended to a byte-counted confirmation (a session that moved ≥N bytes) if a stronger weight is wanted.
2. **Client-side per-IP TLS.** A browser cannot open `https://<ip>/` with a foreign SNI — Cloudflare fails the handshake when SNI matches no certificate it holds, and a JS `fetch` cannot distinguish that from a blackholed route. The prober therefore measures per-address reachability in cleartext plus host-level end-to-end `wss://`. No claim beyond that appears anywhere in the code or the docs.
3. **`connect()` from the Worker to a Cloudflare-owned address.** Works in this Miniflare harness (~1 ms); whether production refuses it on policy is not verifiable from here. Edge results are scope `edge`, never merged into the Iran-facing ranking, and the `via` field records how the answer was obtained (`tcp` or `http-<status>`).
4. **Per-second refresh.** Cron fires once a minute; all four engine jobs respect the lock and a time budget. Continuous freshness comes from client reports streaming in, not from cron frequency — that is the only honest reading of the platform.
5. **Reputation for `qv_ip_pool`.** Left intact (mirrored from `qv_ip_scores`) so the older surfaces keep working; the zero-deletion rule holds.

---

## 3. Verified results after the pass

```
vitest          15 files / 113 tests        (was 104; +9 for this pass)
self-test       88/88                        (was 82; +6)
smoke           58/58
surface         113 namespaces, 0 unresolved
check_core      8 known false positives (unchanged baseline), 0 unused symbols
bundle          1,807,565 B raw → 999,458 B min → 302,593 B gzip   (64 MiB cap)
D1 bound params 40 rows (80) OK · 50 rows (100) OK · 60 rows (120) → correct, chunked
cold isolate    foreign address rejected · handed-out address accepted
accumulation    1 → 2 → 3 samples across three flushes (never reset)
tunnel signal   101 observed only · authenticated session scored · ?ep=<unknown> refused
decay           two ticks leave a fresh row untouched
ranges          CF 15 v4 / 7 v6 · OVH v6 43→20 (nested merged) · all 9 providers live
```

New tests (`tests/cleanip.test.mjs`, +9): token-carried allow-list; 45-row flush chunking past the parameter limit; counter accumulation across flushes; NAT64 feedback accepted and stored as `v6`; decay does not erode a fresh row; upper-case IPv6 spelling accepted; unauthorised upgrade observed but never scored; authenticated session scores its host; dialled-but-unknown address refused.

New self-test checks (+6): canonical identity; hostname vs address; third-party range validation (wide/bogon/wrong-family/nested); token carries and validates its allow-list (plus empty and oversized rejection); AI output clamping; deterministic heuristic fallback.

---

## 4. Residual risks (unchanged by this pass, stated plainly)

1. **Single-use is per-isolate.** `409 batch-already-used` lives in a 15-minute RAM cache; a token replayed to another colo within that window can still be *re-submitted* — but only about addresses inside its own signed allow-list, so it can no longer fabricate candidates. Making it globally single-use would need D1 or DO state on the hot path; the cost/benefit does not justify it, and the honest description is in the code comment.
2. **A failed look-up costs one tick of ranking accuracy.** With the chunked read, counters always accumulate, but the score/state written in that flush is derived from the delta alone and is refreshed on the next tick (≤60 s). Bound: one tick, never data.
3. **`?ep=` requires a cooperating client.** Without it, tunnel feedback is host-level only — the Worker cannot observe which clean address a client dialled (SNI/Host is the domain). Inventing it would be fabricating a measurement, so it is optional by design.
4. **The buffer is bounded, not lossless.** `REPORT_BUF` caps at 400 keys with FIFO drop; at that point a very hot isolate could drop aggregates before a flush. 400 keys × ~240 B ≈ 96 KB of the 128 MB budget, so the cap could be raised if a deployment ever sees it (counter `ci_flush_rows` and `buffer` in the audit make it visible).
5. **AI remains a suggestion engine.** With `AI_LABEL`/`analyze` enabled, Workers AI can steer *shape, fragmentation, pacing, padding, rotation* — all clamped — and never the endpoint ranking, which stays local and deterministic.
6. **Free-plan D1 query budget.** 50 queries per invocation on the free plan; a flush spends ≤ 2 reads + ≤ 2 batched writes per 40-row chunk. The engine stays inside that, at the cost of draining a large buffer over a few ticks.

---

## 5. Diff

`docs/cleanip-hardening.diff` — 31 hunks, generated with `diff -u` against the tree as it stood before this pass:

| File | Hunks | +/− |
|---|---|---|
| `core/22-cleanip.js` | 23 | +274 / −66 |
| `core/10-antidpi.js` | 4 | +28 / −5 |
| `core/19-legacy-shims.js` | 1 | +13 / −0 |
| `core/40-router.js` | 1 | +8 / −1 |
| `core/12-d1ext.js` | 1 | +4 / −0 |
| `core/42-api.js` | 1 | +1 / −1 |

---

## خلاصهٔ فارسی

**قبل از هر تغییری، کد خوانده شد و یافتهها با شمارهٔ خط ثبت شدند؛ سپس هر یافته با اندازهگیری تأیید و رفع شد.**

**دو باگ بحرانی که واقعاً داده را از بین میبردند:**
1. **سقف ۱۰۰ پارامتر D1** — کوئری تجمیع تا ۳۰۰ پارامتر میفرستاد؛ خطا در `safeAsync` بلعیده میشد و **تاریخِ هر ردیف به اعداد همان دسته ریست میشد**. اثبات تجربی: ۶۰ ردیف → `too many SQL variables`. حالا تکهتکه (۴۰ ردیفی) و **جمعشدن با SQL** انجام میشود: ۱→۲→۳.
2. **لیست مجاز در رم همان isolate بود** — توکن امضاشده قابل حمل است، و در isolate دیگری که آن دسته را نداده بود، شرط `length &&` کوتاه میشد و **هر آیپی پذیرفته میشد**. حالا لیست مجاز **داخل خودِ توکن امضاشده** سفر میکند. اثبات: پاککردن همهٔ کشها → آیپی بیرونی رد، آیپی دادهشده پذیرفته.

**بقیهٔ رفعها:** یکیشدن شکلهای نوشتاری آدرس (جلوگیری از ردیف تکراری در PK)، NAT64 دیگر توسط اعتبارسنج خودمان رد نمیشود، افت امتیاز هر **۱۵ دقیقه** یکبار (قبلاً هر دقیقه)، ایندکس درست، اعتبارسنجی بازههای RIPE/زنده (بازههای تودرتو و bogon حذف)، هدر UA که هرگز ارسال نمیشد، حذف میزبان تکراری در دسته، **کرانگذاری خروجی هوش مصنوعی** (مدل نمیتواند عدد بیرون از محدوده یا shape ناموجود تحمیل کند)، **fallback قطعی** وقتی AI نیست، و **وصلکردن سیگنال واقعی تونل** در نقطهای که احراز هویت و اتصال بالادست موفق شدهاند — نه در ۱۰۱ که *قبل از* احراز هویت است (این خودش یک یافتهٔ امنیتی بود که گزارش و از مسیر امتیازدهی خارج شد).

**آمار پس از کار:** تست ۱۱۳ ✔ · خودآزمون ۸۸/۸۸ ✔ · دود ۵۸/۵۸ ✔ · سطح اجرایی ۰ مورد حلنشده ✔ · بستهٔ فشرده ۲۹۵KiB (۱٫۴٪ سقف).
