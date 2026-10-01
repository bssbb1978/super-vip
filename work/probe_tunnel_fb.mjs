/* End-to-end verification of the authenticated tunnel-feedback signal:
   open a real WS, send a real VLESS header for a real account to a real
   upstream (miniflare's own loopback HTTP server), then look for the row. */
import { boot } from './tests/helpers.mjs';

const qv = await boot();
const A = qv.auth();
const user = await qv.createUser({ name: 'tfb', quota_gb: 5 });
const origin = await qv.mf.ready;                    // http://127.0.0.1:<port>
const port = Number(new URL(origin).port);

const hex = user.uuid.replace(/-/g, '');
const frame = new Uint8Array(22);
frame[0] = 0;                                        // version
for (let i = 0; i < 16; i++) frame[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
frame[17] = 0;                                       // no addons
frame[18] = 1;                                       // command: tcp
frame[19] = (port >> 8) & 0xff; frame[20] = port & 0xff;
frame[21] = 1;                                       // ATYP ipv4
const full = new Uint8Array(26); full.set(frame); full.set([127, 0, 0, 1], 22);

const res = await qv.get('/ws/' + user.uuid + '?ep=' + encodeURIComponent('104.16.0.1'), {
  headers: { upgrade: 'websocket', host: 'node.example.dev', 'cf-connecting-ip': '5.5.5.5' },
});
const ws = res.webSocket;
console.log('upgrade:', res.status, '| ws:', !!ws);
if (!ws) { await qv.dispose(); process.exit(0); }
ws.accept();
ws.send(full.buffer);
await new Promise(r => setTimeout(r, 900));
const flush = await (await qv.post('/api/ips', { action: 'flush' }, A)).json();
console.log('flush:', JSON.stringify(flush.data));
const db = await qv.mf.getD1Database('DB');
const rows = (await db.prepare("SELECT ip, scope, provider, family, samples, ok, ws_ok FROM qv_ip_scores WHERE provider = 'tunnel'").all()).results;
console.log('tunnel rows:', JSON.stringify(rows));
const seen = (await qv.json('/health', { headers: A })).data.counters;
console.log('counters:', JSON.stringify(Object.fromEntries(Object.entries(seen).filter(([k]) => k.startsWith('ci_')))));
await qv.dispose();
