/* ============================================================================
 * SELF-HEALING SYNTAX REPAIR ENGINE  (v2)
 * ----------------------------------------------------------------------------
 * Repairs a syntactically-broken JavaScript file automatically.
 *
 * Guarantees:
 *   • Nothing is ever deleted - repairs only INSERT tokens.
 *   • Every candidate edit is validated by re-parsing with acorn and is only
 *     accepted when the parse error position strictly MOVES FORWARD
 *     (monotonic hill-climbing => always terminates, never regresses).
 * ==========================================================================*/
const fs = require('fs');
const acorn = require('acorn');

const PARSE_OPTS = {
  ecmaVersion: 2022, sourceType: 'module',
  allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
  allowHashBang: true, allowSuperOutsideMethod: true,
};

function parse(src) {
  try { acorn.parse(src, PARSE_OPTS); return null; }
  catch (e) { return e; }
}

/* ---------- string / template / comment aware brace matcher ---------- */
const { findMatch } = require('./scan.js');
const matchBrace = findMatch;

const lineStartOf = (src, pos) => src.lastIndexOf('\n', pos - 1) + 1;
const lineNumOf = (src, pos) => { let n = 1; for (let i = 0; i < pos; i++) if (src[i] === '\n') n++; return n; };
const indentOf = (s) => (s.match(/^[ \t]*/) || [''])[0];

const GUARD_BODY = '{ try { if (typeof __AUTO_GUARD_HOOK === "function") __AUTO_GUARD_HOOK(__autoErr); } catch (__e2) {} console.error("[auto-guard]", (__autoErr && __autoErr.message) || __autoErr); }';
const mkCatch = () => ` catch (__autoErr) ${GUARD_BODY}`;

