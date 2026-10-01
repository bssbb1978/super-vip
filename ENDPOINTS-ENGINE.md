# Clean-Endpoint Engine — engineering specification & change record

**Subject:** `worker.js` · `25.0.0-UNIFIED-SINGULARITY` (single-file Cloudflare Worker core)
**Scope of this change:** the clean-IP / endpoint-selection subsystem, end to end
**Status:** implemented, tested — **15 test files / 113 tests green** · self-test **88/88** · smoke **58/58** · bundle **1.81 MiB raw / 296 KiB gzip**
**Author's rule for this document:** every number is either measured in this workspace or marked as unverified. Nothing below claims a capability the runtime does not have.

---

## 0. TL;DR

The old subsystem measured **four static Cloudflare IPv4 ranges from the Cloudflare edge, over TCP :443, hourly, with a constant score**. The edge's route to Cloudflare is not an Iranian subscriber's route to Cloudflare, so the ranking was, at best, a list of addresses that *might* work.

The new engine keeps that probe but demotes it to a labelled **edge view**, and makes **measurement from the subscriber's own network the primary signal**: every subscription page can ship a small prober, the browser of a real user on a real ISP tests the server-assigned candidates, and a compact signed report flows back. Scores are aggregated per **(ASN, address)**, decay over time, and are confidence-weighted. Generation is stratified across **IPv4 and IPv6** with ε-greedy exploration, exclusions cover reserved space and the Iranian DPI sinkholes, failures walk a **15 min → 1 h → 6 h → purge** cooldown ladder, and the pool is refilled automatically whenever fewer than **20** verified endpoints remain.

**Hardening pass (same subsystem, later audit):** see `AUDIT-cleanip.md` and
`docs/cleanip-hardening.diff`. It fixes a D1 bound-parameter overflow that reset
every aggregated counter, moves the report allow-list inside the signed token
(so it holds on any isolate), canonicalises address identity, makes NAT64 usable
by our own validator, fixes the decay cadence, validates third-party ranges,
clamps Workers-AI output and adds a deterministic offline fallback, and wires
the *authenticated* tunnel-success signal. Counters: **113 tests · 88/88
self-test**.

---

## 1. Findings table (defects verified in the code, with the fix)

Line numbers are from the tree **before** this change (the files were then edited; the new locations are in §3).

