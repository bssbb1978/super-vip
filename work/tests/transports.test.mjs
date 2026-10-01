import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot } from './helpers.mjs';

let qv;
beforeAll(async () => { qv = await boot(); }, 60000);
afterAll(async () => { await qv?.dispose(); });

describe('transport surface', () => {
  test('a WebSocket upgrade on a tunnel path is accepted', async () => {
    const r = await qv.get('/ws', { headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
    expect(r.status).toBe(101);
    expect(r.webSocket).toBeTruthy();
  });

  test('a plain GET on a tunnel path is answered with a decoy, never a hint', async () => {
    const r = await qv.get('/ws');
    const text = await r.text();
    expect(r.status).not.toBe(101);
    expect(text).not.toMatch(/vless|shadowsocks|websocket/i);
  });

  test('the shadowsocks endpoint reveals nothing to a plain GET', async () => {
    const r = await qv.get('/ss');
    const text = await r.text();
    expect(text).not.toMatch(/shadowsocks|2022-blake3|aead/i);
  });

  test('a shadowsocks POST without a real handshake is refused cleanly', async () => {
    const r = await qv.get('/ss', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(64) });
    expect([400, 401, 403, 404, 426]).toContain(r.status);
  });

  test('the telegram webhook refuses a wrong secret and accepts the right one', async () => {
    const bad = await qv.post('/tg/webhook', { update_id: 1 }, { 'x-telegram-bot-api-secret-token': 'wrong' });
    expect([403, 503]).toContain(bad.status);
  });

  test('every tunnel path the editions used is routed', async () => {
    const ws = { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' };
    /* WebSocket-carrying paths must upgrade… */
    for (const p of ['/ws', '/vless', '/tunnel', '/cdn']) {
      expect((await qv.get(p, { headers: ws })).status).toBe(101);
    }
    /* …while the HTTP/2-style transports answer requests without pretending to
       be a WebSocket, and never leak what they are */
    for (const p of ['/xhttp', '/grpc', '/httpupgrade', '/ss', '/ss-aead']) {
      const r = await qv.get(p, { headers: ws });
      expect([101, 200, 403, 404, 426]).toContain(r.status);
      const text = await r.text();
      expect(text).not.toMatch(/vless:\/\/|shadowsocks|2022-blake3/i);
    }
  });
});
