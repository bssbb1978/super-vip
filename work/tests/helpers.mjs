/* ═══════════════════════════════════════════════════════════════════════════
 * tests/helpers.mjs — one real workerd isolate per test file
 *   Every suite boots the *built* artifact (../worker.js) through miniflare
 *   with a real D1 database and a real KV namespace, so what the tests exercise
 *   is exactly what Cloudflare will run.
 * ═══════════════════════════════════════════════════════════════════════════ */
import { Miniflare, Log, LogLevel } from 'miniflare';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT = process.env.QV_SCRIPT || path.join(here, '..', 'dist', 'worker.js');

export const ADMIN_PASSWORD = 'test-pass';
export const API_TOKEN = 'test-api-token';
export const TG_SECRET = 'test-tg-secret';
export const TG_TOKEN = '123456:TEST-TOKEN';

export async function boot(extraBindings = {}) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: SCRIPT,
    // Resolve the module name relative to the bundle's own directory. Without this,
    // a bundle that lives outside the cwd (CI: <repo>/dist while cwd is <repo>/work)
    // becomes '../dist/worker.js' and workerd refuses it ("can't use '..' to break out
    // of starting directory").
    modulesRoot: path.dirname(SCRIPT),
    compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'qv-itest' },
    kvNamespaces: { KVU_KV: 'qv-itest-kv' },
    bindings: {
      ADMIN_PASSWORD,
      API_SECRET_TOKEN: API_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: TG_SECRET,
      CUSTOM_DOMAIN: 'node.example.dev',
      HOSTS: 'node.example.dev,node2.example.dev',
      ...extraBindings,
    },
    log: new Log(LogLevel.ERROR),
    unsafeEphemeralDurableObjects: true,
  });
  const base = 'http://node.example.dev';
  const api = {
    mf,
    base,
    get: (p, init) => mf.dispatchFetch(base + p, init),
    post: (p, body, headers = {}) => mf.dispatchFetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    }),
    patch: (p, body, headers = {}) => mf.dispatchFetch(base + p, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    }),
    del: (p, headers = {}) => mf.dispatchFetch(base + p, { method: 'DELETE', headers }),
    auth: (extra = {}) => ({ 'x-api-token': API_TOKEN, ...extra }),
    async json(p, init) {
      const r = await api.get(p, init);
      let j = null;
      try { j = await r.json(); } catch (e) { /* not json */ }
      return { r, j, data: j && j.data !== undefined ? j.data : j };
    },
    async createUser(fields = {}) {
      const res = await api.post('/api/users', { name: 'itest', quota_gb: 10, days: 30, ...fields }, api.auth());
      return (await res.json()).data?.item;
    },
    async dispose() { await mf.dispose(); },
  };
  await api.get('/health');
  return api;
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** minimal DNS wire builder for the DoH tests */
export function buildDnsQuery(name, type = 1, id = 0x1234) {
  const parts = [new Uint8Array([id >> 8, id & 0xff, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0])];
  const labels = name.split('.').filter(Boolean);
  for (const l of labels) parts.push(new Uint8Array([l.length, ...new TextEncoder().encode(l)]));
  parts.push(new Uint8Array([0, type >> 8, type & 0xff, 0, 1]));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const toB64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
