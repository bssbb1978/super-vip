/* Loads the core in plain Node (sockets stubbed) and prints the real QV surface,
   so any member the modules reference but never define becomes visible. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = fs.readFileSync('dist/core-only.js', 'utf8');
const stub = path.resolve('dist/sockets_stub.mjs');
fs.writeFileSync(stub, `export function connect() { throw new Error('sockets stub'); }\nexport const connect_ = connect;\n`);
const patched = src
  .replace(/import\s*\{\s*connect\s*\}\s*from\s*['"]cloudflare:sockets['"];?/, `import { connect } from '${pathToFileURL(stub).href}';`)
  .replace(/\bexport\s+default\b/g, 'const __default = ')
  .replace(/\bexport\s+\{[^}]*\};?/g, '')
  .replace(/\bexport\s+(const|let|var|function|class)\b/g, '$1')
  + '\nglobalThis.QV = QV;\nglobalThis.__SURFACE_READY__ = true;\n';
fs.writeFileSync('dist/surface.mjs', patched);
await import(pathToFileURL(path.resolve('dist/surface.mjs')).href + '?ts=' + Date.now());
const QV = globalThis.QV;
const out = {};
for (const [k, v] of Object.entries(QV)) {
  out[k] = (v && typeof v === 'object') ? Object.keys(v).sort() : typeof v;
}
console.log(JSON.stringify(out, null, 0));
