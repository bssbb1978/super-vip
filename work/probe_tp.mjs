/* which tunnel path answers 503? */
import { boot } from './tests/helpers.mjs';
const qv = await boot();
const ws = { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' };
for (const p of ['/ws', '/vless', '/tunnel', '/cdn', '/xhttp', '/grpc', '/httpupgrade', '/ss', '/ss-aead', '/httpupgrade/', '/xhttp/', '/grpc/']) {
  try {
    const r = await qv.get(p, { headers: ws });
    let body = '';
    try { body = (await r.text()).slice(0, 70).replace(/\s+/g, ' '); } catch (e) { body = '<' + e.message + '>'; }
    console.log(String(r.status).padEnd(4), p.padEnd(14), 'ws:' + (r.webSocket ? 'yes' : 'no '), body);
  } catch (e) { console.log('ERR ', p, e.message); }
}
await qv.dispose();
