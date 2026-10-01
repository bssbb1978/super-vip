/* Parser-driven segmentation.
 * Repeatedly parses the source; when the parse fails (e.g. a duplicate
 * top-level declaration or a stray fragment), it splits the text at the
 * statement boundary that precedes the offending token and recurses on the
 * remainder.  Result: N chunks, each of which parses on its own. */
const fs = require('fs');
const acorn = require('acorn');

const OPTS = { ecmaVersion: 2022, sourceType: 'module',
  allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, allowHashBang: true, allowSuperOutsideMethod: true };

function parse(src) { try { acorn.parse(src, OPTS); return null; } catch (e) { return e; } }
const lineNumOf = (src, pos) => { let n = 1; for (let i = 0; i < pos; i++) if (src[i] === '\n') n++; return n; };

function boundaryBefore(src, pos) {
  // start of the line containing pos
  let ls = src.lastIndexOf('\n', pos - 1) + 1;
  // walk back over the comment/banner block that belongs to this declaration
  let cur = ls;
  for (;;) {
    const prevEnd = cur - 1;
    if (prevEnd <= 0) break;
    let ps = src.lastIndexOf('\n', prevEnd - 1) + 1;
    const line = src.slice(ps, prevEnd);
    if (/^\s*(\/\/.*|\/\*.*|\*.*|\*\/|)$/.test(line)) { cur = ps; continue; }
    break;
  }
  return cur;
}

function segment(src, out, depth) {
  if (depth > 400) { out.push(src); return; }
  const e = parse(src);
  if (!e) { out.push(src); return; }
  const line = lineNumOf(src, e.pos);
  const b = boundaryBefore(src, e.pos);
  if (b <= 0 || b >= src.length) { out.push(src); return; }
  const left = src.slice(0, b);
  const right = src.slice(b);
  const el = parse(left);
  if (el) { out.push(src); return; }         // cannot split safely here
  console.log(`  split at line ${line}: ${e.message.slice(0, 60)}`);
  segment(left, out, depth + 1);
  segment(right, out, depth + 1);
}

const src = fs.readFileSync(process.argv[2], 'utf8');
const out = [];
console.log('segmenting...');
segment(src, out, 0);
console.log(`\n→ ${out.length} segments`);
out.forEach((s, i) => {
  const e = parse(s);
  console.log(`seg${i + 1}: ${s.split('\n').length.toString().padStart(6)} lines, ${(s.length / 1024).toFixed(0).padStart(6)} KB, parse=${e ? 'FAIL ' + e.message.slice(0, 40) : 'OK'}`);
});
fs.writeFileSync(process.argv[3], JSON.stringify(out));