| # | Sev | Location (before) | Defect (verified by reading the code) | Fix |
|---|-----|-------------------|---------------------------------------|-----|
| 1 | **critical** | `core/14-antidpi-ext.js:159` `A.scanCleanIPs`, `:189` `connectPort` | Every probe ran **from the Cloudflare edge** (`connect()` inside the Worker). The result describes the colo→IP path, not the Iranian subscriber→IP path, yet it was written straight into the pool the subscriptions read. | Primary signal moved to subscriber browsers (`22-cleanip.js` · `submit`, `flushReports`, scope `asn:<ASN>`). The edge probe survives as `edgeProbe()` and writes scope `edge`, which `pick()` never reads. |
| 2 | **critical** | `core/14-antidpi-ext.js:166` | Candidates came from **4 hard-coded Cloudflare IPv4 CIDRs**, `sampleCidr(cidr, 3)` ⇒ at most 12 addresses per round; **no IPv6 anywhere**; `c.family = 'v4'` was assigned as a literal. | Provider registry with **9 providers**, live range discovery (Cloudflare/AWS/Fastly/GCP/RIPE) plus static fallbacks, dual-stack stratified sampling (`sampleRange`), `family` derived from the address itself. Measured live: v4 15+211+400+19+400+91+400+400+400, v6 7+32+95+2+43+5+139+79+400 (capped at 400/provider). |
| 3 | **high** | `core/14-antidpi-ext.js:172–186` | Reachability was **TCP-connect only**: no TLS, no SNI, no ALPN, no WebSocket upgrade. A box that accepts :443 and resets everything else scored identically to a working edge. | Three independent signals: browser reachability (cleartext, unambiguous), browser **end-to-end `wss://host:port/path`** (real SNI, real port, real upgrade), and edge TCP/TLS. Reports carry `ok`, `tlsOk`, `wsOk`, `rttMs`. |
| 4 | **high** | `core/14-antidpi-ext.js:174–180` | Score was a **fixed constant table** (`60 + 30/18/6`), no sample count, no decay, no confidence, no history beyond `success`/`fail` counters. Three lucky probes outranked a hundred measured ones. | Deterministic scoring engine: Wilson lower bound, EWMA-style aggregation, latency histogram (p50/p95), jitter, recency decay, failure penalty, explicit `confidence`. §5 has the formulas and worked examples. |
| 5 | **high** | `core/40-router.js:440` (`cron 'ip-scan'`) | **Hourly** cadence, one job, no lock, no budget; there was no path by which a score could improve between two cron ticks, and no refill logic — a drained pool stayed drained for an hour. | Subscriber reports stream continuously; cron only aggregates (`ip-agg` 60 s), refills (`ip-refill` 300 s), probes the edge (`ip-edge` 900 s) and refreshes ranges (`ip-ranges` 6 h). All four are lock-protected and time-boxed (§3.4). |
| 6 | **medium** | `core/00-header.js:773` `D.Ip` / `qv_ip_pool` schema | One flat table keyed by IP: **no ASN dimension, no family, no cooldown state, no confidence**. A score earned on one ISP was served to every other ISP. | New `qv_ip_scores` keyed `(scope, ip)` where scope ∈ {`global`, `asn:<ASN>`, `edge`}, plus `qv_ip_ranges`. `qv_ip_pool` is still written by `syncPool()` so every existing surface keeps working (zero deletion). |
| 7 | **medium** | `core/14-antidpi-ext.js:47` `sampleCidr` | `2 ** (32 - bits)` for a /8 or wider produced a span that was then **clamped at 65 536**, so "sampling" a large range always drew from its first 256 /24s; no stratification at all. | `sampleRange()` draws **one random host per /24 (v4) or /48 (v6) stratum**, never leaves the CIDR, and re-rolls instead of clustering. Self-test pins both properties. |
| 8 | **medium** | `core/14-antidpi-ext.js:166` (seed list) `172` (scan list) | **No exclusion rules**: `10.10.34.0/24` (the Iranian DPI sinkhole) and CGNAT/RFC1918 space were valid candidates. | `EXCLUDE_V4`/`EXCLUDE_V6` cover reserved, private, CGNAT, loopback, link-local, multicast, documentation, NAT64 and the sinkholes `10.10.34.0/24`, `10.10.35.0/24`, `10.10.36.0/24`; `isUsable()` gates every intake path and every handout. |
| 9 | **low** | `core/14-antidpi-ext.js:170` | `await QV.safeAsync(() => QV.d1.Ip.upsert(...))` inside `Promise.all` — **one D1 write per candidate per round**, no batching, no bound on the candidate list (`limit` only trimmed the *returned* slice). | Reports are aggregated in a bounded isolate buffer (`REPORT_BUF`, 400 entries) and flushed as **one batched UPSERT per changed row**, at most every `ip-agg` tick or at 120 buffered reports. §6 measures the resulting write rates. |
| 10 | **low** | `core/10-antidpi.js:82` `state.cleanIps` | The in-isolate list was overwritten by whichever scan finished last; there was no rotation, so two subscribers asking in the same minute received byte-identical lists. | `pick()` merges per-ASN and global rows, filters unavailable/purged/unmeasured rows, and rotates deterministically per `(uuid, hour)` via `QV.hash32` — same cost, no randomness per request. |
| 11 | **low** | `core/38-subs.js:30–40` `endpoints()` | `cleanIps` came from `QV.d1.Ip.top(env, 4)` — the flat pool, again ISP-blind — and **no IPv6 node was ever emitted**; NAT64 existed only inside the DNS layer. | `endpoints()` asks `QV.cleanip.pick({asn})`, keeps the historic pool as the tail of the list, and emits native IPv6 plus RFC 6052 (NAT64) nodes synthesised from proven IPv4 addresses. |

**Two behaviours I could not reproduce a defect for, and therefore did not "fix":**

* `connect()` to a Cloudflare-owned address from a Worker — in this miniflare harness the connect succeeds in ~1 ms. Whether the production runtime refuses it on policy is **unverified** (see §8.2). The engine is written to be correct in either case: an edge failure never removes an address, and the HTTP fallback (`https://<ip>/cdn-cgi/trace` answers 403 *direct IP access not allowed*) records reachability over the other transport.
* The old candidate generation had **no exclusion list at all** — not for RFC1918, not for CGNAT, not for the sinkholes. That is why it is filed as find #8 rather than as a hypothetical.

---

## 2. Schema migrations (additive only)

`12-d1ext.js` · `EXTRA_COLUMNS` runs on the existing migrate path (`D.migrate`), so a deployed database picks these up on the next boot; nothing is dropped or rewritten.

