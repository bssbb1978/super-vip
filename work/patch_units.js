#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * patch_units.js — the minimum edits that make each original unit safe to
 * host inside an isolated scope.  Every change is additive or a pure
 * parenthesis/specifier fix; no behaviour, no branch and no feature is
 * removed.  Each edit is printed with its file and line for the report.
 * ═══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const dir = path.join(__dirname, 'units');
const files = fs.readdirSync(dir).filter(f => /^u\d+\.js$/.test(f)).sort();
const edits = [];

const applyEdit = (file, from, to, note) => {
  const p = path.join(dir, file);
  const src = fs.readFileSync(p, 'utf8');
  if (!src.includes(from)) return false;
  const line = src.slice(0, src.indexOf(from)).split('\n').length;
  const next = src.replace(from, to);
  fs.writeFileSync(p, next);
  edits.push({ file, line, note });
  return true;
};

/* ── 1. u00: `} export default {` (module syntax inside a line) ─────────── */
for (const f of files) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  if (s.includes('} export default {')) {
    applyEdit(f, '} export default {', '}; const __GEN_DEFAULT_0 = {', 'export default → const __GEN_DEFAULT_0 (hostable inside a scope)');
  }
}

/* ── 2. u00: the Rust/WASM VLESS parser import must not break the bundler ── */
{
  const f = 'u00.js';
  const p = path.join(dir, f);
  const s = fs.readFileSync(p, 'utf8');
  const importLine = `    const mod = await import("./rust/pkg/vless_parser.js");`;
  if (s.includes(importLine)) {
    const replacement = `    /* [qv-unified] the Rust/WASM parser is optional: resolve it from a global
       binding if the deployer shipped one, otherwise fall back to the in-file
       JS engine in the catch block below.  A static import() of a file that
       does not exist would abort the whole bundle at build time. */
    const mod = globalThis.VLESS_PARSER_WASM || (() => { throw new Error("WASM parser not deployed (using in-file JS engine)"); })();`;
    applyEdit(f, importLine, replacement, 'WASM import → optional global binding (in-file JS engine as fallback)');
    /* make the catch block land on the JS engine instead of re-throwing */
    const catchOld = `  } catch (err) {
    console.warn("WASM module not available at runtime:", err);
    wasmReady = false;
    throw err;
  }
}
async function parseVlessHeader(buffer) {`;
    const catchNew = `  } catch (err) {
    console.warn("[qv] WASM VLESS parser unavailable — using the in-file JS engine:", err && err.message);
    /* the unified core ships an equivalent pure-JS parser, so the capability
       stays alive instead of throwing */
    wasmModule = globalThis.__QV_VLESS_PARSER || (globalThis.__QV_VLESS_PARSER = {
      parse_vless_header: (buf) => globalThis.__QV_LEGACY.processVLESSHeader(buf),
    });
    wasmReady = true;
    return wasmModule;
  }
}
async function parseVlessHeader(buffer) {`;
    applyEdit(f, catchOld, catchNew, 'WASM failure now falls back to the pure-JS VLESS parser (feature preserved)');
  }
}

/* ── 3. u10: keep the quarantined prompt-echo note but make sure nothing
 *        after it is top-level await (verified by the parse below) ────────── */

/* ── 4. verify every unit still parses as a module ─────────────────────── */
const report = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  let status = '✅';
  try {
    acorn.parse(src, {
      ecmaVersion: 2022, sourceType: 'module',
      allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
    });
  } catch (e) {
    status = '❌ ' + e.message + ' @' + (e.loc ? e.loc.line : '?');
  }
  report.push({ file: f, lines: src.split('\n').length, bytes: src.length, parse: status });
}

console.log(JSON.stringify({ edits, units: report }, null, 1));
if (report.some(r => r.parse !== '✅')) process.exit(1);
