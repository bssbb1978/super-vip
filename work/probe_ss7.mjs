/* reproduce the 2022 stream round-trip outside the self-test */
import { boot } from './tests/helpers.mjs';
const qv = await boot();
const dec = (r) => (r.pieces || []).map(p => Buffer.from(p).toString('utf8')).join('');
/* drive the SSStream directly through an endpoint? no: reach it via QV */
const st = (await qv.json('/api/selftest?full=1', { headers: qv.auth() })).data;
const one = st.results.find(r => /2022 AEAD stream/.test(r.name));
console.log('detail length', (one.detail || '').length, 'ms', one.ms);
await qv.dispose();
