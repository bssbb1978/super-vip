/* cross-module API check: every QV.ns.method used somewhere must exist somewhere */
const fs=require('fs');
const files=fs.readdirSync('core').filter(f=>f.endsWith('.js')).sort();
const src=Object.fromEntries(files.map(f=>[f,fs.readFileSync('core/'+f,'utf8')]));
const defined=new Set(), used=new Map();
for (const [f,s] of Object.entries(src)) {
  for (const m of s.matchAll(/QV\.([A-Za-z0-9_]+)\s*=/g)) defined.add(m[1]);
  for (const m of s.matchAll(/\bQV\.([A-Za-z0-9_]+)(\.([A-Za-z0-9_]+))?/g)) {
    const key = m[3] ? `${m[1]}.${m[3]}` : m[1];
    if (!used.has(key)) used.set(key, new Set());
    used.get(key).add(f);
  }
}
/* method-level: collect returned object keys per namespace module */
const nsKeys={};
for (const [f,s] of Object.entries(src)) {
  const m=s.match(/QV\.([a-zA-Z0-9_]+)\s*=\s*\(\(\)\s*=>\s*\{/);
  if(!m) continue;
  const ns=m[1];
  const ret=[...s.matchAll(/return\s*\{([\s\S]*?)\n\s*\};/g)].pop();
  if(!ret) continue;
  const keys=new Set();
  for(const k of ret[1].matchAll(/(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_]*)\s*[:,}]/g)) keys.add(k[1]);
  for(const k of ret[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) keys.add(k[1]);
  nsKeys[ns]=keys;
}
const missing=[], maybeMissing=[];
for (const [key,who] of used) {
  const [ns, method] = key.split('.');
  if (method) {
    const keys=nsKeys[ns];
    if (keys && !keys.has(method) && !/\b(const|let|var|function)\s+\w*/.test('')) maybeMissing.push([key,[...who].join(',')]) ;
    const decl=new RegExp('(?:const|let|var|function|async function)\\s+'+method+'\\b');
    const found = keys && (keys.has(method) || decl.test(src[`core/${Object.keys(nsKeys).length?'':'x'}`]||'') );
  } else {
    if (!defined.has(ns)) missing.push([key,[...who].join(',')]);
  }
}
console.log('MISSING namespaces:', missing.length?missing:'none');
console.log('\nmethod-level review (namespace exists but key not in returned literal):');
for(const [k,w] of maybeMissing) console.log('  ?',k,'<-',w);
console.log('\ndefined top-level:',[...defined].sort().join(' '));
