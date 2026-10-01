import { boot } from './tests/helpers.mjs';
const qv = await boot();
const A = qv.auth();
/* 1. live provider discovery */
const t0 = Date.now();
const r = await qv.post('/api/cron', { only: 'ip-ranges', force: true }, A);
const j = await r.json();
console.log('ip-ranges', r.status, JSON.stringify(j.data.results['ip-ranges']).slice(0, 240), 'ms', Date.now() - t0);
const audit = (await qv.json('/api/endpoints', { headers: A })).data;
for (const p of audit.providers) console.log('  provider', p.id.padEnd(15), p.source.padEnd(16), 'v4=' + String(p.v4).padStart(4), 'v6=' + String(p.v6).padStart(3), p.usable_as.join('+'));
/* 2. edge probe: what does the runtime actually do with a Cloudflare address? */
const e = await qv.post('/api/cron', { only: 'ip-edge', force: true }, A);
const ej = await e.json();
console.log('ip-edge', e.status, JSON.stringify(ej.data.results['ip-edge']).slice(0, 200));
const edge = await qv.post('/api/ips', { action: 'scan', limit: 4 }, A);
const ed = (await edge.json()).data;
console.log('edge probe samples:', JSON.stringify((ed.items || []).slice(0, 4)));
/* 3. refill + pool health */
const f = await qv.post('/api/cron', { only: 'ip-refill', force: true }, A);
console.log('ip-refill', f.status, JSON.stringify((await f.json()).data.results['ip-refill']).slice(0, 200));
await qv.dispose();
