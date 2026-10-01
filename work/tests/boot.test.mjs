import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot } from './helpers.mjs';

let qv;
beforeAll(async () => { qv = await boot(); }, 60000);
afterAll(async () => { await qv?.dispose(); });

describe('boot & identity', () => {
  test('health reports the bindings and the feature set', async () => {
    const { r, j } = await qv.json('/health');
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.features.d1).toBe(true);
    expect(j.features.kv).toBe(true);
    expect(j.features.vless).toBe(true);
    expect(j.features.shadowsocks).toBe(true);
    expect(j.features.doh).toBe(true);
    expect(j.features.nat64).toBe(true);
  });

  test('every response is stamped and timed', async () => {
    const r = await qv.get('/health');
    expect(r.headers.get('x-qv')).toBeTruthy();
    expect(r.headers.get('server-timing')).toMatch(/app;dur=\d+/);
  });

  test('the landing page is neutral (no filtering vocabulary)', async () => {
    const r = await qv.get('/');
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).toMatch(/private service node/i);
    expect(text).not.toMatch(/vless|shadowsocks|proxy|vpn/i);
  });

  test('an unknown path is a decoy, never a 404 page', async () => {
    const r = await qv.get('/definitely-not-a-route');
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toMatch(/not found/i);
  });

  test('the module surface is Pages- and Workers-complete', async () => {
    const src = await import('node:fs').then(fs => fs.readFileSync(process.env.QV_SCRIPT || 'dist/worker.js', 'utf8'));
    expect(src).toMatch(/export default __QV_HANDLER/);
    expect(src).toMatch(/export const onRequest\b/);
    expect(src).toMatch(/export const onRequestGet\b/);
    expect(src).toMatch(/export class QVRelay/);
    /* a binding named `fetch` would shadow the platform global for the whole
       module — the single most damaging mistake this file could contain */
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+fetch/);
    expect(src).not.toMatch(/export\s+const\s+fetch\b/);
  });

  test('the built artifact carries the full core and every unit', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(process.env.QV_SCRIPT || 'dist/worker.js', 'utf8');
    expect(src).toMatch(/46-selfcheck\.js/);
    expect(src.length).toBeGreaterThan(1_000_000);
    for (const unit of ['u00', 'u05', 'u10']) expect(src).toMatch(new RegExp('__QF_UNIT_' + unit));
  });
});
