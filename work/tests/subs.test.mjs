import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot } from './helpers.mjs';

let qv, uuid;
beforeAll(async () => { qv = await boot(); uuid = (await qv.createUser({ name: 'sub-user', quota_gb: 10 })).uuid; }, 60000);
afterAll(async () => { await qv?.dispose(); });

const decodeB64 = (s) => Buffer.from(s.replace(/\s/g, ''), 'base64').toString('utf8');
/* an ss:// node keeps its cipher:password pair in base64 inside the userinfo */
const userinfo = (uri) => {
  const m = uri.match(/^ss:\/\/([^@]+)@/);
  if (!m) return '';
  try { return Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return ''; }
};

describe('subscription rendering', () => {
  test('the base64 profile carries vless + both shadowsocks variants', async () => {
    const r = await qv.get('/sub/' + uuid);
    expect(r.status).toBe(200);
    const text = decodeB64(await r.text());
    expect(text).toMatch(/vless:\/\//);
    expect(text).toMatch(/ss:\/\//);
    expect(text).toMatch(/2022-blake3-chacha20-poly1305/);
    /* the legacy AEAD node hides cipher:password in its userinfo */
    const infos = text.split('\n').filter(l => l.startsWith('ss://') && !l.includes('2022-blake3')).map(userinfo);
    expect(infos.some(i => i.startsWith('aes-128-gcm:') && i.length > 16)).toBe(true);
    expect(text.split('\n').some(l => l.startsWith('ss://2022-blake3-chacha20-poly1305:') && !l.includes('undefined'))).toBe(true);
  });

  test('the userinfo header reports the quota counters', async () => {
    const r = await qv.get('/sub/' + uuid);
    const ui = r.headers.get('subscription-userinfo') || '';
    expect(ui).toMatch(/upload=\d+/);
    expect(ui).toMatch(/download=\d+/);
    expect(ui).toMatch(/total=\d+/);
  });

  test('clash / mihomo profile is generated with fragment-friendly settings', async () => {
    const r = await qv.get('/sub/' + uuid + '?target=clash');
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).toMatch(/proxies:/);
    expect(text).toMatch(/ws-opts/);
    expect(text).toMatch(/client-fingerprint/);
  });

  test('sing-box profile is valid JSON and hints at TLS fragmentation', async () => {
    const r = await qv.get('/sub/' + uuid + '?target=singbox');
    const j = JSON.parse(await r.text());
    expect(Array.isArray(j.outbounds)).toBe(true);
    expect(JSON.stringify(j)).toMatch(/fragment/);
  });

  test('every node carries a clean-IP or hostname target', async () => {
    const r = await qv.get('/sub/' + uuid + '?format=uris');
    const lines = (await r.text()).trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(l).toMatch(/^(vless|ss):\/\//);
  });

  test('a revoked account receives no configuration at all', async () => {
    const tmp = await qv.createUser({ name: 'revoked' });
    await qv.patch('/api/users/' + tmp.uuid, { killswitch: 1 }, qv.auth());
    const r = await qv.get('/sub/' + tmp.uuid);
    expect(r.status).toBe(403);
    const body = await r.text();
    expect(body).not.toMatch(/vless:\/\//);
  });

  test('the QR endpoint renders a scannable SVG', async () => {
    const r = await qv.get('/qr?d=' + encodeURIComponent('vless://x@y:443') + '&s=4');
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).toMatch(/<svg/);
    expect(text).toMatch(/<rect/);
  });
});
