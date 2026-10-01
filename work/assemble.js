#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * assemble.js — build /home/user/worker.js from core/ + the 11 legacy units
 * ═══════════════════════════════════════════════════════════════════════════
 *  Usage:
 *    node assemble.js --core-only            → dist/core-only.js  (no units)
 *    node assemble.js                        → /home/user/worker.js (full)
 *    node assemble.js --out some/file.js
 *    node assemble.js --no-units             → core + router only
 *
 *  Unit hosting strategy (guarantees the zero-deletion rule):
 *    Each unit is wrapped in its own scope:
 *        const __QF_UNIT_00 = (() => { ...unit source verbatim... })();
 *    Unit sources have NO imports/exports left (they were neutralised in
 *    src_m1.js), so wrapping cannot break their internal semantics.
 *    A lazy bridge object __QF exposes every top-level declaration of every
 *    unit to the whole file, in declaration order, so the *original* call
 *    order semantics survive: the first unit that defines a name wins, and
 *    duplicate later definitions are still reachable under `__QF.all(name)`.
 * ═══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { unresolvedIn, unitTopDeclared, unitAllRefs, GLOBALS } = require('./unit_symbols.js');

const ROOT = __dirname;
const OUT_DEFAULT = '/home/user/worker.js';

const args = process.argv.slice(2);
const flag = (name, dflt = false) => (args.includes(name) ? true : dflt);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const CORE_ORDER = [
  '00-header.js',
  '01-i18n.js',
  '02-utils.js',
  '03-polyfills.js',
  '05-env.js',
  '10-antidpi.js',
  '12-d1ext.js',
  '14-antidpi-ext.js',
  '15-crypto.js',
  '16-ai-ext.js',
  '17-local-ai.js',
  '18-antidpi-extra.js',
  '19-legacy-shims.js',
  '20-shadowsocks.js',
  '22-cleanip.js',
  '25-dns.js',
  '27-dns-extra.js',
  '30-telegram.js',
  '38-subs.js',
  '40-router.js',
  '42-api.js',
  '44-qr.js',
  '44-panels.js',
  '45-compat.js',
  '46-selfcheck.js',
  '98-entry.js',
];

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } };

/* ---------- 1. core ---------------------------------------------------- */
const coreParts = [];
for (const f of CORE_ORDER) {
  const p = path.join(ROOT, 'core', f);
  if (!exists(p)) { console.error(`✖ missing core file: ${f}`); process.exit(2); }
  coreParts.push(`\n/* ═══════════ ${f} ═══════════ */\n` + read(p));
}
let core = coreParts.join('\n');

/* the header carries the single cloudflare:sockets import — hoist it to the very
   top so the module stays valid no matter how parts are ordered */
const importRe = /^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:sockets['"];\s*$/m;
const importMatch = core.match(importRe);
let header = '';
if (importMatch) {
  header = `import {${importMatch[1]}} from 'cloudflare:sockets';\n`;
  core = core.replace(importRe, '/* cloudflare:sockets imported at the top of this file */');
}

/* ---------- 2. units -------------------------------------------------- */
const unitsDir = path.join(ROOT, 'units');
const unitFiles = exists(unitsDir)
  ? fs.readdirSync(unitsDir).filter(f => /^u\d+\.js$/.test(f)).sort()
  : [];

/* collect top-level names of each unit so the bridge can expose them */
const collectTopLevel = (src) => {
  const names = new Set();
  let ast = null;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (e) {
    return { names, parseError: e.message };
  }
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      if (node.id) names.add(node.id.name);
    } else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier') names.add(d.id.name);
        else if (d.id.type === 'ObjectPattern') for (const pr of d.id.properties) if (pr.value?.type === 'Identifier') names.add(pr.value.name);
        else if (d.id.type === 'ArrayPattern') for (const el of d.id.elements) if (el?.type === 'Identifier') names.add(el.name);
      }
    }
  }
  return { names };
};

