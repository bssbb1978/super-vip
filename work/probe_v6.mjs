import { boot } from './tests/helpers.mjs';
const qv = await boot();
const r = await qv.json('/api/selftest?full=1', { headers: qv.auth() });
const res = (r.data.results || []).filter(x => x.suite === 'endpoints');
for (const c of res) console.log((c.pass === false ? 'FAIL ' : 'ok   ') + c.name + ' :: ' + (c.detail || ''));
await qv.dispose();
