import { boot } from './tests/helpers.mjs';
const qv = await boot();
const st = (await qv.json('/api/selftest?full=1', { headers: qv.auth() })).data;
console.log('selftest keys:', Object.keys(st).join(','));
console.log(JSON.stringify(st.suites, null, 1).slice(0, 900));
console.log('summary', JSON.stringify(st.summary), 'failed', (st.failed || []).length);
await qv.dispose();