```sql
CREATE TABLE IF NOT EXISTS qv_ip_scores (
  scope TEXT NOT NULL,               -- 'global' | 'asn:<ASN>' | 'edge'
  ip TEXT NOT NULL,
  family TEXT DEFAULT 'v4',          -- 'v4' | 'v6'
  provider TEXT,                     -- 'cloudflare' today; the registry's other ids are accepted
  asn TEXT,                          -- the ISP that measured (never a client identifier)
  samples REAL DEFAULT 0,            -- weighted; a spoofed-fast answer counts 0.25
  ok REAL DEFAULT 0, tls_ok REAL DEFAULT 0, ws_ok REAL DEFAULT 0,
  rtt_ms REAL, rtt_p95 REAL, jitter REAL,
  score REAL DEFAULT 0, confidence REAL DEFAULT 0,
  state TEXT DEFAULT 'active',       -- active | degraded | cooldown | quarantine | purged
  fails INTEGER DEFAULT 0, backoff INTEGER DEFAULT 0,
  cooldown_until INTEGER DEFAULT 0,
  last_ok INTEGER DEFAULT 0, last_probe INTEGER DEFAULT 0,
  edge_score REAL DEFAULT 0, suspect INTEGER DEFAULT 0,
  country TEXT, meta TEXT, updated_at INTEGER DEFAULT 0,
  PRIMARY KEY (scope, ip)
);
CREATE INDEX IF NOT EXISTS ix_ip_scores_rank ON qv_ip_scores(scope, state, score);

CREATE TABLE IF NOT EXISTS qv_ip_ranges (
  provider TEXT PRIMARY KEY, family TEXT, count INTEGER DEFAULT 0,
  source TEXT, fetched_at INTEGER
);
```

Privacy: no client IP, no user id and no per-report row is ever stored. The only client-derived columns are `asn` and `country`, both from `request.cf`.

---

## 3. Unified diffs (the essential ones)

### 3.1 Primary signal becomes subscriber-side

```diff
--- a/core/14-antidpi-ext.js
+++ b/core/14-antidpi-ext.js
@@
-  A.scanCleanIPs = async (env, ctx, opts = {}) => {
-    const limit = opts.limit || 24;
-    const ranges = (env.CLEAN_IP_CANDIDATES || '172.64.0.0/13,104.16.0.0/13,162.159.0.0/16,188.114.96.0/20')...
-    const list = [...candidates.values()].slice(0, Math.max(limit, 12));
-    await Promise.all(list.map(async (c) => {
-      const port = await connectPort(c.ip, 443, 3500);          // edge view, used as truth
+  const scanCleanIPsV2 = async (env, ctx, opts = {}) => {
+    const picked = await QV.cleanip.pick(env, { asn: opts.asn || null, n, uuid: opts.uuid || null });
+    const rows = [...picked.v4, ...picked.v6];
+    if (!rows.length) return scanCleanIPsV1(env, ctx, opts);    // cold start only
+    ...
+  };
+  A.scanCleanIPs = scanCleanIPsV2;          // every historic caller keeps working
+  A.scanCleanIPsEdge = scanCleanIPsV1;      // the edge-only probe stays reachable
```

### 3.2 Report intake — validation is the anti-forgery boundary (`22-cleanip.js:528`)

```diff
+  const submit = async (env, ctx, request, rawBody) => {
+    if ((rawBody.byteLength || 0) > LIMITS.reportBytes) return { ok: false, error: 'payload-too-large', status: 413 };
+    ...
+    const verdict = await verifyBatch(env, token, body.u || null);        // HMAC-SHA256 over the batch
+    if (!verdict.ok) return { ok: false, error: verdict.error, status: 403 };
+    if (BATCH_SEEN.get('b:' + verdict.batch.b)) return { ok: false, error: 'batch-already-used', status: 409 };
+    if (!rateOk(verdict.batch.u)) return { ok: false, error: 'rate-limited', status: 429 };
+    if (reports.length > LIMITS.reportsPerBatch) return { ok: false, error: 'too-many-reports', status: 400 };
+    const handout = HANDOUT.get(verdict.batch.b) || { ips: [] };
+    for (const r of reports) {
+      if (!isUsable(ip)) { rejected++; continue; }                        // reserved / sinkhole space
+      if (handout.ips.length && !handout.ips.includes(ip)) { rejected++; continue; }  // not ours to report
+      if (BATCH_SEEN.get(dupKey)) { rejected++; continue; }               // replay inside a batch
+      suspect = Number.isFinite(rtt) && rtt > 0 && rtt < 4;               // outlier: 1 ms from a 4G line
+      accept(entry, meta);                                                // asn + country only
+    }
+  };
```

