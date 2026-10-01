/* Cross-module surface check: every QV.<ns>.<member> the core touches must be
   defined somewhere in the core (or come from one of the known legacy bridges). */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const CORE = fs.readdirSync('core').filter(f => f.endsWith('.js')).sort();
const defined = new Map();   // "ns.member" -> file
const nsAssigned = new Set();
const aliases = new Map();   // local const name -> "QV.ns"

/* pass 0: aliases such as `const D = QV.dns` exist in most files */
const asts = new Map();
for (const f of CORE) {
  const src = fs.readFileSync(path.join('core', f), 'utf8');
  try { asts.set(f, acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', allowReturnOutsideFunction: true })); }
  catch (e) { console.log('PARSE FAIL', f, e.message); }
}
const each = (fn) => { for (const [f, ast] of asts) walkAll(ast, (n) => fn(n, f)); };
function walkAll(node, cb) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(n => walkAll(n, cb));
  cb(node);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (v && typeof v === 'object') walkAll(v, cb);
  }
}
each((n) => {
  if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init &&
      n.init.type === 'MemberExpression' && !n.init.computed &&
      n.init.object.type === 'Identifier' && n.init.object.name === 'QV') {
    aliases.set(n.id.name, 'QV.' + n.init.property.name);
  }
});
console.log('aliases:', [...aliases.entries()].map(([k, v]) => k + '=' + v).join(' '));

const add = (key, file) => { if (!defined.has(key)) defined.set(key, file); };

for (const f of CORE) {
  const src = fs.readFileSync(path.join('core', f), 'utf8');
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script' }); }
  catch (e) { console.log('PARSE FAIL', f, e.message); continue; }

  const walk = walkAll;

  const memberKeys = (objLit) => {
    const out = [];
    for (const p of objLit.properties) {
      if (p.type === 'Property' && !p.computed) {
        if (p.key.type === 'Identifier') out.push(p.key.name);
        else if (p.key.type === 'Literal') out.push(String(p.key.value));
      } else if (p.type === 'SpreadElement') out.push('*spread*');
    }
    return out;
  };

  walk(ast, (n) => {
    if (n.type !== 'AssignmentExpression' || n.operator !== '=') return;
    const L = n.left;
    if (L.type !== 'MemberExpression' || L.computed) return;
    /* the right-hand side may be an object literal, a wrapped one
       (Object.freeze({...}), Object.assign({}, ...)) or anything else */
    const unwrap = (node) => {
      let cur = node;
      for (let i = 0; i < 3 && cur && cur.type === 'CallExpression'; i += 1) {
        const name = cur.callee.type === 'MemberExpression' ? cur.callee.property.name : '';
        if (!/^(freeze|seal|assign|create)$/.test(name)) break;
        cur = cur.arguments[cur.arguments.length - 1] || cur.arguments[0];
      }
      return cur;
    };
    const objOf = (node) => { const u = unwrap(node); return u && u.type === 'ObjectExpression' ? u : null; };

    const target = (() => {
      if (L.object.type === 'Identifier' && L.object.name === 'QV') return 'QV.' + L.property.name;
      if (L.object.type === 'Identifier' && aliases.has(L.object.name)) return aliases.get(L.object.name) + '.' + L.property.name;
      if (L.object.type === 'MemberExpression' && !L.object.computed && L.object.object.type === 'Identifier' && L.object.object.name === 'QV') return 'QV.' + L.object.property.name + '.' + L.property.name;
      return null;
    })();
    if (!target) return;
    const obj = objOf(n.right);
    if (target.split('.').length === 2) {
      nsAssigned.add(target.split('.')[1]);
      if (obj) memberKeys(obj).forEach(k => add(target + '.' + k, f));
      else add(target, f);
    } else if (obj) {
      memberKeys(obj).forEach(k => add(target + '.' + k, f));
    } else {
      add(target, f);
    }
    if (obj) return;
    if (target.split('.').length >= 3) add(target, f);
    return;
    if (L.object.type === 'MemberExpression' && !L.object.computed &&
        L.object.object.type === 'Identifier' && L.object.object.name === 'QV') {
      add('QV.' + L.object.property.name + '.' + L.property.name, f);
    }
  });

  /* Object.assign(QV.ns, { ... }) */
  walk(ast, (n) => {
    if (n.type !== 'CallExpression') return;
    const c = n.callee;
    if (c.type !== 'MemberExpression' || c.object.name !== 'Object' || c.property.name !== 'assign') return;
    const target = n.arguments[0];
    if (!target || target.type !== 'MemberExpression' || target.object.name !== 'QV') return;
    const ns = target.property.name;
    nsAssigned.add(ns);
    const obj = n.arguments[1];
    if (obj && obj.type === 'ObjectExpression') memberKeys(obj).forEach(k => add('QV.' + ns + '.' + k, f));
  });

  /* QV.ns.member = fn  (already handled) plus QV.ns = ns || {} patterns */
  walk(ast, (n) => {
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' &&
        n.left.object.type === 'Identifier' && n.left.object.name === 'QV' && n.left.property) {
      nsAssigned.add(n.left.property.name);
    }
  });
}

/* --- usages --- */
const missing = new Map();
const seenNamespaces = new Set();
for (const f of CORE) {
  const src = fs.readFileSync(path.join('core', f), 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const re = /QV\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(line))) {
      const key = 'QV.' + m[1] + '.' + m[2];
      seenNamespaces.add(m[1]);
      if (!defined.has(key) && !line.trim().startsWith('*') && !line.trim().startsWith('//')) {
        const list = missing.get(key) || [];
        list.push(f + ':' + (i + 1));
        missing.set(key, list);
      }
    }
  });
}

console.log('namespaces defined :', [...nsAssigned].sort().join(' '));
console.log('namespaces used    :', [...seenNamespaces].sort().join(' '));
console.log('members defined    :', defined.size);
const unknownNs = [...seenNamespaces].filter(n => !nsAssigned.has(n));
console.log('namespaces used but never assigned:', unknownNs.join(' ') || '(none)');
console.log('\nmissing members (' + missing.size + '):');
for (const [k, where] of [...missing.entries()].sort()) {
  console.log('  ' + k.padEnd(38), where.slice(0, 4).join(' '));
}
