/* An active prober replays a salt it captured.  The second use of the same
   salt must die silently — no echo, no error, nothing that confirms a proxy. */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot } from './helpers.mjs';
import { ClientSS, b64d, startEcho, openTunnel, reader, v4Addr } from './ssclient.mjs';

let qv, echo, echoPort, method, password;
beforeAll(async () => {
  echo = await startEcho();
  echoPort = echo.port;
  qv = await boot();
  const user = await qv.createUser({ name: 'replay', quota_gb: 5, days: 10 });
  const text = Buffer.from(await (await qv.get('/sub/' + user.uuid)).text(), 'base64').toString('utf8');
  const uri = text.split('\n').find(l => l.startsWith('ss://') && !l.includes('2022-blake3'));
  const info = b64d(uri.match(/^ss:\/\/([^@]+)@/)[1]).toString('utf8');
  [method, password] = info.split(':');
}, 60000);
afterAll(async () => { await qv?.dispose(); await echo?.close(); });

describe('active-probing defences', () => {
  test('a replayed salt is dropped without a single byte of answer', async () => {
    /* first connection: a legitimate client, its salt is now on record */
    const ws1 = await openTunnel(qv, '/ss');
    const c1 = new ClientSS(method, password);
    const r1 = reader(ws1, c1);
    ws1.send(c1.hello());
    ws1.send(c1.push(Buffer.concat([v4Addr(echoPort), Buffer.from('hello-there')])));
    expect(await r1.next()).toContain('hello-there');

    /* the prober replays exactly the same salt on a fresh socket */
    const ws2 = await openTunnel(qv, '/ss');
    const c2 = new ClientSS(method, password);
    c2.encSalt = c1.encSalt;                       // the captured salt…
    c2.encKey = c1.encKey;                         // …and the key derived from it
    const r2 = reader(ws2, c2);
    ws2.send(c2.encSalt);
    ws2.send(c2.push(Buffer.concat([v4Addr(echoPort), Buffer.from('hello-there')])));

    /* the socket goes quiet and the replay is counted */
    expect(await r2.next(1500)).toBe('');
    const health = await qv.json('/health');
    expect(health.data.counters.ss_salt_replay || 0).toBeGreaterThan(0);
  });

  test('a fresh salt on the same account still works (no false positive)', async () => {
    const ws = await openTunnel(qv, '/ss');
    const c = new ClientSS(method, password);
    const r = reader(ws, c);
    ws.send(c.hello());
    ws.send(c.push(Buffer.concat([v4Addr(echoPort), Buffer.from('after-replay')])));
    expect(await r.next()).toContain('after-replay');
  });
});
