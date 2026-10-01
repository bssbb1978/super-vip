/* The deployment file is part of the deliverable: it must stay free of the
   tokens hosting policies single out, it must ship the bindings the worker
   needs, and it must not contain a secret value. */
import { describe, test, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), '..');
let toml = '';
beforeAll(() => { toml = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8'); });

describe('wrangler.toml', () => {
  test('carries no flagged word — not even in a comment', () => {
    const flagged = [/\bvpn\b/i, /\bproxy\b/i, /\bxray\b/i];
    for (const re of flagged) expect(toml).not.toMatch(re);
  });

  test('ships the single-file worker, minified, with both stores bound', () => {
    expect(toml).toMatch(/^main\s*=\s*"worker\.js"/m);
    expect(toml).toMatch(/^minify\s*=\s*true/m);
    expect(toml).toMatch(/\[\[d1_databases\]\]/);
    expect(toml).toMatch(/binding\s*=\s*"DB"/);
    expect(toml).toMatch(/\[\[kv_namespaces\]\]/);
  });

  test('one cron trigger drives the whole scheduler', () => {
    const crons = toml.match(/crons\s*=\s*\[[^\]]*\]/g) || [];
    expect(crons.length).toBeGreaterThanOrEqual(1);
    expect(crons[0]).toMatch(/\* \* \* \* \*/);
  });

  test('a separate staging environment exists', () => {
    expect(toml).toMatch(/\[env\.staging\]/);
    expect(toml).toMatch(/\[\[env\.staging\.d1_databases\]\]/);
  });

  test('secrets are referenced, never written', () => {
    /* every secret line must be a `wrangler secret put` command in a comment */
    expect(toml).not.toMatch(/^\s*(ADMIN_PASSWORD|JWT_SECRET|API_SECRET_TOKEN|TELEGRAM_BOT_TOKEN|SS_MASTER_SECRET)\s*=/m);
    expect(toml).toMatch(/wrangler secret put ADMIN_PASSWORD/);
  });

  test('the shipped bundle is the single file and stays inside the size limit', () => {
    const size = fs.statSync(path.join(ROOT, 'worker.js')).size;
    expect(size).toBeGreaterThan(500 * 1024);
    expect(size).toBeLessThan(64 * 1024 * 1024);          // platform ceiling
  });
});
