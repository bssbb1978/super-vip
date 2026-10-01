import { boot } from './tests/helpers.mjs';
const qv = await boot();
const st = (await qv.json('/api/selftest?full=1', { headers: qv.auth() })).data;
console.log('failed:', JSON.stringify(st.failed));
/* run the same code the self-test runs, but print the details */
const res = st.results.filter(r => /2022 AEAD stream/.test(r.name));
console.log(JSON.stringify(res, null, 1).slice(0, 600));
await qv.dispose();
