/* Diff "what the code calls" against "what actually exists at runtime". */
const fs = require('fs');
const path = require('path');
const surface = JSON.parse(fs.readFileSync('dist/surface.json', 'utf8'));

const files = [];
const collect = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) collect(p);
    else if (/\.(js|mjs)$/.test(f) && !/surface/.test(f)) files.push(p);
  }
};
collect('core'); collect('units');

const missing = new Map();
const KNOWN_DYNAMIC = new Set(['QV.d1.all', 'QV.d1.one', 'QV.d1.run', 'QV.d1.exec', 'QV.d1.batch']); // known aliases

/* Namespaces that are *instances* of a built-in or of our own classes.  Their
   members come from the prototype, so a member audit must not call them
   missing — the list is explicit so a genuine typo stays visible. */
const INSTANCE_NAMESPACES = {
  'QV.enc': ['encode', 'encodeInto'],                       // TextEncoder
  'QV.dec': ['decode'],                                     // TextDecoder
  'QV.lru': ['get', 'set', 'delete', 'has', 'clear', 'keys', 'stats'],   // QVLru
  'QV.caches': ['get', 'set', 'has', 'delete', 'clear', 'keys', 'values', 'entries', 'size', 'forEach'], // Map
  'QV.unitFaults': ['some', 'filter', 'map', 'slice', 'push', 'length', 'pop', 'shift'],  // Array
};
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
    const re = /QV\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(line))) {
      const [ns, member] = [m[1], m[2]];
      const have = surface[ns];
      if (have === undefined) {
        if (!missing.has('QV.' + ns)) missing.set('QV.' + ns, []);
        missing.get('QV.' + ns).push(file + ':' + (i + 1));
        continue;
      }
      const inst = INSTANCE_NAMESPACES['QV.' + ns];
      if (inst && inst.includes(member)) continue;
      if (Array.isArray(have) && !have.includes(member) && !KNOWN_DYNAMIC.has('QV.' + ns + '.' + member)) {
        const key = 'QV.' + ns + '.' + member;
        if (!missing.has(key)) missing.set(key, []);
        missing.get(key).push(file + ':' + (i + 1));
      }
    }
  });
}
console.log('── runtime surface:', Object.keys(surface).length, 'namespaces');
if (!missing.size) console.log('✅ every QV.<ns>.<member> the code touches exists at runtime');
else {
  console.log('✖ ' + missing.size + ' unresolved member(s):');
  for (const [k, where] of [...missing.entries()].sort()) console.log('  ' + k.padEnd(34), where.slice(0, 3).join(' ') + (where.length > 3 ? ' …' : ''));
}
