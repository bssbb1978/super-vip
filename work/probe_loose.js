const loose = require('acorn-loose');
const fs = require('fs');
const src = fs.readFileSync(process.argv[2] || 'segs/seg9.js', 'utf8');
const ast = loose.parse(src, { ecmaVersion: 2022, sourceType: 'module' });
const lineNumOf = (s, p) => { let n = 1; for (let i = 0; i < p; i++) if (s[i] === '\n') n++; return n; };

const found = [];
const walk = (n) => {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach(walk);
  if (n.type === 'TemplateLiteral') found.push(n);
  for (const k in n) { if (k === 'start' || k === 'end' || k === 'loc') continue; walk(n[k]); }
};
walk(ast);

console.log('TemplateLiterals:', found.length);
found.slice(0, 40).forEach((t, i) => {
  const a = lineNumOf(src, t.start), b = lineNumOf(src, t.end);
  const slice = src.slice(t.start, Math.min(t.end, t.start + 60)).replace(/\n/g, '\\n');
  console.log(`#${i} lines ${a}..${b} quasis=${t.quasis.length} exprs=${t.expressions.length} | ${JSON.stringify(slice.slice(0, 70))}`);
});
