const fs = require('fs');
const units = JSON.parse(fs.readFileSync('units.json', 'utf8'));
fs.mkdirSync('units', { recursive: true });
let total = 0, clean = 0;
const rows = [];
units.forEach((u, i) => {
  const lines = u.src.split('\n').length;
  total += lines;
  if (u.ok) clean += lines;
  fs.writeFileSync(`units/u${String(i).padStart(2, '0')}.js`, u.src);
  rows.push(`u${String(i).padStart(2, '0')}  ${String(lines).padStart(6)} lines  ${String((u.src.length / 1024).toFixed(0)).padStart(5)} KB  ${u.ok ? 'OK  ' : 'BAD '} ${u.why ? u.why.slice(0, 60) : ''}`);
});
console.log(rows.join('\n'));
console.log(`\ntotal ${total} lines, clean ${clean} (${(100 * clean / total).toFixed(1)}%)`);