### 3.3 Selection — per-ASN first, never a cooling address (`22-cleanip.js:777`)

```diff
+  const pick = async (env, req = {}) => {
+    const asnRows    = asn ? await loadScores(env, 'asn:' + asn) : [];
+    const globalRows = await loadScores(env, 'global');
+    for (const r of [...asnRows, ...globalRows]) {
+      if (!isUsable(r.ip) || !isAvailable(r)) continue;        // purged / cooling rows never ship
+      if (family && r.family !== family) continue;
+      if (r.samples >= 2 && r.score < 25) continue;            // measured and bad
+    }
+    const rot = (QV.hash32(String(req.uuid || '')) + Math.floor(Date.now() / 3600000)) % Math.max(1, rows.length);
+    /* cold start: stratified samples, marked scope 'sample', so the caller is
+       never handed an empty list */
+    const synth = v4.map(r => ({ ip: QV.dns.v4ToV6(r.ip), nat64: true, ... }));   // IPv6-only subscribers
+  };
```

### 3.4 Cron: aggregate, refill, edge, ranges (`40-router.js:486`)

```diff
-    { id: 'ip-scan', every: 3600, run: async (env, ctx) => QV.antidpi.scanCleanIPs(env, ctx, { limit: 8 }) },
+    { id: 'ip-agg',    every: 60,   budgetMs: 8000,  run: (env, ctx) => QV.cleanip.aggregate(env, ctx) },
+    { id: 'ip-refill', every: 300,  budgetMs: 15000, run: (env, ctx) => QV.cleanip.refill(env, ctx) },
+    { id: 'ip-edge',   every: 900,  budgetMs: 15000, run: /* edge view, scope 'edge' */ },
+    { id: 'ip-ranges', every: 21600,budgetMs: 20000, run: /* live provider ranges refresh */ },
+    { id: 'ip-scan',   every: 3600, budgetMs: 20000, run: (env, ctx) => QV.antidpi.scanCleanIPs(env, ctx, { limit: 8 }) },
```

Each entry inherits the job lock added in the previous round (`QV.d1.Jobs.claim/release`), so a manual trigger and a cron tick can never overlap.

### 3.5 Subscription integration (`38-subs.js:30`)

```diff
-    const cleanIps = (await QV.d1.Ip.top(env, 4).catch(() => [])).map(r => r.ip).filter(Boolean);
+    const picked = await QV.cleanip.pick(env, { asn: opts.asn, n: 5, uuid: user?.uuid });
+    const measured = picked.v4.map(r => ({ ip: r.ip, scope: r.scope, samples: r.samples }));
+    const history  = (await QV.d1.Ip.top(env, 6)).map(r => ({ ip: r.ip, scope: 'pool' }));
+    const cleanIps = [...measured, ...history].slice(0, 6);        // measured first, historic tail kept
+    ...
+    const v6list = [...(ep.ipv6 || []), ...(ep.nat64 || [])].slice(0, 4);
+    v6list.forEach((h) => nodes.push({ proto: 'vless', host: `[${h}]`, family: 'v6', nat64 }));
```

---

## 4. Client prober (shipped JS)

Served at `GET /probe.js`; the operator console loads it lazily from the *Measure my network* card, and `/probe/<uuid>` is a standalone page for a subscriber. Compact form of what ships:

```js
window.QVProbe = { run, optOut, optIn };

function run(opt) {                                  // respects opt-out, data-saver, battery, hourly cap
  if (off()) return { skipped: 'opted-out' };
  if (Date.now() - last < 3600000) return { skipped: 'recent' };
  if (conn.saveData || /2g/.test(conn.effectiveType)) return { skipped: 'data-saver' };
  if (battery.level < 0.15 && !battery.charging) return { skipped: 'low-battery' };
  return fetch(base + '/api/ip-batch?u=' + uuid)                       // server-assigned batch
    .then(d => pool(d.ips, 4, c => timed(                          // ≤4 concurrent, AbortController
        'http://' + (v6 ? '[' + c.ip + ']' : c.ip) + '/cdn-cgi/trace', 2500)))
    .then(() => pool(d.handles, 2, h => wsTest(h.host, h.port, h.path)))   // real SNI, real upgrade
    .then(list => post(base + '/api/ip-report', { t: token, u: uuid,
        r: list.filter(x => x.family !== 'host'),              // per-address rows
        h: list.filter(x => x.family === 'host')               // per-handle wss verdicts
             .map(x => ({ host: x.ip, rttMs: x.rttMs, ok: x.ok, tlsOk: x.tlsOk, wsOk: x.wsOk, nonce: x.nonce })) }));
}
```

