/* Third protocol, end to end: a real Shadowsocks-AEAD client, written against
   the wire format only, relays bytes through the Worker to a TCP echo server. */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot } from './helpers.mjs';
import { ClientSS, b64d, startEcho, openTunnel, reader, v4Addr } from './ssclient.mjs';

let qv, echo, echoPort;
beforeAll(async () => {
  echo = await startEcho();
  echoPort = echo.port;
  qv = await boot({ SS_DEBUG: '1' });
}, 60000);
afterAll(async () => { await qv?.dispose(); await echo?.close(); });

/** open a tunnel socket on this boot */
const open = (p = '/ss') => openTunnel(qv, p);

describe('shadowsocks AEAD, end to end', () => {
  test('the subscription hands out a usable per-user AEAD credential', async () => {
    const user = await qv.createUser({ name: 'ss-user', quota_gb: 5, days: 10 });
    const r = await qv.get('/sub/' + user.uuid);
    const text = Buffer.from(await r.text(), 'base64').toString('utf8');
    const uri = text.split('\n').find(l => l.startsWith('ss://Y') || (l.startsWith('ss://') && !l.includes('2022-blake3')));
    expect(uri).toBeTruthy();
    const info = b64d(uri.match(/^ss:\/\/([^@]+)@/)[1]).toString('utf8');
    const [method, password] = info.split(':');
    expect(method).toBe('aes-128-gcm');
    expect(password.length).toBeGreaterThanOrEqual(16);

    /* now use it: handshake, address header for the echo server, then echo */
    const ws = await open('/ss');
    const ss = new ClientSS(method, password);
    const ch = reader(ws, ss);
    ws.send(ss.hello());
    const ip = Buffer.from([127, 0, 0, 1]);
    const addr = Buffer.concat([Buffer.from([1]), ip, Buffer.from([echoPort >> 8, echoPort & 0xff])]);
    ws.send(ss.push(Buffer.concat([addr, Buffer.from('ping-through-the-tunnel')])));

    const echo = await ch.next();
    expect(echo).toContain('ping-through-the-tunnel');

    /* a second round trip proves the stream state is kept */
    ws.send(ss.push(Buffer.from('again')));
    const second = await ch.next();
    expect(second).toContain('again');

    /* while the tunnel is up the session is attributed to its owner */
    const live = await qv.json('/api/sessions', { headers: qv.auth() });
    expect((live.data.items || []).filter(s => s.uuid === user.uuid).length).toBeGreaterThan(0);

    /* and when it ends the traffic lands on the account, which is what a
       per-user quota cut-off is computed from */
    ws.close();
    await new Promise(r => setTimeout(r, 400));
    const { data } = await qv.json('/api/users', { headers: qv.auth() });
    const row = (data.items || []).find(u => u.uuid === user.uuid);
    expect(row.used_bytes).toBeGreaterThan(0);
    expect(row.up_bytes).toBeGreaterThan(0);
  });

  test('a wrong credential gets silence, not an error message', async () => {
    const ws = await open('/ss');
    const ss = new ClientSS('aes-128-gcm', 'this-password-belongs-to-nobody-at-all');
    const ch = reader(ws, ss);
    ws.send(ss.hello());
    ws.send(ss.push(Buffer.from([1, 127, 0, 0, 1, 0, 80])));
    /* nothing is echoed back and nothing is explained: the socket just stays
       quiet, exactly like a server that was never listening on this path */
    const got = await ch.next(1500);
    expect(got).toBe('');
  });

  test('a prober who does not upgrade the socket learns nothing', async () => {
    const r = await qv.get('/ss');
    expect(r.status).not.toBe(101);
    expect(await r.text()).not.toMatch(/shadowsocks|SS_PASSWORD|cipher|2022-blake3/i);
  });
});