/* ─────────────────────────────────────────────────────────────────────────
 * Top-level statement splitter.
 *   The merged bundles contain top-level side effects: banner console.log()s,
 *   a CommonJS export block and — in u10 — three `await test…()` calls.  An
 *   `await` at the top level of a wrapped IIFE is a syntax error, and module
 *   scope in workerd forbids I/O, timers and randomness, so those statements
 *   are lifted verbatim into a per-unit side-effect runner that executes once,
 *   guarded, on the first request.  Nothing is dropped: every statement still
 *   runs, just in a legal context and without being able to break startup.
 * ───────────────────────────────────────────────────────────────────────── */
const SAFE_TOP = new Set(['FunctionDeclaration', 'ClassDeclaration', 'VariableDeclaration', 'EmptyStatement']);
const splitTopLevel = (src) => {
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (e) { return { kept: src, deferred: [], error: e.message }; }
  const kept = [], deferred = [];
  for (const node of ast.body) {
    const text = src.slice(node.start, node.end);
    /* a directive prologue ("use strict") must stay exactly where it is */
    const isDirective = node.type === 'ExpressionStatement' && node.expression.type === 'Literal' && typeof node.expression.value === 'string';
    if (SAFE_TOP.has(node.type) || isDirective) kept.push(text);
    else deferred.push({ text, line: src.slice(0, node.start).split('\n').length, type: node.type });
  }
  return { kept, deferred };
};

