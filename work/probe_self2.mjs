import { boot } from './tests/helpers.mjs';
const qv = await boot();
const st = (await qv.json('/api/selftest?full=1', { headers: qv.auth() })).data;
for (const f of st.failed || []) console.log('FAIL:', JSON.stringify(f));
console.log('warnings:', JSON.stringify((st.warnings || []).slice(0, 3)));
await qv.dispose();
