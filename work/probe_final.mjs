/* final acceptance sweep against the built bundle */
import { boot } from './tests/helpers.mjs';
const qv = await boot();
const A = qv.auth();
const show = (label, v) => console.log(label.padEnd(34), typeof v === 'string' ? v : JSON.stringify(v));

const st = await qv.json('/api/selftest', { headers: A });
show('selftest', { passed: st.data.passed, failed: st.data.failed, ms: st.data.ms });

const h = await qv.json('/health');
show('health', { ok: h.data.ok, boot_id: h.data.boot_id, uptime_s: h.data.uptime_s, ns: Object.keys(h.data.features || {}).length, colo: h.data.colo });

const cronNames = (await qv.json('/api/cron', { headers: A })).data.tasks.map(t => t.id);
show('cron tasks', cronNames.length + ': ' + cronNames.join(','));
const sweep = await qv.post('/api/cron', { only: 'quota-sweep' }, A);
show('quota-sweep run', sweep.status);

const user = await qv.createUser({ name: 'final', quota_gb: 1, days: 5 });
const meter1 = await qv.post('/api/meter', { up: 1024, down: 4096 }, { 'x-api-token': 'test-api-token', 'x-qv-uuid': user.uuid });
show('meter', { status: meter1.status });
const after = (await qv.json('/api/users?limit=200', { headers: A })).data.items.find(u => u.uuid === user.uuid);
show('usage after meter', { used: after.used_bytes, up: after.up_bytes, down: after.down_bytes });

const sub = await qv.get('/sub/' + user.uuid);
const body = Buffer.from(await sub.text(), 'base64').toString('utf8');
show('sub nodes', body.split('\n').filter(Boolean).length + ' nodes, ' + body.split('\n').filter(l => l.startsWith('ss://')).length + ' ss');
const fmt = await qv.get('/sub/' + user.uuid + '?format=uris');
show('?format=uris', fmt.status + ' ' + fmt.headers.get('content-type'));
const clash = await qv.get('/sub/' + user.uuid + '?target=clash');
show('?target=clash', clash.status);
const sing = await qv.get('/sub/' + user.uuid + '?target=singbox');
show('?target=singbox', sing.status);

const strat = await qv.json('/api/strategy', { headers: A });
show('strategy', { shape: strat.data.shape, gen: strat.data.generation, frag: !!strat.data.fragment });
const dns = await qv.json('/api/dns', { headers: A });
show('dns', { upstreams: dns.data.upstreams.length, nat64: dns.data.nat64.map(p => p.cidr), tcp53: dns.data.tcp53_available });
const fsm = await qv.json('/api/fsm', { headers: A });
show('fsm rows', fsm.data.count);
const ai = await qv.json('/api/ai', { headers: A });
show('ai', { model: ai.data.active_model, models: (ai.data.models || []).length });
const qr = await qv.get('/api/qr?text=hello');
show('qr', qr.status + ' ' + qr.headers.get('content-type'));
const admin = await qv.get('/admin');
show('admin page', admin.status + ' ' + (await admin.text()).length + 'b');
const land = await qv.get('/');
show('landing', land.status + ' ' + (await land.text()).length + 'b');
const decoy = await qv.get('/random-probe-path-xyz');
show('unknown path', decoy.status);
const ops = await qv.get('/__qf/ops');
show('build ops endpoint', ops.status);
await qv.dispose();