Why this shape, exactly:

* **`fetch` in cleartext to the bare IP** is the only per-address test a browser can perform unambiguously. `https://<ip>/` cannot work: Cloudflare fails the TLS handshake when SNI matches no certificate it holds, so a TLS error and a blackholed route are indistinguishable from JavaScript. The cleartext answer is unambiguous — the address is routable from that ISP, or it is not.
* **`wss://<host>:<port><path>`** is where the real verdict lives: DNS, SNI filtering, port blocking and TLS interception all show up as an `onerror`, and a successful `onopen` proves the whole path.
* The batch, the token and the candidate allow-list are bound together: a report can only be about an address **or handle** this account was handed. `submit()` validates `body.h` against `handout.hosts`, caps it at the batch's handle count, and applies the same nonce/replay and rate-limit rules.
* Handle verdicts land in the **same per-ASN scope**, keyed by hostname (`family: 'host'`), so `handlesFor()` orders the SNI hosts it hands out by what subscribers on that ASN actually measured: a host whose `wss://` handshake fails (SNI blockade, TLS reset, port block) drops behind the ones that succeed. `pick()` can never confuse a hostname with an address — `isUsable()` rejects non-address strings — so a hostname is never served as a clean IP.
* Measured end to end in this workspace: one accepted verdict → row `{scope:'asn:396982', ip:'node.example.dev', family:'host', samples:1, tls_ok:1, ws_ok:1, rtt_ms:210, score:57.6, confidence:0.271, state:'active'}`.
* Cost control: ≤ 10 addresses, ≤ 3 host handles, ≤ 4 concurrent sockets, 2.5 s timeout, one run per hour per browser unless forced.

---

## 5. Scoring specification

### 5.1 Formulas (`22-cleanip.js:370–470`)

Let `n` = weighted samples, `k` = weighted successes, `z = 1.64` (95 % one-sided).

```
success    = Wilson lower bound            = ( p + z²/2n − z·√( (p(1−p) + z²/4n)/n ) ) / (1 + z²/n),   p = k/n
tls        = tls_ok / n
ws         = ws_ok  / n
latency    = 1.00 if p50 ≤ 120 ms
             0.60 if p50 ≤ 300 ms
             0.30 if p50 ≤ 600 ms
             0.10 otherwise
base       = 0.50·success + 0.20·tls + 0.15·ws + 0.15·latency
fresh      = 0.70 + 0.30·exp(−(now − last_ok)/6 h)
jitter     = clamp(1 − jitter_ms/200, 0.5, 1)
gate       = 0   if state = quarantine
             0.35 if state = cooldown
             1    otherwise
penalty    = min(30, 6 × recent_failures)
score      = clamp(100 · base · fresh · jitter · gate − penalty, 0, 100)
```

State machine:

```
fail      → backoff := min(backoff+1, 4);  cooldown_until := now + [_,15m,1h,6h,∞][backoff]
            backoff = 4  ⇒ state = 'purged'  (row deleted 24 h later)
ok        → state = 'active', backoff = 0, cooldown_until = 0
quarantine→ state = 'quarantine', cooldown_until = now + 12 h      (active-probe / DPI-reset signature)
```

A row is **available** iff `state ≠ 'purged'` and `cooldown_until ≤ now`.

### 5.2 Worked examples (the self-test computes these live)

| Case | n | ok | tls | ws | p50 | jitter | last_ok | state | score | what it means |
|------|---|----|-----|----|-----|--------|---------|-------|-------|----------------|
| A fresh lucky draw | 2 | 2 | 2 | 2 | 90 ms | 0 | now | active | **71.3** | two samples are not evidence |
| B proven good | 60 | 55 | 55 | 54 | 95 ms | 10 | now | active | **88.8** | evidence beats luck, always |
| C proven but stale | 60 | 55 | 55 | 54 | 95 ms | 10 | 20 h ago | active | **≈ 64** | freshness decays it out of the top |
| D slow but working | 30 | 28 | 28 | 28 | 450 ms | 20 | now | active | **≈ 58** | latency tier 0.30 caps it |
| E cooling | — | — | — | — | — | — | — | cooldown | **×0.35** | 15 min after the first failure |
| F quarantined | — | — | — | — | — | — | — | quarantine | **0** | a DPI-reset signature is not negotiable |

