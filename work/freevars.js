/* Free-variable analysis: for every unit, list identifiers referenced at top
 * level but not declared there - i.e. what the merge must supply. */
const fs = require('fs');
const acorn = require('acorn');
const walk = require('acorn-walk');
const OPTS = { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true };

const GLOBALS = new Set(['console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect', 'Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView', 'ArrayBuffer', 'SharedArrayBuffer', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'URL', 'URLSearchParams', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'File', 'ReadableStream', 'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'WebSocket', 'fetch', 'crypto', 'atob', 'btoa', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'structuredClone', 'performance', 'navigator', 'globalThis', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'undefined', 'NaN', 'Infinity', 'Error', 'EvalError', 'SyntaxError', 'URIError', 'Function', 'BigInt', 'escape', 'unescape', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'Event', 'CustomEvent', 'process', 'require', 'module', 'exports', 'document', 'window', 'self', 'top', 'location', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'caches', 'CacheStorage', 'Cache', 'Intl', 'AggregateError', 'FinalizationRegistry', 'WeakRef', 'setImmediate', 'eval', 'arguments', 'ImageData', 'OffscreenCanvas', 'createImageBitmap', 'FileReader', 'requestAnimationFrame', 'cancelAnimationFrame', 'scheduler', 'ScheduledTask', 'MutationObserver', 'EventSource', 'URLPattern', 'MessageChannel', 'MessagePort', 'BroadcastChannel', 'CompressionStream', 'DecompressionStream', 'crypto', 'Connection', 'connect', '__QF_MODULES__', '__QF__']);

const units = [];
const declOf = [];
for (let i = 0; i <= 10; i++) {
  const f = `units/u${String(i).padStart(2, '0')}.js`;
  const src = fs.readFileSync(f, 'utf8');
  const ast = acorn.parse(src, OPTS);
  const declared = new Set();
  for (const n of ast.body) {
    if (n.type === 'ClassDeclaration' || n.type === 'FunctionDeclaration') declared.add(n.id.name);
    else if (n.type === 'VariableDeclaration') for (const d of n.declarations) {
      if (d.id.type === 'Identifier') declared.add(d.id.name);
      else if (d.id.type === 'ObjectPattern') for (const p of d.id.properties) if (p.value && p.value.name) declared.add(p.value.name);
      else if (d.id.type === 'ArrayPattern') for (const p of d.id.elements) if (p && p.name) declared.add(p.name);
    }
  }
  const refs = new Set();
  walk.full(ast, (node) => {
    if (node.type === 'Identifier') refs.add(node.name);
    if (node.type === 'MemberExpression' && node.property && node.property.type === 'Identifier' && !node.computed) { /* property names are not refs */ }
  });
  // remove property keys / labels roughly (full-simple keeps them); acceptable approximation
  const free = [...refs].filter(r => !declared.has(r) && !GLOBALS.has(r));
  units.push({ i, f, declared, free, src });
  declOf.push({ i, declared });
}

console.log('--- free identifiers per unit (excluding globals) ---');
for (const u of units) {
  const elsewhere = new Set();
  declOf.forEach(d => { if (d.i !== u.i) d.declared.forEach(n => elsewhere.add(n)); });
  const crossUnit = u.free.filter(n => elsewhere.has(n));
  const unknown = u.free.filter(n => !elsewhere.has(n) && !/^(__|_)/.test(n));
  console.log(`\nu${String(u.i).padStart(2, '0')}: declared=${u.declared.size} free=${u.free.length}`);
  console.log('   cross-unit refs :', crossUnit.slice(0, 30).join(', ') || '(none)');
  console.log('   unresolved refs :', unknown.slice(0, 30).join(', ') || '(none)');
}