/* ---- build candidate edits for a given error ---- */
function candidates(src, err, lineInfo) {
  const out = [];
  const pos = err.pos, msg = err.message;

  /* ---------------- strategy A : try without catch/finally -------------- */
  if (/Missing catch or finally/i.test(msg)) {
    const tryIdx = src.lastIndexOf('try', pos);
    if (tryIdx >= 0) {
      const b = src.indexOf('{', tryIdx + 3);
      const close = b >= 0 ? matchBrace(src, b) : -1;
      if (close > 0) {
        const after = src.slice(close + 1);
        const nxtWs = after.match(/^(\s*)(\S?)/) || ['', '', ''];
        const closeLineIndent = indentOf(src.slice(lineStartOf(src, close), close + 1));
        if (!/^(catch|finally)/.test(after.trimStart())) {
          if (nxtWs[2] === '}') {
            /* method body already closed -> only the catch clause is missing */
            out.push({ src: src.slice(0, close + 1) + mkCatch() + src.slice(close + 1), kind: 'guard', note: 'auto-catch (method closed)' });
          } else {
            /* enclosing method body lost its closing brace too: add catch + k closers */
            for (let k = 1; k <= 3; k++) {
              const closers = ('\n' + closeLineIndent + '}').repeat(k);
              out.push({
                src: src.slice(0, close + 1) + mkCatch() + closers + src.slice(close + 1),
                kind: 'guard+brace', note: `auto-catch + ${k} closer(s)`,
              });
            }
            out.push({ src: src.slice(0, close + 1) + mkCatch() + src.slice(close + 1), kind: 'guard', note: 'auto-catch (no closer)' });
          }
        }
      }
    }
  }

  /* ---------------- strategy E : nested template literal ---------------- */
  if (!process.env.NO_TEMPLATE_FIX) {
    const ls = lineStartOf(src, pos);
    let le = src.indexOf('\n', ls); if (le < 0) le = src.length;
    const line = src.slice(ls, le);
    {
      /* nearest unescaped backtick before the error (search window 6 kB) */
      let b1 = -1;
      const lo = Math.max(0, pos - 6000);
      for (let k = Math.min(pos, src.length - 1); k >= lo; k--) {
        if (src[k] === '`' && src[k - 1] !== '\\') { b1 = k; break; }
      }
      if (b1 >= 0) {
        /* matching (unescaped) close backtick, honouring ${ } nesting */
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
          out.push({ src: cand, kind: 'template', note: `escaped inner template @line ${lineNumOf(src, b1)}` });
        }
      }
    }
  }

  /* -------- strategy G : runaway template (missing closing delimiter) ----- */
  {
    let b1 = -1;
    const lo = Math.max(0, pos - 400000);
    for (let k = Math.min(pos, src.length - 1); k >= lo; k--) {
      if (src[k] === '`' && src[k - 1] !== '\\') { b1 = k; break; }
    }
    if (b1 >= 0) {
      const before = src.slice(Math.max(0, b1 - 6), b1);
      const isOpener = /[=(,\[]\s*$/.test(before) || /return\s*$/.test(before);
      if (isOpener) {
        /* candidate insertion points: the error line itself plus every
           structural boundary in the preceding 400 lines (nearest first) */
        const pts = [];
        let ls = lineStartOf(src, pos);
        pts.push(ls);
        let cursor = ls;
        for (let n = 0; n < 1500 && cursor > 0; n++) {
          cursor = lineStartOf(src, cursor - 1);
          const text = src.slice(cursor, src.indexOf('\n', cursor) < 0 ? src.length : src.indexOf('\n', cursor));
          if (/^\s*(\/\*\*|\/\/ ═|const\s|class\s|function\s|async\s|export\s|let\s|var\s)/.test(text)) {
            pts.push(cursor);
            if (pts.length >= 6) break;
          }
        }
        for (const p of pts) {
          for (const ins of ['`;\n', '`\n']) {
            out.push({
              src: src.slice(0, p) + ins + src.slice(p),
              kind: 'template-close',
              note: `re-inserted closing delimiter before line ${lineNumOf(src, p)}`,
            });
          }
        }
      }
    }
  }

  /* ---------------- strategy B : close missing block -------------------- */
  if (err.loc.column < 10) {
    const ls = lineStartOf(src, pos);
    const ind = indentOf(src.slice(ls, ls + 40));
    for (let k = 1; k <= 3; k++) {
      const ins = ('}'.repeat(k)) + ' ';
      out.push({ src: src.slice(0, ls) + ins + src.slice(ls), kind: 'brace', note: `insert ${k}x '}' at line start` });
    }
    /* B2: same but at the end of the previous line (keeps line numbers) */
    let prevEnd = ls - 1;
    while (prevEnd > 0 && /\s/.test(src[prevEnd - 1])) prevEnd--;
    if (err.loc.column < 10) for (let k = 1; k <= 3; k++) {
      out.push({ src: src.slice(0, prevEnd) + ('}'.repeat(k)) + ' ' + src.slice(prevEnd), kind: 'brace-eol', note: `append ${k}x '}' to prev line` });
    }
  }

  /* ---------------- strategy C : close missing paren -------------------- */
  {
    out.push({ src: src.slice(0, pos) + ') ' + src.slice(pos), kind: 'paren', note: "insert ')' at error" });
    const ls = lineStartOf(src, pos);
    out.push({ src: src.slice(0, ls) + ') ' + src.slice(ls), kind: 'paren', note: "insert ')' at line start" });
    /* NOTE: blanket ';' insertion was removed - it corrupted HTML content. */
  }

  /* ---------------- strategy D : template/backtick recovery ------------- */
  if (msg.includes('Unterminated') || msg.includes('Invalid')) {
    out.push({ src: src.slice(0, pos) + '`' + src.slice(pos), kind: 'other', note: 'close template literal' });
  }

  return out;
}

function startOfLine(src, lineNo1) {
  let n = 1, i = 0;
  while (n < lineNo1 && i < src.length) { if (src[i] === '\n') n++; i++; }
  return i;
}

/* ============================================================================
 *  Depth-first repair search with backtracking.
 *  Each node = (source, parse error, candidate list).
 *  A candidate is pushed only if it strictly advances the error; dead ends are
 *  popped and the next alternative is tried.  Memoised by error fingerprint to
 *  guarantee termination.
 * ==========================================================================*/
function heal(src0, opts = {}) {
  const log = [];
  const stats = {};
  const seen = new Set();
  let parses = 0;
  const memo = new Map();          // srcKey -> true (dead end)
  const stack = [{ src: src0, i: 0, cands: null, err: null }];

  const fingerprint = (src, e) => e.pos + '|' + e.message + '|' + src.slice(Math.max(0, e.pos - 60), e.pos + 60);

  while (stack.length) {
    const top = stack[stack.length - 1];
    const err = top.err || parse(top.src);
    parses++;
    if (!err) {
      log.push('✅ PARSE CLEAN');
      return { src: top.src, log, stats, parses, ok: true };
    }
    const line = lineNumOf(top.src, err.pos);
    if (!top.cands) { top.err = err; top.cands = candidates(top.src, err); }
    if (top.cands.length === 0 || top.i >= top.cands.length) {
      memo.set(fingerprint(top.src, err), true);
      stack.pop();
      if (stack.length) log.push(`↩ backtrack (dead end at line ${line}: ${err.message.slice(0, 40)})`);
      continue;
    }
    const c = top.cands[top.i++];
    const e2 = parse(c.src); parses++;
    if (!e2) {
      stats[c.kind] = (stats[c.kind] || 0) + 1;
      log.push(`✔ line ${line} [${c.kind}] ${String(err.message).slice(0, 48)} → ${c.note}  ⟶ CLEAN`);
      return { src: c.src, log, stats, parses, ok: true };
    }
    const fp = fingerprint(c.src, e2);
    if (memo.has(fp) || seen.has(fp)) continue;
    const newLine = lineNumOf(c.src, e2.pos);
    const meaningful = (e2.pos - err.pos >= 25) || (newLine > line);
    if (e2.pos > err.pos && meaningful) {
      seen.add(fp);
      stats[c.kind] = (stats[c.kind] || 0) + 1;
      log.push(`✔ line ${line} [${c.kind}] ${String(err.message).slice(0, 48)} → ${c.note}`);
      stack.push({ src: c.src, i: 0, cands: null, err: e2 });
      if (stack.length > 300) break;                    // safety valve
    }
  }
  return { src: src0, log, stats, parses, ok: false, failed: true };
}

if (require.main === module) {
  const inp = process.argv[2], outp = process.argv[3];
  const src0 = fs.readFileSync(inp, 'utf8');
  const t0 = Date.now();
  const { src, log, stats } = heal(src0, {});
  fs.writeFileSync(outp, src);
  console.log(log.slice(-120).join('\n'));
  console.log(`\nSTATS: ${JSON.stringify(stats)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  const e = parse(src);
  console.log('FINAL:', e ? '❌ ' + e.message + ' @line ' + lineNumOf(src, e.pos) : '✅ PARSE CLEAN');
}
module.exports = { heal, parse, matchBrace, lineNumOf };