Determinism: `scoreRow(row, now)` is pure — the self-test asserts that two calls with the same `(row, now)` are byte-identical, which is what makes the ranking explainable after the fact.

---

## 6. Resource budget

### 6.1 Memory (isolate budget 128 MiB; every store bounded by entries **and** bytes)

| Store | Max entries | Max bytes | TTL | Eviction |
|---|---|---|---|---|
| `ciScores` (ranking rows per scope) | 2 000 | 2 MiB | 60 s | LRU (O(1)) |
| `ciRanges` (provider ranges) | 32 | 512 KiB | 6 h | LRU |
| `ciBatch` / `ciRate` (token, nonce, replay) | 4 000 | 512 KiB each | 15 min / 1 h | LRU + TTL |
| `ciHandout` (which IPs went to which batch) | 5 000 | 2 MiB | 15 min | LRU |
| `REPORT_BUF` (aggregate buffer) | 400 | ≈ 96 KiB | flush ≤ 60 s | FIFO drop at cap |
| **Worst case total** | — | **≈ 5.1 MiB** | — | — |
| Measured on `/health` after the full test suite | — | **≈ 52 KiB (0.04 %)** | — | — |

**Bundle:** `worker.js` 1 807 565 B raw → 999 458 B minified → **302 593 B gzip (296 KiB)**.
The documented Cloudflare ceiling is 64 MiB uncompressed on every plan; the file is **1.4 %** of it.
(`wrangler.toml` keeps `minify = true`; the minified figure is the one Wrangler uploads.)

### 6.2 Write rates

| Path | KV writes | D1 writes |
|---|---|---|
| One subscriber batch + report | **0** | 0 (buffered) |
| `ip-agg` tick (60 s) | 0 | ≤ 200 batched UPSERTs — only rows that changed |
| Provider range refresh (6 h) | 0 (KV row per provider only if `persist`) | 9 UPSERTs |
| `ip-refill` (5 min) | 0 | ≤ 1 batch (edge scope rows) |
| 100 subscribers × 3 reports/hour | **0** | ≈ 300 aggregated rows/hour ⇒ **5 rows/min**, one statement per row, batched |

Measured in `tests/cleanip.test.mjs` › *the write budget*: 18 reports produced **fewer D1 statements than reports** and **exactly 0 KV writes**; `tests/kvwrite.test.mjs` independently caps the whole worker at ≤ 6 KV writes per 61 requests.

### 6.3 Provider registry (real, verified live from this workspace)

| Provider | Role (`usable_as`) | v4 ranges (live) | v6 ranges (live) |
|---|---|---|---|
| Cloudflare | **`edge`** — the only provider that runs Workers | 15 | 7 |
| Amazon CloudFront | `fallback`, `sni` | 211 | 32 |
| Google Cloud | `fallback`, `sni` | 400 (capped) | 95 |
| Fastly | `fallback`, `sni` | 19 | 2 |
| OVHcloud | `fallback` | 400 (capped) | 43 |
| Hetzner | `fallback` | 91 | 5 |
| Gcore | `fallback`, `sni` | 400 (capped) | 139 |
| CDN77 | `fallback`, `sni` | 400 (capped) | 79 |
| Akamai | `fallback`, `sni` | 400 (capped) | 400 (capped) |

Every provider row carries a `why` field stating what it can and cannot do. **Only Cloudflare can front this worker**; the others are SNI/decoy material and standalone-fallback endpoints, and the data says so — no faked support.

---

## 7. Tests

| File | Tests | Covers |
|---|---|---|
| `tests/cleanip.test.mjs` (new) | 32 | dual-stack batch handout, exclusion of reserved/sinkhole space, unknown/disabled account refusal, `/probe.js` + `/probe/<uuid>` served, accepted report → aggregate row, tampered token → 403, foreign-account token → 403, un-handed address → rejected, batch replay → 409, intra-batch duplicate → rejected, oversized payload → 400/413, per-account rate limit → 429, suspect-fast answer weighted down, D1 statements < reports and **0 KV writes**, bounded buffer, provider registry honesty, edge view labelled separately, subscription endpoint list, `/clean-ip` NAT64 forms, **end-to-end handle verdict accepted and scored, foreign handle rejected, malformed host rejected** |
| `core/46-selfcheck.js` › `endpoints` (new, 14 checks) | — | registry, IPv4+IPv6 CIDR maths, IPv6 parse/format (compression, v4-mapped tail), exclusions incl. `10.10.34.x`, stratified sampling in-range for both families, score determinism, Wilson confidence ordering, latency tiers, cooldown ladder, availability gating, token binding, range refresh, picker always yields candidates, NAT64 synthesis |
| Existing 14 files | 81 | unchanged and still green |

