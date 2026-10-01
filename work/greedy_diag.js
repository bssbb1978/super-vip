/* Greedy diagnostic: applies repairs step by step and prints exactly what
   happens, so we can see where the template strategy goes wrong. */
const fs = require('fs');
const acorn = require('acorn');
const OPTS = { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true };
const parse = (s) => { try { acorn.parse(s, OPTS); return null; } catch (e) { return e; } };
const lineNumOf = (src, pos) => { let n = 1; for (let i = 0; i < pos; i++) if (src[i] === '\n') n++; return n; };
const lineStartOf = (src, pos) => src.lastIndexOf('\n', pos - 1) + 1;

let src = fs.readFileSync(process.argv[2], 'utf8');
const MAX = parseInt(process.argv[3] || '26', 10);

for (let step = 0; step < MAX; step++) {
  const err = parse(src);
  if (!err) { console.log('✅ CLEAN after', step, 'repairs'); fs.writeFileSync('greedy_out.js', src); process.exit(0); }
  const line = lineNumOf(src, err.pos);
  const ls = lineStartOf(src, err.pos);
  const col = err.pos - ls;
  const lineTxt = src.slice(ls, src.indexOf('\n', ls));
  console.log(`\n[step ${step}] line ${line} col ${col}: ${err.message}`);
  console.log(`   line text: ${JSON.stringify(lineTxt.slice(0, 120))}`);

  // candidate E: escape nearest preceding backtick pair
  let b1 = -1;
  for (let k = Math.min(err.pos, src.length - 1); k >= Math.max(0, err.pos - 6000); k--) {
    if (src[k] === '`' && src[k - 1] !== '\\') { b1 = k; break; }
  }
  if (b1 < 0) { console.log('   no backtick found; stopping'); break; }
  let k = b1 + 1, depth = 0, b2 = -1;
  while (k < src.length) {
    const ch = src[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === '$' && src[k + 1] === '{') { depth++; k += 2; continue; }
    if (ch === '}' && depth > 0) { depth--; k++; continue; }
    if (ch === '`' && depth === 0) { b2 = k; break; }
    k++;
  }
  console.log(`   b1 line ${lineNumOf(src, b1)} | ${JSON.stringify(src.slice(Math.max(0, b1 - 45), b1 + 25))}`);
  if (b2 < 0) { console.log('   no closing backtick; stopping'); break; }
  console.log(`   b2 line ${lineNumOf(src, b2)} | ${JSON.stringify(src.slice(Math.max(0, b2 - 25), b2 + 25))}`);

  const inner = src.slice(b1 + 1, b2).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  const cand = src.slice(0, b1) + '\\`' + inner + '\\`' + src.slice(b2 + 1);
  const e2 = parse(cand);
  console.log(`   after escape -> ${e2 ? 'line ' + lineNumOf(cand, e2.pos) + ': ' + e2.message : 'CLEAN'}`);
  if (!e2 || e2.pos > err.pos) { src = cand; continue; }
  console.log('   escaping does not help — stopping'); break;
}
fs.writeFileSync('greedy_out.js', src);
