const fs = require('fs');
const acorn = require('acorn');
const OPTS = { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true };

for (let i = 0; i <= 10; i++) {
  const f = `units/u${String(i).padStart(2, '0')}.js`;
  const src = fs.readFileSync(f, 'utf8');
  let ast;
  try { ast = acorn.parse(src, OPTS); } catch (e) { console.log(f, 'PARSE FAIL', e.message); continue; }
  const classes = [], funcs = [], consts = [], defs = [];
  const exprNames = [];
  for (const n of ast.body) {
    if (n.type === 'ClassDeclaration') classes.push(n.id.name);
    else if (n.type === 'FunctionDeclaration') funcs.push(n.id.name);
    else if (n.type === 'VariableDeclaration') for (const d of n.declarations) {
      if (d.id && d.id.name) (d.init && (d.init.type === 'ObjectExpression' || d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')) ? consts.push(d.id.name) : consts.push(d.id.name);
    }
    else if (n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression') exprNames.push('call:' + (n.expression.callee.name || n.expression.callee.type));
  }
  const defHandlers = consts.filter(c => /^__GEN_DEFAULT_/.test(c));
  const version = (src.match(/VERSION[^,\n]{0,40}/) || [''])[0].slice(0, 40);
  const routes = [...new Set((src.match(/['"]\/(?:api|admin|panel|sub|vless|ws|warroom|telegram|health|stats)[^'"]{0,24}['"]/g) || []).map(s => s.replace(/['"]/g, '')))].slice(0, 14);
  console.log(`\n=== ${f} (${src.split('\n').length} lines) ===`);
  console.log('  version:', version);
  console.log('  classes:', classes.slice(0, 22).join(', '));
  console.log('  funcs  :', funcs.slice(0, 26).join(', '));
  console.log('  consts :', consts.slice(0, 18).join(', '));
  console.log('  routes :', routes.join(' '));
}
