import { boot } from './tests/helpers.mjs';
const qv = await boot();
const A = qv.auth();
const u = await qv.createUser({ name: 'state-probe2', quota_bytes: 2000, days: 5 });
const dump = async (label) => {
  const d = (await qv.json('/__dbg/state?u=' + u.uuid)).data;
  console.log(label.padEnd(16), 'sub=' + (await qv.get('/sub/' + u.uuid)).status,
    '| row ks=' + d.row.killswitch, 'used=' + d.row.used_bytes,
    '| snap=' + JSON.stringify(d.kvSnap && { ks: d.kvSnap.killswitch, used: d.kvSnap.used_bytes }),
    '| d1kv=' + JSON.stringify(d.d1KvRow && { ks: JSON.parse(d.d1KvRow.value).killswitch, used: JSON.parse(d.d1KvRow.value).used_bytes }),
    '| state=' + JSON.stringify(d.state && { ks: d.state.killswitch, used: d.state.used_bytes }));
};
await dump('start');
await qv.post('/api/meter', { uuid: u.uuid, up: 5000, down: 0 }, A);
await dump('after overrun');
await qv.patch('/api/users/' + u.uuid, { killswitch: 0, enabled: 1, used_bytes: 0 }, A);
await dump('after revive');
await qv.dispose();
