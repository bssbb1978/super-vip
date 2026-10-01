/* ═══════════════════════════════════════════════════════════════════════════
 * tests/attest.test.mjs — the build attestation must describe the artifact
 * ═══════════════════════════════════════════════════════════════════════════
 *  scripts/build-bundle.mjs writes dist/worker.meta.json right next to the
 *  bundle it just verified: sha256, obfuscator version + seed, the pinned
 *  identity (every core part and every unit) and the full verification
 *  report.  This suite re-derives what it can from the bytes on disk, so a
 *  stale or tampered artifact can never pass the gate.
 *
 *  It also re-runs the check the old pipeline failed in CI — the built
 *  artifact must carry the whole core and every unit — and pins the exact
 *  `46-selfcheck.js` marker the boot suite asserts.
 *
 *  When no attestation is present — e.g. a plain, non-obfuscated build — the
 *  suite is skipped instead of failing, so `QV_SCRIPT=../worker.js` and a
 *  `dist/worker.js` built by hand both keep working.
 * ═══════════════════════════════════════════════════════════════════════════ */
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');           // work/tests/ → work/ → repo root
const ARTIFACT = process.env.QV_SCRIPT || path.join(here, '..', 'dist', 'worker.js');
const META = process.env.QV_BUILD_META || path.join(path.dirname(ARTIFACT), 'worker.meta.json');

const hasAttestation = fs.existsSync(ARTIFACT) && fs.existsSync(META);
/** vitest's own skip form, without depending on a version-specific API */
const maybe = hasAttestation ? test : test.skip;

const artifact = () => fs.readFileSync(ARTIFACT, 'utf8');
const attestation = () => JSON.parse(fs.readFileSync(META, 'utf8'));

describe('build attestation', () => {
  maybe('the artifact matches its sha256 attestation', () => {
    const meta = attestation();
    const src = artifact();
    expect(meta.schema).toBe('qv-build/1');
    expect(meta.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.createHash('sha256').update(src).digest('hex')).toBe(meta.artifact.sha256);
    expect(Buffer.byteLength(src)).toBe(meta.artifact.bytes);
  });

  maybe('the attestation records a passed, obfuscated build', () => {
    const meta = attestation();
    expect(meta.verification.ok).toBe(true);
    expect(meta.identity.core_count).toBe(meta.identity.core.length);
    expect(meta.identity.units_count).toBe(meta.identity.units.length);
    expect(meta.identity.core_count).toBeGreaterThanOrEqual(20);
    expect(meta.identity.units_count).toBeGreaterThanOrEqual(10);
    /* both Workers-unsafe transforms must stay off, and the canary must be
       gone: that is what proves the rest of the stack actually executed */
    expect(meta.obfuscation.self_defending).toBe(false);
    expect(meta.obfuscation.debug_protection).toBe(false);
    expect(meta.obfuscation.canary_transformed).toBe(true);
  });

  maybe('every attested core part and unit is really in the artifact', () => {
    const meta = attestation();
    const src = artifact();
    for (const f of meta.identity.core) expect(src).toContain(f);
    for (const f of meta.identity.units) expect(src).toContain(f);
    /* the exact markers the boot suite greps for, pinned here as well */
    expect(src).toContain('46-selfcheck.js');
    for (const unit of ['u00', 'u05', 'u10']) expect(src).toContain(`__QF_UNIT_${unit}`);
  });

  maybe('the pinned build identity survived the obfuscator verbatim', () => {
    const meta = attestation();
    const src = artifact();
    /* the `qv-build:` literal is reserved from obfuscation; if it is missing
       the identity was split, base64-encoded or dropped */
    expect(meta.identity.identity_line).toMatch(/^qv-build:1\|/);
    expect(src).toContain(meta.identity.identity_line);
    expect(src).toContain('__QV_PROVENANCE__');
  });

  maybe('the attested identity is exactly the project source set (no drift)', () => {
    const meta = attestation();
    const listing = (dir, re) =>
      fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)).sort() : null;
    const coreDir = listing(path.join(REPO, 'work', 'core'), /^\d{2}-.*\.js$/);
    const unitDir = listing(path.join(REPO, 'work', 'units'), /^u\d+\.js$/);
    /* the directories only exist in a full checkout; skip the drift guard
       when the suite runs against just the artifact */
    if (coreDir) expect([...meta.identity.core].sort()).toEqual(coreDir);
    if (unitDir) expect([...meta.identity.units].sort()).toEqual(unitDir);
  });
});
