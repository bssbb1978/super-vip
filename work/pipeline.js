/* ============================================================================
 *  PIPELINE — deterministic, parser-verified repair + segmentation driver.
 *
 *  For every unit of source:
 *    1. parse -> clean? done.
 *    2. error is a duplicate declaration  -> SPLIT the unit at that statement
 *       boundary and repair the two halves independently (this is the merge
 *       step: each generation becomes its own scope unit).
 *    3. template errors  -> escape the inner template literal / re-insert the
 *       lost closing delimiter (verified by re-parsing).
 *    4. `try` without catch -> append a guarded catch clause (verified).
 *    5. missing block/brace/paren -> insert (verified, line-start only).
 *    6. nothing works -> split out the offending statement so the rest of the
 *       unit stays usable (nothing is ever deleted).
 * ==========================================================================*/
const fs = require('fs');
const acorn = require('acorn');

const OPTS = { ecmaVersion: 2022, sourceType: 'module',
  allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
  allowHashBang: true, allowSuperOutsideMethod: true };

const parse = (s) => { try { acorn.parse(s, OPTS); return null; } catch (e) { return e; } };
const lineNumOf = (src, pos) => { let n = 1; for (let i = 0; i < pos; i++) if (src[i] === '\n') n++; return n; };
const lineStartOf = (src, pos) => src.lastIndexOf('\n', pos - 1) + 1;

function boundaryBefore(src, pos) {
  let cur = lineStartOf(src, pos);
  for (;;) {
    if (cur <= 0) break;
    const ps = lineStartOf(src, cur - 1);
    const line = src.slice(ps, cur - 1);
    if (/^\s*(\/\/.*|\/\*.*|\*.*|\*\/|)$/.test(line)) cur = ps; else break;
  }
  return cur;
}

const GUARD = ' catch (__autoErr) { try { console.error("[auto-guard]", (__autoErr && __autoErr.message) || __autoErr); } catch (__e2) {} }';

function findMatch(s, i) {
  let depth = 0, ln = 1; const st = []; const n = s.length;
  while (i < n) {
    const c = s[i];
    if (st.length === 0) {
      if (c === '`') { st.push('`'); i++; continue; }
      if (c === '"' || c === "'") { const q = c; i++; while (i < n && s[i] !== q) { i += (s[i] === '\\') ? 2 : 1; } i++; continue; }
      if (c === '/' && s[i + 1] === '/') { const j = s.indexOf('\n', i); i = j < 0 ? n : j + 1; continue; }
      if (c === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i); i = j < 0 ? n : j + 2; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    } else if (st[st.length - 1] === '`') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { st.pop(); i++; continue; }
      if (c === '$' && s[i + 1] === '{') { st.push('{'); i += 2; continue; }
    } else if (st[st.length - 1] === '{') {
      if (c === '\\') { i += 2; continue; }
      if (c === '{') st.push('{');
      else if (c === '}') st.pop();
      else if (c === '`') st.push('`');
      else if (c === '"' || c === "'") { const q = c; i++; while (i < n && s[i] !== q) { i += (s[i] === '\\') ? 2 : 1; } i++; continue; }
    }
    i++;
  }
  return -1;
}

const log = [];
const stats = {};

function accept(src, cand, err, kind, note) {
  const e2 = parse(cand);
  const newPos = e2 ? e2.pos : Infinity;
  let ok = (newPos === Infinity) || (newPos > err.pos && (newPos - err.pos >= 20 || lineNumOf(cand, newPos) > lineNumOf(src, err.pos)));
  /* guard: an escape that produces an "unicode escape" / unterminated error is
     a symptom of escaping the WRONG delimiter -> reject it */
  if (ok && e2 && /Unicode escape|Unterminated|expecting '\}', expecting '\$\{'/i.test(e2.message)) ok = false;
  if (ok && e2 && /Unexpected character/.test(e2.message)) ok = false;
  if (ok) {
    stats[kind] = (stats[kind] || 0) + 1;
    log.push(`   ✔ [${kind}] line ${lineNumOf(src, err.pos)}: ${String(err.message).slice(0, 46)} → ${note}`);
  }
  return ok ? cand : null;
}

