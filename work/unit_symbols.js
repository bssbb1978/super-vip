/* ═══════════════════════════════════════════════════════════════════════════
 * unit_symbols.js — static analysis used by assemble.js
 *   For every unit: which identifiers does its *deferred* top-level code
 *   reference that nothing in the bundle defines?  Those names become global
 *   lazy getters pointing at the bridge, so historic helper calls
 *   (__export, init_chunk_*, testX…) resolve at call time instead of throwing
 *   at startup.  Pure analysis: no source is ever rewritten.
 * ═══════════════════════════════════════════════════════════════════════════ */
const acorn = require('acorn');

const GLOBALS = new Set([
  'console', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'TextEncoder', 'TextDecoder',
  'URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'fetch', 'crypto', 'atob', 'btoa', 'setTimeout',
  'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'structuredClone', 'globalThis', 'navigator',
  'WebSocket', 'WebSocketPair', 'AbortController', 'AbortSignal', 'ReadableStream', 'WritableStream', 'TransformStream',
  'FormData', 'Blob', 'File', 'Intl', 'Reflect', 'Proxy', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'Infinity', 'NaN', 'undefined', 'eval',
  'performance', 'process', 'Buffer', 'module', 'exports', 'require', '__dirname', '__filename', 'global',
  'QV', '__QF', '__QF_MODULES__', '__QV_LEGACY', '__qfSym', '__qfSideFail', 'arguments', 'this',
]);

/** names a statement declares locally (function/class/var/let/const, params) */
const collectDeclared = (node, into) => {
  const visit = (n, isRoot) => {
    if (!n || typeof n.type !== 'string') return;
    switch (n.type) {
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        if (n.id && n.id.name) into.add(n.id.name);
        for (const p of n.params || []) {
          if (p.type === 'Identifier') into.add(p.name);
          else if (p.type === 'ObjectPattern') for (const pr of p.properties) if (pr.value && pr.value.type === 'Identifier') into.add(pr.value.name);
          else if (p.type === 'ArrayPattern') for (const el of p.elements || []) if (el && el.type === 'Identifier') into.add(el.name);
          else if (p.type === 'AssignmentPattern' && p.left && p.left.type === 'Identifier') into.add(p.left.name);
        }
        break;
      }
      case 'VariableDeclaration':
        for (const d of n.declarations) {
          if (d.id.type === 'Identifier') into.add(d.id.name);
          else if (d.id.type === 'ObjectPattern') {
            const walkPat = (pat) => {
              if (!pat) return;
              if (pat.type === 'Identifier') into.add(pat.name);
              else if (pat.type === 'ObjectPattern') for (const pr of pat.properties) walkPat(pr.value || pr.argument);
              else if (pat.type === 'ArrayPattern') for (const el of pat.elements) walkPat(el);
              else if (pat.type === 'AssignmentPattern') walkPat(pat.left);
              else if (pat.type === 'RestElement') walkPat(pat.argument);
            };
            walkPat(d.id);
          } else if (d.id.type === 'ArrayPattern') for (const el of d.id.elements || []) { if (el && el.type === 'Identifier') into.add(el.name); }
        }
        break;
      case 'ClassDeclaration': if (n.id && n.id.name) into.add(n.id.name); break;
      case 'ImportDeclaration':
        for (const s of n.specifiers || []) if (s.local && s.local.name) into.add(s.local.name);
        break;
      default: break;
    }
    void isRoot;
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === 'string') visit(c);
      } else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(node, true);
  return into;
};

/** every identifier token in a statement (property keys included — a name that
 *  turns out to be a key is only ever a harmless lazy global) */
const collectRefs = (node, into) => {
  const declared = collectDeclared(node, new Set());
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Identifier') { into.add(n.name); return; }
    if (n.type === 'Literal' || n.type === 'TemplateElement') return;
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === 'string') walk(c);
      } else if (child && typeof child.type === 'string') walk(child);
    }
  };
  walk(node);
  for (const d of declared) into.delete(d);
  return into;
};

/** unresolved free names inside the deferred statements of a unit */
const unresolvedIn = (deferredStatements, unitDeclared) => {
  const out = new Set();
  for (const d of deferredStatements) {
    let ast;
    try {
      ast = acorn.parse(d.text, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
    } catch (e) { continue; }
    const refs = new Set();
    for (const st of ast.body) collectRefs(st, refs);
    for (const name of refs) {
      if (unitDeclared.has(name) || GLOBALS.has(name)) continue;
      out.add(name);
    }
  }
  return [...out];
};

/** every reference the unit makes minus every name it declares anywhere minus
 *  the platform globals: i.e. the symbols this bundle expects someone else to
 *  provide.  The merged editions referenced each other's handlers, so this is
 *  exactly the set that has to be stitched back together. */
const unitFreeNames = (src) => {
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (e) { return { free: [], error: e.message }; }
  const all = new Set();
  for (const node of ast.body) collectRefs(node, all);
  const declared = new Set();
  for (const node of ast.body) collectDeclared(node, declared);
  const free = [...all].filter(n => !declared.has(n) && !GLOBALS.has(n));
  return { free, refs: all.size, declared: declared.size };
};

/** names declared in the unit's own top level (what its scope object exposes) */
const unitTopDeclared = (src) => {
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (e) { return new Set(); }
  const out = new Set();
  for (const n of ast.body) {
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) out.add(n.id.name);
    else if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations) {
        if (d.id.type === 'Identifier') out.add(d.id.name);
        else if (d.id.type === 'ObjectPattern') for (const pr of d.id.properties) if (pr.value && pr.value.type === 'Identifier') out.add(pr.value.name);
        else if (d.id.type === 'ArrayPattern') for (const el of d.id.elements || []) if (el && el.type === 'Identifier') out.add(el.name);
      }
    }
  }
  return out;
};

/** every identifier mentioned anywhere in the unit (references and keys) */
const unitAllRefs = (src) => {
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (e) { return new Set(); }
  const all = new Set();
  for (const node of ast.body) collectRefs(node, all);
  return all;
};

module.exports = { GLOBALS, unresolvedIn, collectDeclared, collectRefs, unitFreeNames, unitTopDeclared, unitAllRefs };
