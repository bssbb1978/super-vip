#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * check_core.js — runtime symbol audit of the whole core
 *   · loads every core file in assembly order inside a Workers-like sandbox
 *   · then reports any `QV.a.b` / `QV.a` the source uses but the runtime does
 *     not define  (these are the silent killers: undefined namespaces)
 *   · also reports the inverse (defined but never used) for dead-code review
 * ═══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
const dir = path.join(__dirname, 'core');
const present = CORE_ORDER.filter(f => fs.existsSync(path.join(dir, f)));

/* ── build one script from the core, exactly like the assembler does ────── */
let src = '';
const importLines = [];
for (const f of present) {
  if (f === '98-entry.js') continue;   // has `export` — the assembler strips it
  let body = fs.readFileSync(path.join(dir, f), 'utf8');
  body = body.replace(/^\s*import\s+([\s\S]*?)\s+from\s+['"]cloudflare:sockets['"];?/gm, (m, what) => {
    importLines.push({ file: f, what: what.trim() });
    return '';
  });
  src += `\n/* ===== ${f} ===== */\n` + body;
}

const needsSockets = importLines.length > 0;
const sandbox = {
  console,
  crypto: globalThis.crypto,
  TextEncoder, TextDecoder, Response, Request, Headers, URL, URLSearchParams, Blob, FormData,
  AbortController, AbortSignal, atob, btoa, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async () => new Response('{}', { status: 200 }),
  WebSocketPair: undefined,
  ReadableStream, WritableStream, TransformStream, Uint8Array, ArrayBuffer, DataView, Buffer: Buffer,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
const context = vm.createContext(sandbox);
const header = needsSockets
  ? `const connect = (...a) => { throw new Error('[check_core] cloudflare:sockets stub called'); };\n`
  : '';
try {
  vm.runInContext(header + src, context, { filename: 'core-all.js' });
} catch (e) {
  console.log('❌ core failed to evaluate:', e.message);
  console.log((e.stack || '').split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
const QV = vm.runInContext('QV', context);

/* ── collect what the sources use ───────────────────────────────────────── */
const usedL1 = new Map();   // QV.a
const usedL2 = new Map();   // QV.a.b
const files = present.filter(f => f !== '98-entry.js');
for (const f of files) {
  let text = fs.readFileSync(path.join(dir, f), 'utf8');
  /* the console ships a client-side script that runs in the *browser*: its
     window.QV.* helpers are not part of the worker namespace — skip them */
  const cStart = text.indexOf('function clientApp()');
  if (cStart !== -1) {
    const cEnd = text.indexOf('const JS = ', cStart);
    if (cEnd > cStart) text = text.slice(0, cStart) + text.slice(cEnd);
  }
  const lineOf = (idx) => text.slice(0, idx).split('\n').length;
  for (const m of text.matchAll(/\bQV\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    const key = m[2] ? `${m[1]}.${m[2]}` : m[1];
    const map = m[2] ? usedL2 : usedL1;
    if (!map.has(key)) map.set(key, []);
    const arr = map.get(key);
    if (arr.length < 3) arr.push(`${f}:${lineOf(m.index)}`);
  }
}

/* ── collect what the runtime defines ──────────────────────────────────── */
const defined = new Set();
const isFn = (v) => typeof v === 'function';
const addProps = (ns, v) => {
  if (v === null || v === undefined) return;
  try { for (const k2 of Object.keys(v)) defined.add(`${ns}.${k2}`); } catch (e) {}
  try { for (const k2 of Object.getOwnPropertyNames(v)) defined.add(`${ns}.${k2}`); } catch (e) {}
  try {
    const proto = Object.getPrototypeOf(v);
    if (proto && proto !== Object.prototype) for (const k2 of Object.getOwnPropertyNames(proto)) defined.add(`${ns}.${k2}`);
  } catch (e) {}
};
for (const [k, v] of Object.entries(QV)) {
  defined.add(k);
  addProps(k, v);
  if (isFn(v) && v.prototype) for (const k2 of Object.getOwnPropertyNames(v.prototype)) defined.add(`${k}.${k2}`);
}

/* ── diff ───────────────────────────────────────────────────────────────── */
const missingL2 = [...usedL2].filter(([k]) => !defined.has(k) && defined.has(k.split('.')[0]));
const missingL1 = [...usedL1].filter(([k]) => !defined.has(k));
const neverUsed = [...defined].filter(k => {
  if (k.includes('.')) return !usedL2.has(k) && !usedL1.has(k.split('.')[0]);
  return !usedL1.has(k) && !usedL2.has(k) && ![...usedL2.keys()].some(x => x.startsWith(k + '.'));
}).filter(k => !/^(VERSION|BUILD|EDITION|enc|dec|now|get|lru|bucket|log|ai|d1|emit)$/.test(k));

const fmt = (list) => list.map(([k, where]) => `  ${k.padEnd(34)} ${where.join(', ')}`).join('\n');
console.log(`\n=== core files loaded: ${files.length} (${present.length}) ===`);
console.log(`QV members defined at runtime: ${defined.size}`);

console.log(`\n❌ MISSING namespaces (QV.x used but undefined) — ${missingL1.length}`);
if (missingL1.length) console.log(fmt(missingL1));

console.log(`\n❌ MISSING members (QV.x.y used but undefined) — ${missingL2.length}`);
if (missingL2.length) console.log(fmt(missingL2));

console.log(`\nℹ️  defined but never referenced — ${neverUsed.length}`);
if (process.argv.includes('--verbose')) console.log('  ' + neverUsed.join(', '));

const bad = missingL1.length + missingL2.length;
console.log(bad ? `\n✖ ${bad} unresolved symbol(s)` : '\n✔ every referenced symbol exists');
process.exit(bad ? 1 : 0);
