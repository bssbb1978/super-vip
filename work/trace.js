const fs = require('fs');
const acorn = require('acorn');
const src = fs.readFileSync(process.argv[2], 'utf8');
const needle = process.argv[3] || 'async updateUser(uuid, data)';
const anchor = src.indexOf(needle);
const b = src.indexOf('{', src.indexOf('try', anchor));
console.log('anchor line', src.slice(0, anchor).split('\n').length, 'brace idx', b);
let i = b, depth = 0, st = [], ln = src.slice(0, b).split('\n').length;
const n = src.length;
const report = [];
while (i < n) {
  const c = src[i];
  if (st.length === 0) {
    if (c === '`') { st.push('`'); i++; continue; }
    if (c === '"' || c === "'") { const q = c; i++; while (i < n && src[i] !== q) { i += (src[i] === '\\') ? 2 : 1; } i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j + 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i); i = j < 0 ? n : j + 2; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { console.log('MATCH at line', ln); break; } }
  } else if (st[st.length - 1] === '`') {
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { st.pop(); i++; continue; }
    if (c === '$' && src[i + 1] === '{') { st.push('{'); i += 2; continue; }
  } else if (st[st.length - 1] === '{') {
    if (c === '\\') { i += 2; continue; }
    if (c === '{') st.push('{');
    else if (c === '}') st.pop();
    else if (c === '`') st.push('`');
    else if (c === '"' || c === "'") { const q = c; i++; while (i < n && src[i] !== q) { i += (src[i] === '\\') ? 2 : 1; } i++; continue; }
  }
  if (c === '\n') { ln++; if (ln < src.slice(0, b).split('\n').length + 45) report.push(`  ${ln} depth=${depth} st=${JSON.stringify(st)}`); }
  i++;
}
console.log(report.join('\n'));
console.log('END depth', depth, 'line', ln, 'st', JSON.stringify(st));
