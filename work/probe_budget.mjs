import { boot } from './tests/helpers.mjs';
import { ClientSS, b64d, startEcho, openTunnel, reader, v4Addr } from './tests/ssclient.mjs';
const qv = await boot();
const A = qv.auth();
const echo = await startEcho();
const users = [];
for (let i = 0; i < 20; i++) users.push((await qv.createUser({ name: 'bud-' + i, quota_gb: 2 })).uuid);
for (const u of users) { await qv.get('/sub/' + u); await qv.json('/api/users/' + u, { headers: A }); await qv.post('/api/meter', { uuid: u, up: 900, down: 1800 }, A); }
/* two real tunnels so the SS caches see traffic */
const text = Buffer.from(await (await qv.get('/sub/' + users[0])).text(), 'base64').toString('utf8');
const uri = text.split('\n').find(l => l.startsWith('ss://') && !l.includes('2022-blake3'));
const [method, password] = b64d(uri.match(/^ss:\/\/([^@]+)@/)[1]).toString('utf8').split(':');
for (let i = 0; i < 2; i++) {
  const ws = await openTunnel(qv, '/ss');
  const c = new ClientSS(method, password);
  const r = reader(ws, c);
  ws.send(c.hello());
  ws.send(c.push(Buffer.concat([v4Addr(echo.port), Buffer.from('shape-test-' + i)])));
  await r.next();
  ws.close();
}
await qv.post('/api/cron', { only: 'metrics-rollup', force: true }, A);
const h = (await qv.json('/health')).data;
console.log('memory:', JSON.stringify(h.memory));
console.log('meter_queue:', h.meter_queue);
for (const c of h.caches) console.log(' ', c.name.padEnd(14), 'size', String(c.size).padStart(4), '/', String(c.max).padEnd(5), 'bytes', String(c.bytes).padStart(7), '/', String(c.max_bytes).padEnd(8), 'hit', c.hit_rate, 'evict', c.evictions);
const counters = h.counters;
console.log('counters:', JSON.stringify(Object.fromEntries(Object.entries(counters).filter(([k]) => /ss_|d1_|kv_|fsm|meter|unit|requests|job/.test(k)))));
await echo.close(); await qv.dispose();
