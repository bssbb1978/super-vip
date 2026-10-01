import { boot } from './tests/helpers.mjs';
const qv = await boot();
const r = await qv.get('/__dbg/ss3');
console.log(await r.text());
await qv.dispose();