const unitMeta = [];
const unitParts = [];
if (!flag('--no-units') && !flag('--core-only') && unitFiles.length) {
  unitParts.push(`
/* ═══════════════════════════════════════════════════════════════════════════
 * B · GENERATION UNITS — the eleven original editions, hosted in isolation
 *     (every line preserved; nothing removed, nothing rewritten)
 * ═══════════════════════════════════════════════════════════════════════════ */`);
  unitFiles.forEach((f, i) => {
    const src = read(path.join(unitsDir, f));
    const tag = f.replace(/\.js$/, '');
    const key = `__QF_UNIT_${tag}`;
    const { names, parseError } = collectTopLevel(src);
    unitMeta.push({ index: i, file: f, key, names: [...names], bytes: src.length, parseError });
    if (parseError) console.error(`✖ unit ${f} does not parse: ${parseError}`);
    const split = splitTopLevel(src);
    const missing = splitTopLevel.ok === false ? [] : unresolvedIn(split.deferred || [], names);
    unitMeta[unitMeta.length - 1].deferred = split.deferred ? split.deferred.length : 0;
    unitMeta[unitMeta.length - 1].missing = missing;
    const body = split.kept ? split.kept.join('\n') : src;
    const RESERVED = new Set(['default', 'class', 'function', 'const', 'let', 'var', 'new', 'delete', 'in', 'of', 'do', 'if', 'else', 'for', 'while', 'return', 'typeof', 'instanceof', 'void', 'this', 'super', 'import', 'export', 'extends', 'yield', 'await', 'case', 'catch', 'try', 'finally', 'switch', 'throw', 'with', 'debugger', 'enum', 'null', 'true', 'false']);
    const sideBody = (split.deferred || []).map(d => {
      /* names this statement reaches for that the unit never declares: bind
         them locally to the bridge resolver so historic helper calls still
         resolve (and degrade to a no-op instead of a ReferenceError) */
      const own = new Set();
      try {
        const st = acorn.parse(d.text, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
        const { collectRefs } = require('./unit_symbols.js');
        const refs = new Set();
        for (const node of st.body) collectRefs(node, refs);
        for (const r of refs) if (missing.includes(r) && !RESERVED.has(r)) own.add(r);
      } catch (e) { /* analysis is best effort */ }
      const shims = own.size ? `const ${[...own].map(n => `${n} = __qfSym(${JSON.stringify(n)})`).join(', ')};\n      ` : '';
      return `    /* ${f}:${d.line} (${d.type}) */\n    try {\n      ${shims}${d.text.split('\n').join('\n      ')}\n    } catch (e) { __qfSideFail(${JSON.stringify(f)}, ${d.line}, e); }`;
    }).join('\n');
    unitParts.push(`
/* ─────────────── ${f} — ${src.split('\n').length} lines ─────────────── */
let __QF_SIDE_${tag} = null;${split.deferred && split.deferred.length ? `   /* ${split.deferred.length} deferred statement(s) */` : ''}
const ${key} = (() => {
${body}
${sideBody ? `/* ${f}: statements lifted out of module scope (I/O and awaits are not
   allowed there) — they run once per isolate, in their own lexical scope */
__QF_SIDE_${tag} = async () => {
${sideBody}
};` : ''}
return { ${[...names].map(n => `${JSON.stringify(n)}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} };
})();
/* publish the unit scope: the legacy module table (19-legacy-shims) keeps the
   first definition of each name and reports the winning source, so a symbol
   that used to be unreachable across bundles becomes live again */
if (typeof __QF_REGISTER === 'function') {
  for (const [k, v] of Object.entries(${key})) { if (typeof v !== 'undefined') __QF_REGISTER(k, v, 'unit:${tag}'); }
}${sideBody ? `
(globalThis.__QF_SIDES__ = globalThis.__QF_SIDES__ || []).push({ unit: '${tag}', run: __QF_SIDE_${tag} });` : ''}`);
  });
}

/* ---------- 2b. cross-bundle stitch list ------------------------------- */
/* The merged editions called each other's handlers, so thousands of call sites
   referenced a name no bundle in their scope declared.  A name that some *other*
   unit declares at top level gets a lazy global accessor: bare references then
   reach the real implementation (first definition wins), and where nothing real
   exists the accessor answers `undefined` so historic `typeof x === 'undefined'`
   guards keep behaving exactly as before. */
const stitchNames = (() => {
  if (!unitMeta.length) return [];
  const NOISE = new Set(['MEMORY', 'METHODS']);
  const declared = new Map(), refs = new Map();
  for (const u of unitMeta) {
    const p = path.join(unitsDir, u.file);
    const src = read(p);
    declared.set(u.file, unitTopDeclared(src));
    refs.set(u.file, unitAllRefs(src));
  }
  const allDeclared = new Set();
  for (const set of declared.values()) for (const n of set) allDeclared.add(n);
  const out = new Set();
  for (const [file, refSet] of refs) {
    const own = declared.get(file);
    for (const n of refSet) {
      if (own.has(n) || GLOBALS.has(n) || NOISE.has(n)) continue;
      if (allDeclared.has(n)) out.add(n);
    }
  }
  return [...out].sort();
})();

/* ---------- 2c. capability grafts --------------------------------------- */
/* Where a unit calls a static/instance member the class it reached through the
   stitch list does not implement, the legacy layer's implementation is grafted
   onto that class instead of leaving the call site dead.  The candidate list is
   read out of the sources, so it stays in sync with the code. */
const graftMap = (() => {
  const out = {};
  if (!stitchNames.length) return out;
  for (const u of unitMeta) {
    let src = '';
    try { src = read(path.join(unitsDir, u.file)); } catch (e) { continue; }
    for (const cls of stitchNames) {
      const re = new RegExp('(?:^|[^\\w$.])' + cls.replace(/[$]/g, '\\$') + '\\.([A-Za-z_$][\\w$]*)', 'g');
      let m;
      while ((m = re.exec(src))) {
        const member = m[1];
        if (!out[cls]) out[cls] = new Set();
        out[cls].add(member);
      }
    }
  }
  const clean = {};
  for (const [k, v] of Object.entries(out)) clean[k] = [...v].sort();
  return clean;
})();

/* ---------- 3. bridge ------------------------------------------------- */
const bridge = !unitMeta.length ? '' : `
/* ═══════════════════════════════════════════════════════════════════════════
 * B2 · LAZY RESOLUTION BRIDGE
 *   The bundles referenced each other's handlers, so thousands of call sites
 *   were dead (a name used but never defined in that bundle).  Here the union
 *   of all unit scopes is published under one global, first definition wins,
 *   and __QF.resolve(name) walks the rest in order.  Legacy code that calls
 *   e.g. handleVLESSConnection() still has its own local binding; the router
 *   uses the bridge, so cross-bundle capabilities are finally live.
 * ═══════════════════════════════════════════════════════════════════════════ */
/* a deferred statement that fails must never take the isolate down: record it
   and let the engine keep serving */
const __qfSideFail = (unit, line, err) => {
  try {
    QV.unitFaults = QV.unitFaults || [];
    QV.unitFaults.push({ unit, line, error: String((err && err.message) || err), at: Date.now() });
    if (QV.unitFaults.length > 50) QV.unitFaults.shift();
    console.warn('[qf:unit-side]', unit + ':' + line, (err && err.message) || err);
  } catch (e) { /* logging must never throw */ }
};
/* resolver for identifiers a unit never declared: the union of every unit scope
   and the legacy registry, then an inert callable so diagnostics can finish */
const __qfSym = (name) => {
  try {
    if (typeof globalThis[name] !== 'undefined') return globalThis[name];
    if (typeof __QF_MODULES__ !== 'undefined' && __QF_MODULES__[name] !== undefined) return __QF_MODULES__[name];
    if (typeof __QV_LEGACY !== 'undefined' && __QV_LEGACY.registry && __QV_LEGACY.registry.get(name)) return __QV_LEGACY.registry.get(name);
  } catch (e) { /* fall through to the inert stub */ }
  const stub = function __qfMissingHelper() { return undefined; };
  try {
    return new Proxy(stub, {
      get: (_t, k) => (k === 'name' ? name : k === Symbol.toPrimitive ? () => name : stub),
      apply: () => undefined,
      construct: () => ({}),
    });
  } catch (e) { return stub; }
};
/* resolve a stitched name without consulting globalThis (the accessor below is
   itself installed there — reading it back would recurse) */
const __qfResolve = (name) => {
  try {
    if (typeof __QF_MODULES__ !== 'undefined' && __QF_MODULES__[name] !== undefined) return __QF_MODULES__[name];
    if (typeof __QV_LEGACY !== 'undefined' && __QV_LEGACY.registry && __QV_LEGACY.registry.get(name)) return __QV_LEGACY.registry.get(name);
    if (typeof QV !== 'undefined') {
      if (QV.legacy && QV.legacy[name]) return QV.legacy[name];
      const proto = QV.legacy_members || {};
      void proto;
    }
  } catch (e) { /* ignore */ }
  return undefined;
};
const __QF = (() => {
  const units = { ${unitMeta.map(u => `${u.key}`).join(', ')} };
  const meta = ${JSON.stringify(unitMeta.map(u => ({ file: u.file, key: u.key, names: u.names })), null, 0)};
  const index = new Map();                      // name → [values…] first wins
  for (const m of meta) {
    const scope = units[m.key] || {};
    for (const n of m.names) {
      if (!(n in scope)) continue;
      const v = scope[n];
      if (v === undefined) continue;
      if (!index.has(n)) index.set(n, []);
      index.get(n).push(v);
    }
  }
  return {
    units, meta,
    names: () => [...index.keys()],
    all: (name) => index.get(name) || [],
    resolve: (name) => { const l = index.get(name); return (l && l.find(x => typeof x === 'function')) || (l && l[0]) || null; },
    value: (name) => (index.get(name) || [])[0] ?? null,
    defaults: () => meta.map(m => units[m.key] && (units[m.key]['__GEN_DEFAULT'] || null)).filter(d => d && typeof d === 'object'),
    crons: () => meta.map(m => m.key).flatMap(k => {
      const names = [];
      for (const [n, v] of Object.entries(units[k] || {})) if (typeof v === 'function' && /scheduled|cron|tick|cleanup|sweep/i.test(n)) names.push(Object.assign(v, { name: k + ':' + n }));
      return names;
    }).filter(Boolean),
    pick: (names) => { for (const n of names) { const v = index.get(n); if (v && v.length) return v[0]; } return null; },
  };
})();
globalThis.__QF = __QF;
/* 2b continued: install the lazy accessors.  Only callable values are handed
   out, so a guard that probes with typeof still sees undefined when no
   bundle ever provided the symbol. */
const __QF_STITCH = ${JSON.stringify(stitchNames)};
for (const name of __QF_STITCH) {
  try {
    if (name in globalThis) continue;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        const direct = __QF.resolve(name);
        if (typeof direct === 'function') return direct;
        const fallback = __qfResolve(name);
        return typeof fallback === 'function' ? fallback : undefined;
      },
    });
  } catch (e) { /* a frozen global object just means no stitching for that name */ }
}
if (typeof globalThis.__QF_SIDES__ !== 'undefined') __QF.sides = globalThis.__QF_SIDES__;
__QF.stitched = __QF_STITCH;