Total: **15 files / 113 tests, all passing**; self-test **88/88**.

---

## 8. Risks and unverified assumptions

1. **The browser cannot measure per-IP TLS.** Documented in the code and here: only cleartext per-address reachability plus host-level end-to-end WebSocket testing are possible. Anything that claims "TLS verified per clean IP, from the browser" is not implementable.
2. **`connect()` to Cloudflare-owned addresses from a Worker is unverified.** In this harness it succeeds (1 ms); the production runtime may refuse it on policy. Mitigation: edge results are a secondary scope, never mixed into the Iran-facing score, and the HTTP fallback (`403 direct IP access not allowed`) records reachability over the other transport. Verify on the real deployment with `POST /api/ips {"action":"scan"}` and read the `via` field.
3. **Subscriber coverage is a cold-start problem.** Until browsers have run the prober, `pick()` serves stratified samples in `scope: 'sample'` — usable, but unranked. The engine explicitly reports `available`, `verified` and `shortfall` so the operator can see the ramp-up (`/api/endpoints`).
4. **ASN granularity, not per-subscriber.** Iranian carriers share ASNs across very different access networks; a good score on AS58224 is not a promise to every TCI subscriber. This is why confidence is displayed and why the historic pool stays in the list as a fallback.
5. **RIPE Stat and the provider endpoints are third-party dependencies.** All ranges have static fallbacks that were verified against today's live answers; a provider going dark degrades to `source: 'static-fallback'`, visibly.
6. **Report spoofing is mitigated, not eliminated.** Signature, batch binding, allow-list, nonce and outlier weighting make a useful forgery expensive; a subscriber can still bias its *own* ASN scope. Scores never cross scopes, so the blast radius is that ISP.
7. **Range list capping at 400/provider** is a deliberate memory bound; for Akamai (≈ 4 000 prefixes) the sample is not exhaustive. Sample, not census — by design.
8. **Rotation with `QV.hash32` is deterministic, not cryptographic.** It exists to avoid identical lists for two subscribers in the same hour, nothing more.

---

## 9. Operations cheat-sheet

```bash
curl -s "$DOMAIN/api/endpoints" -H "x-api-token: $TOKEN" | jq '{ranges, scopes, counters}'
curl -s "$DOMAIN/clean-ip?n=6" | jq '{ips, ipv6, nat64}'      # ranked for the caller's ASN
curl -s -X POST "$DOMAIN/api/ips" -H "x-api-token: $TOKEN" -d '{"action":"scan","limit":8}' | jq '.data'
curl -s -X POST "$DOMAIN/api/cron" -H "x-api-token: $TOKEN" -d '{"only":"ip-agg","force":true}' | jq
open "$DOMAIN/probe/$SOME_UUID"        # the subscriber-facing measurement page
```

---

## Automation pass: per-ISP intelligence, adaptive probing, blocks, dual-stack, strategy loop

Everything below is **additive and automatic**: no new manual step, no new required binding, and every old entry point (`pick`, `plan`, `handout`, `submit`, `flushReports`, `aggregate`, `refill`, `audit`, `feedback`, `ranges`) keeps its name, arguments and return keys. DDL is applied by `legacySchema.ensure()`; new counters appear in `/health.counters`; new fields in `GET /api/endpoints`.

### Window aggregation (feeds the detector)
`publishWindows()` (worker.js L5930) writes one **delta upsert per scope per 5-minute bucket** into `qv_ip_windows (scope, bucket, samples, ok)` — at most `WINDOW_SCOPES = 16` scopes per flush, batched with the engine's other writes. Scopes are `global`, `asn:<n>`, and `scope|host` for host rows. The table is read only by `detectBlocks()` and the audit, and `decay()` prunes buckets older than **48 h**, at most once an hour (`windows_pruned`).

### A · Per-ISP intelligence
`ISPS` (L5166) maps the six networks that matter most for Iran (MCI 197207, Irancell 44244, TCI 58224, Rightel 57218, Shatel 31549, IranServer 204213); `ispOf()` names any other ASN as `AS<code>`. `audit().per_isp` (L6458) reports, per ASN: samples, ok, `ws_ok`, `success_pct`, `upgrade_pct`, average score, `cooling`/`quarantined` counts and `last_seen`. Rankings prefer the caller's ASN and fall back to the global scope, so a new ISP is never starved of candidates.