/* repair a unit that is known to still have a syntax error */
function tryRepair(src, err) {
  const pos = err.pos, msg = err.message;

  /* ---- 1. inner template literal ---- */
  {
    let b1 = -1;
    for (let k = Math.min(pos, src.length - 1); k >= Math.max(0, pos - 8000); k--) {
      if (src[k] === '`' && src[k - 1] !== '\\') { b1 = k; break; }
    }
    if (b1 >= 0) {
      let k = b1 + 1, depth = 0, b2 = -1;
      while (k < src.length) {
        const ch = src[k];
        if (ch === '\\') { k += 2; continue; }
        if (ch === '$' && src[k + 1] === '{') { depth++; k += 2; continue; }
        if (ch === '}' && depth > 0) { depth--; k++; continue; }
        if (ch === '`' && depth === 0) { b2 = k; break; }
        k++;
      }
      if (b2 > b1) {
        const inner = src.slice(b1 + 1, b2).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
        const cand = src.slice(0, b1) + '\\`' + inner + '\\`' + src.slice(b2 + 1);
        const r = accept(src, cand, err, 'template-escape', `escaped inner template @line ${lineNumOf(src, b1)}`);
        if (r) return r;
      }
    }
  }

  /* ---- 2. runaway template: re-insert the lost closing delimiter ---- */
  {
    let b1 = -1;
    for (let k = Math.min(pos, src.length - 1); k >= Math.max(0, pos - 400000); k--) {
      if (src[k] === '`' && src[k - 1] !== '\\') { b1 = k; break; }
    }
    if (b1 >= 0 && (/[=(,\[]\s*$/.test(src.slice(Math.max(0, b1 - 6), b1)) || /return\s*$/.test(src.slice(Math.max(0, b1 - 8), b1)))) {
      const pts = [];
      let cursor = lineStartOf(src, pos);
      pts.push(cursor);
      for (let n = 0; n < 2500 && cursor > 0 && pts.length < 8; n++) {
        cursor = lineStartOf(src, cursor - 1);
        const le = src.indexOf('\n', cursor); const text = src.slice(cursor, le < 0 ? src.length : le);
        if (/^\s*(\/\*\*|\/\/ ═|const\s|class\s|function\s|async\s|export\s|let\s|var\s)/.test(text)) pts.push(cursor);
      }
      for (const p of pts) {
        for (const ins of ['`;\n', '`\n']) {
          const r = accept(src, src.slice(0, p) + ins + src.slice(p), err, 'template-close',
            `re-inserted closing delimiter before line ${lineNumOf(src, p)}`);
          if (r) return r;
        }
      }
    }
  }

  /* ---- 3. try without catch ---- */
  if (/Missing catch or finally/i.test(msg)) {
    const tryIdx = src.lastIndexOf('try', pos);
    if (tryIdx >= 0) {
      const b = src.indexOf('{', tryIdx + 3);
      const close = b >= 0 ? findMatch(src, b) : -1;
      if (close > 0) {
        const after = src.slice(close + 1);
        if (!/^\s*(catch|finally)/.test(after)) {
          if (after.trimStart().startsWith('}')) {
            const r = accept(src, src.slice(0, close + 1) + GUARD + src.slice(close + 1), err, 'guard', 'auto-catch (body closed)');
            if (r) return r;
          } else {
            const ind = (src.slice(lineStartOf(src, close), close).match(/^\s*/) || [''])[0];
            for (let k = 1; k <= 3; k++) {
              const closers = ('\n' + ind + '}').repeat(k);
              const r = accept(src, src.slice(0, close + 1) + GUARD + closers + src.slice(close + 1), err, 'guard+brace', `auto-catch + ${k} closer(s)`);
              if (r) return r;
            }
          }
        }
      }
    }
  }

  /* ---- 4. missing closers ---- */
  if (err.loc && err.loc.column < 12) {
    const ls = lineStartOf(src, pos);
    for (let k = 1; k <= 3; k++) {
      const r = accept(src, src.slice(0, ls) + '}'.repeat(k) + ' ' + src.slice(ls), err, 'brace', `insert ${k}x '}' at line start`);
      if (r) return r;
    }
    const r2 = accept(src, src.slice(0, pos) + ') ' + src.slice(pos), err, 'paren', "insert ')' at error");
    if (r2) return r2;
  }
  return null;
}

const units = [];
function processUnit(src, depth = 0) {
  if (depth > 500) { units.push({ src, ok: false, why: 'depth' }); return; }
  for (let guard = 0; guard < 4000; guard++) {
    const err = parse(src);
    if (!err) { units.push({ src, ok: true }); return; }

    /* duplicate declaration => merge boundary: split here */
    if (/already been declared|Duplicate export|Argument name clash/i.test(err.message)) {
      const b = boundaryBefore(src, err.pos);
      if (b > 0 && b < src.length) {
        log.push(`   ✂ split @line ${lineNumOf(src, err.pos)} (${err.message.slice(0, 44)})`);
        processUnit(src.slice(0, b), depth + 1);
        processUnit(src.slice(b), depth + 1);
        return;
      }
    }

    const fixed = tryRepair(src, err);
    if (fixed) { src = fixed; continue; }

    /* fallback: isolate the offending statement so the rest stays usable */
    const line = lineNumOf(src, err.pos);
    log.push(`   ⚠ line ${line}: ${err.message} — isolating statement`);
    const stmtStart = boundaryBefore(src, err.pos);
    const stmtEnd = findStatementEnd(src, err.pos);
    if (stmtStart > 0 && stmtEnd > stmtStart && stmtEnd < src.length) {
      units.push({ src: src.slice(stmtStart, stmtEnd), ok: false, why: err.message, line });
      src = src.slice(0, stmtStart) + src.slice(stmtEnd);
      continue;
    }
    units.push({ src, ok: false, why: err.message, line });
    return;
  }
  units.push({ src, ok: false, why: 'loop limit' });
}

function findStatementEnd(src, pos) {
  /* forward scan for the terminator of the enclosing simple statement */
  let i = pos, depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '`' || c === '"' || c === "'") { const q = c; i++; while (i < src.length && src[i] !== q) i += (src[i] === '\\') ? 2 : 1; i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth < 0) return i + 1; }
    else if (c === ';' && depth === 0) return i + 1;
    i++;
  }
  return src.length;
}

/* ------------------------------------------------------------------ */
const input = process.argv[2];
const outJson = process.argv[3];
const src = fs.readFileSync(input, 'utf8');
console.log('repairing + segmenting', input, '...');
processUnit(src);
const ok = units.filter(u => u.ok).length;
console.log(log.join('\n'));
console.log(`\nUNITS: ${units.length}  (parse-clean: ${ok}, isolated: ${units.length - ok})`);
console.log('STATS:', JSON.stringify(stats));
fs.writeFileSync(outJson, JSON.stringify(units));