/* capability grafts: attach the legacy implementation wherever a class the
   units reach through the stitch list is missing a member they call.  Nothing
   is overwritten — only genuinely absent members are filled in. */
const __QF_GRAFT = ${JSON.stringify(graftMap)};
const __QF_impl = (name) => {
  try {
    if (typeof QV === 'undefined') return null;
    const L = QV.legacy || {};
    const cand = [L[name], L.FALLBACKS && L.FALLBACKS[name], L.registry && L.registry.get && L.registry.get(name), __qfResolve(name)];
    for (const c of cand) if (typeof c === 'function') return c;
  } catch (e) { /* ignore */ }
  return null;
};
const __QF_grafted = [];
for (const [cls, members] of Object.entries(__QF_GRAFT)) {
  let C = null;
  try { C = __QF.resolve(cls) || __qfResolve(cls); } catch (e) { C = null; }
  if (typeof C !== 'function') continue;
  for (const m of members) {
    const impl = __QF_impl(m);
    if (!impl) continue;
    try {
      if (typeof C[m] !== 'function') {
        Object.defineProperty(C, m, { value: impl, configurable: true, writable: true });
        __QF_grafted.push(cls + '.' + m);
      } else if (C.prototype && typeof C.prototype[m] !== 'function') {
        Object.defineProperty(C.prototype, m, { value: impl, configurable: true, writable: true });
        __QF_grafted.push(cls + '#prototype.' + m);
      }
    } catch (e) { /* frozen class: skip */ }
  }
}
__QF.grafted = __QF_grafted;
`;

/* ---------- 4. assemble ---------------------------------------------- */
const out = [
  header,
  `/* ${'═'.repeat(74)}
 * QUANTUM VLESS ULTIMATE — UNIFIED SINGLE FILE
 *   core: new autonomous layer (A)   units: 11 original editions (B)   router (C)
 *   built by assemble.js — deterministic, idempotent, nothing dropped
 * ${'═'.repeat(74)} */`,
  core,
  unitParts.join('\n'),
  bridge,
  `\n/* ═══════════════ END OF FILE ═══════════════ */\n`,
].filter(Boolean).join('\n');

const outPath = opt('--out') || (flag('--core-only') ? path.join(ROOT, 'dist/core-only.js') : OUT_DEFAULT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

/* strip the final entry exports when building the core-only test bundle?
   no — keep them; miniflare needs the default export */
fs.writeFileSync(outPath, out);

/* ---------- 5. verify ------------------------------------------------ */
const stats = {
  out: outPath,
  bytes: out.length,
  lines: out.split('\n').length,
  coreFiles: CORE_ORDER.length,
  units: unitMeta.length,
  unitSymbols: unitMeta.reduce((s, u) => s + u.names.length, 0),
  stitched: typeof stitchNames === 'undefined' ? 0 : stitchNames.length,
  graftable: typeof graftMap === 'undefined' ? 0 : Object.values(graftMap).reduce((a, b) => a + b.length, 0),
  parseErrors: unitMeta.filter(u => u.parseError).map(u => u.file + ': ' + u.parseError),
};
try {
  acorn.parse(out, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnFlow: true });
  stats.parse = '✅ clean';
} catch (e) {
  stats.parse = '❌ ' + e.message + ' @' + (e.loc ? e.loc.line + ':' + e.loc.column : '?');
  const lines = out.split('\n');
  const ln = e.loc ? e.loc.line : 0;
  if (ln) console.error(lines.slice(Math.max(0, ln - 4), ln + 3).map((l, i) => `${ln - 3 + i}| ${l.slice(0, 160)}`).join('\n'));
}
console.log(JSON.stringify(stats, null, 2));
if (String(stats.parse).startsWith('❌')) process.exit(1);
