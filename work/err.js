const fs = require('fs');
const acorn = require('acorn');
const file = process.argv[2] || 'src_p1.js';
const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');

function tryParse(text) {
  try {
    acorn.parse(text, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
    return null;
  } catch (e) { return e; }
}

const e = tryParse(src);
if (!e) { console.log('✅ PARSE OK'); process.exit(0); }
console.log('❌', e.message, '@ line', e.loc.line, 'col', e.loc.column);
const L = e.loc.line;
for (let i = Math.max(0, L - 12); i < Math.min(lines.length, L + 4); i++) {
  console.log(String(i + 1).padStart(6), (i + 1 === L ? '>>' : '  '), lines[i]);
}
// also count brace depth at error point to find the enclosing opener
let depth = 0, stack = [];
for (let i = 0; i < L - 1; i++) {
  for (const c of lines[i]) {
    if (c === '{') { depth++; stack.push(i + 1); }
    else if (c === '}') { depth--; stack.pop(); }
  }
}
console.log('depth at error line start:', depth, 'openers (last 8):', stack.slice(-8).join(','));
