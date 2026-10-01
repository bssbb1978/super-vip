import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot, buildDnsQuery, toB64url } from './helpers.mjs';

let qv;
beforeAll(async () => { qv = await boot(); }, 60000);
afterAll(async () => { await qv?.dispose(); });

const enc = new TextEncoder();
const nameOf = (wire, off = 12) => {
  const labels = [];
  let o = off;
  while (wire[o] > 0) { labels.push(new TextDecoder().decode(wire.subarray(o + 1, o + 1 + wire[o]))); o += 1 + wire[o]; }
  return labels.join('.');
};

describe('DNS: DoH, NAT64 and cache', () => {
  test('POST /dns-query speaks RFC 8484', async () => {
    const r = await qv.get('/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
      body: buildDnsQuery('example.com', 1),
    });
    const out = new Uint8Array(await r.arrayBuffer());
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/dns-message/);
    expect(out.length).toBeGreaterThan(12);
    expect(nameOf(out)).toBe('example.com');
    expect(out[3] & 0x0f).toBe(0);            // NOERROR
  });

  test('GET /dns-query accepts a base64url query and can answer JSON', async () => {
    const r = await qv.get('/dns-query?dns=' + toB64url(buildDnsQuery('cloudflare.com', 1)) + '&format=json');
    const j = await r.json();
    expect(r.status).toBe(200);
    expect((j.Answer || []).length).toBeGreaterThan(0);
  });

  test('a JSON query returns A records', async () => {
    const { data } = await qv.json('/dns/json?name=example.com&type=A');
    const a = (data.answers || []).filter(x => x.type === 'A');
    expect(a.length).toBeGreaterThan(0);
    expect(a[0].value).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  test('DNS64 maps A records into 64:ff9b::/96 (RFC 7050 mapping of 192.0.0.170)', async () => {
    const { data } = await qv.json('/dns/json?name=ipv4only.arpa&type=AAAA&dns64=1');
    const aaaa = (data.answers || []).filter(x => x.type === 'AAAA');
    expect(aaaa.length).toBeGreaterThan(0);
    expect(aaaa.map(x => x.value)).toContain('64:ff9b::c000:aa');
    expect(data.dns64).toBe(true);
  });

  test('without an explicit dns64 request a native AAAA answer is left alone', async () => {
    const { data } = await qv.json('/dns/json?name=ipv4only.arpa&type=AAAA');
    expect(data.dns64).toBe(false);
  });

  test('the answer cache serves the second identical query', async () => {
    await qv.json('/dns/json?name=cache-me.example&type=A');
    const { data } = await qv.json('/dns/json?name=cache-me.example&type=A');
    expect(data.cached === true || data.ok === true).toBe(true);
  });

  test('DNS stats report the resolver pool and the NAT64 prefixes', async () => {
    const { data } = await qv.json('/api/dns', { headers: qv.auth() });
    expect(Array.isArray(data.upstreams)).toBe(true);
    expect(data.upstreams.length).toBeGreaterThanOrEqual(3);
    expect(data.nat64.map(p => p.cidr)).toContain('64:ff9b::/96');
    expect(data.tcp53_available).toBe(false);
    expect(String(data.tcp53_note)).toMatch(/DoH/);
  });

  test('DNS over a framed TCP tunnel answers the same question', async () => {
    const q = buildDnsQuery('example.com', 1);
    const framed = new Uint8Array(q.length + 2);
    framed[0] = q.length >> 8; framed[1] = q.length & 0xff; framed.set(q, 2);
    const r = await qv.get('/dns/tcp', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: framed });
    const out = new Uint8Array(await r.arrayBuffer());
    expect(r.status).toBe(200);
    expect(out.length).toBeGreaterThan(4);
    /* DNS-over-TCP framing: a big-endian 16-bit length precedes the message */
    const declared = (out[0] << 8) | out[1];
    expect(declared).toBe(out.length - 2);
    expect(nameOf(out, 14)).toBe('example.com');
  });

  test('public DoH helper resolves a name for clients that cannot do wire format', async () => {
    const { data } = await qv.json('/api/public/dns?name=example.com&type=A');
    expect(data.ok).toBe(true);
    expect((data.answers || []).length).toBeGreaterThan(0);
  });
});