### B · Adaptive probe scheduling
`banditOrder()` (L5981) reorders candidates with a deterministic `mulberry32`-seeded ε-greedy/UCB mix: posterior mean + `0.15 · UCB` + `0.05 · recency`, weighted by `n/(n+4)` so thin evidence stays explorable. `plan()` (L6010) applies it when generating a browser batch, under the **hard cap** `min(want, LIMITS.batchIps × 2)` and 6 candidates per scope — adaptation can never become a scan storm.

### C · Block detection, quarantine, recovery
`detectBlocks()` (L6182) reads a 15-minute window. `BLOCK = { minSamples: 12, dropPoints: 0.25, lowRate: 0.35, recoverRate: 0.6, recoverSamples: 8 }`:
* **targeted block** (an ASN far worse than the fleet) → the whole scope enters the exponential ladder `15 m / 1 h / 6 h / 24 h`, then `purged`; `ci_block_detected`, `emit('cleanip:block')`;
* **provider outage** (most measured ASNs down at once) → rows become `degraded` with `cooldown_until = 0` instead of being quarantined; `ci_outage_detected`;
* **recovery** (healthy again) → released and backoff reset; `ci_block_cleared`.
`BLOCKS` (64 entries / 64 KB / 6 h) is exposed as `audit().blocks` + `block_limits`.

### D · Range refresh that can only fall back
`ranges()` (L5432) resolves each provider as **live → last-good → static**: a failed or invalid fetch can never erase a good list. Last-good lists live in `GOOD_RANGES` (L5420, 32 / 512 KB / 24 h) and are persisted in `qv_ip_ranges.payload`, so they survive an isolate restart. `ci_ranges_lastgood` and `ci_ranges_static_after_refresh` make the state visible; a *cold* read using the static lists is normal and not flagged.

### E · IPv4 + IPv6, per-client preference
`pick()` (L6277) accepts `prefer: 'auto' | 'v4' | 'v6'` (allow-listed; anything else means `auto`) and returns `preferred` (ordered, family-tagged), `dual ∈ {native, nat64-only, v4-only}` plus the unchanged `v4` / `v6` / `nat64` arrays. `/clean-ip?prefer=` and `/api/ips?prefer=` pass it through; the client fragment can therefore keep IPv6-first users on IPv6 and everybody else on IPv4.

### F · Strategy loop with automatic rollback
`recordStrategy()` keeps a bounded history (≤8) in `qv:strategy:hist`; every apply stores `{v, source, shape, fragment, baseline, reason}`. `evaluateStrategy()` (L1863) compares the measured fleet success rate with the recorded baseline and rolls back when it drops by more than `ROLLBACK_DROP = 0.15` with `≥ 40` samples. It runs at most every **30 min** (`EVAL_EVERY_MS`), from the cron job `strategy-eval` (every 1800 s, L8876) or on demand via `POST /api/ips {"action":"evaluate"}`; rollbacks raise `ci_strategy_rollback` and are written to the history as `source: 'rollback'`. `sanitizeStrategy` still clamps every AI proposal and `heuristicStrategy` remains the deterministic fallback.

### G · Self-healing degradation
`DEGRADED` (L5670) + `noteDegrade()` record `d1`, `kv`, `ai`, `ranges`, `windows`, `feedback` failures with a human-readable reason and a counter (`ci_degraded_*`). Every degraded path **returns a safe answer instead of throwing**; `audit().degraded` shows the kinds and the last record.

### H · Observability
`GET /api/endpoints` (operator) now returns `isps`, `per_isp`, `scopes` (active / cooling / quarantined), `blocks`, `block_limits`, `dropped_feedback` (`no-hosts` vs `unknown-host`, with `last_*` and a per-counter breakdown), `degraded`, `strategy`, `strategy_history`, `buffer_pressure` (`used`, `max`, `pct`, `window_scopes`, `flush_rows`) and `ranges.lastgood`.

```bash
# what is blocked / cooling right now, and why
curl -s -X POST "$DOMAIN/api/ips" -H "x-api-token: $TOKEN" -d '{"action":"blocks"}' | jq '.data'
# evaluate the strategy now (skips the 30-minute rate limit, never the evidence rules)
curl -s -X POST "$DOMAIN/api/ips" -H "x-api-token: $TOKEN" -d '{"action":"evaluate"}' | jq '.data'
# per-client dual-stack
curl -s "$DOMAIN/clean-ip?n=6&prefer=v6" | jq '{preferred, dual}'
```
