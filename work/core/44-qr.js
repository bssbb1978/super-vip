/* ═══════════════════════════════════════════════════════════════════════════
 * A10b · QR ENCODER — pure JS, byte mode, versions 1-10, EC L/M/Q/H
 *   Used to render config URIs as scannable codes inside the admin/user
 *   panels (no external image service — everything stays on the edge).
 *   Verified against the reference implementation (python-qrcode) module by
 *   module for identical version/EC/mask, see test_qr.js.
 * ═══════════════════════════════════════════════════════════════════════════ */
QV.qr = (() => {
  /* total data codewords per version */
  const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085];
  /* [ecCodewordsPerBlock, blocksGroup1, dataCodewords1, blocksGroup2, dataCodewords2] */
  const BLOCKS = {
    L: [null, [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108], [18, 2, 68], [20, 2, 78], [24, 2, 97], [30, 2, 116], [18, 2, 68, 2, 69], [20, 4, 81], [24, 2, 92, 2, 93], [26, 4, 107], [30, 3, 115, 1, 116], [22, 5, 87, 1, 88], [24, 5, 98, 1, 99], [28, 1, 107, 5, 108], [30, 5, 120, 1, 121], [28, 3, 113, 4, 114], [28, 3, 107, 5, 108]],
    M: [null, [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43], [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44], [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42], [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42]],
    Q: [null, [13, 1, 13], [22, 1, 22], [18, 2, 17], [26, 2, 24], [18, 2, 15, 2, 16], [24, 4, 19], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20], [28, 4, 22, 4, 23], [26, 4, 20, 6, 21], [24, 8, 20, 4, 21], [20, 11, 16, 5, 17], [30, 5, 24, 7, 25], [24, 15, 19, 2, 20], [28, 1, 22, 15, 23], [28, 17, 22, 1, 23], [26, 17, 21, 4, 22], [30, 15, 24, 5, 25]],
    H: [null, [17, 1, 9], [28, 1, 16], [22, 2, 13], [16, 4, 9], [22, 2, 11, 2, 12], [28, 4, 15], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16], [24, 3, 12, 8, 13], [28, 7, 14, 4, 15], [22, 12, 11, 4, 12], [24, 11, 12, 5, 13], [24, 11, 12, 7, 13], [30, 3, 15, 13, 16], [28, 2, 14, 17, 15], [28, 2, 14, 19, 15], [26, 9, 13, 16, 14], [28, 15, 15, 10, 16]]
  };
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
    [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]];
  const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  /* ---------- GF(256) arithmetic (primitive 0x11d) ---------------------- */
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  const rsGenerator = (degree) => {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= mul(poly[j], 1);
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  };

  const rsEncode = (data, ecCount) => {
    const gen = rsGenerator(ecCount);
    const res = new Uint8Array(ecCount);
    for (const byte of data) {
      const factor = byte ^ res[0];
      res.copyWithin(0, 1);
      res[ecCount - 1] = 0;
      for (let i = 0; i < ecCount; i++) res[i] ^= mul(gen[i + 1], factor);
    }
    return res;
  };

  /* ---------- bit buffer ------------------------------------------------- */
  class Bits {
    constructor() { this.b = []; }
    push(value, length) { for (let i = length - 1; i >= 0; i--) this.b.push((value >>> i) & 1); }
    get length() { return this.b.length; }
    toBytes() {
      const out = new Uint8Array(Math.ceil(this.b.length / 8));
      this.b.forEach((bit, i) => { if (bit) out[i >> 3] |= 0x80 >> (i & 7); });
      return out;
    }
  }

  /* ---------- version selection ----------------------------------------- */
  const pickVersion = (byteLen, ec) => {
    for (let v = 1; v <= 20; v++) {
      const [ecPer, b1, d1, b2, d2] = BLOCKS[ec][v];
      const capacity = b1 * d1 + (b2 || 0) * (d2 || 0);
      const header = 4 + (v <= 9 ? 8 : 16);
      if (8 * capacity >= header + byteLen * 8) return v;
    }
    throw new Error('qr: payload too large for versions \u226420 (' + byteLen + ' bytes)');
  };

  /* ---------- encoding pipeline ----------------------------------------- */
  const encodeCodewords = (text, version, ec) => {
    const bytes = QV.utf8(text);
    const [ecPer, b1, d1, b2, d2] = BLOCKS[ec][version];
    const capacityBits = (b1 * d1 + (b2 || 0) * (d2 || 0)) * 8;
    const bits = new Bits();
    bits.push(0b0100, 4);                                       // byte mode
    bits.push(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) bits.push(b, 8);
    /* terminator */
    const maxTerm = Math.min(4, capacityBits - bits.length);
    bits.push(0, maxTerm);
    while (bits.length % 8 !== 0) bits.push(0, 1);
    const data = bits.toBytes();
    const total = capacityBits / 8;
    const padded = new Uint8Array(total);
    padded.set(data);
    for (let i = data.length, alt = 0; i < total; i++, alt++) padded[i] = alt % 2 ? 0x11 : 0xec;

    /* split into blocks, compute EC, interleave */
    const blocks = [];
    let off = 0;
    for (let i = 0; i < b1; i++) { blocks.push(padded.subarray(off, off + d1)); off += d1; }
    for (let i = 0; i < (b2 || 0); i++) { blocks.push(padded.subarray(off, off + d2)); off += d2; }
    const ecBlocks = blocks.map(b => rsEncode(b, ecPer));
    const out = [];
    const maxData = Math.max(...blocks.map(b => b.length));
    for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecPer; i++) for (const b of ecBlocks) out.push(b[i]);
    return new Uint8Array(out);
  };

  /* ---------- matrix construction ---------------------------------------- */
  const buildMatrix = (codewords, version, ec, mask) => {
    const size = version * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(null));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

    const set = (r, c, v, reserve = true) => { if (r < 0 || c < 0 || r >= size || c >= size) return; m[r][c] = v ? 1 : 0; if (reserve) reserved[r][c] = true; };

    /* finder patterns + separators */
    const finder = (r0, c0) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(rr, cc, (inRing || inCore) ? 1 : 0);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    /* timing patterns */
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }

    /* alignment patterns */
    for (const r0 of ALIGN[version]) for (const c0 of ALIGN[version]) {
      if ((r0 === 6 && c0 === 6) || (r0 === 6 && c0 === size - 7) || (r0 === size - 7 && c0 === 6)) continue;
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
        const ring = Math.max(Math.abs(r), Math.abs(c));
        set(r0 + r, c0 + c, ring !== 1 ? 1 : 0);
      }
    }

    /* dark module + format/version reservations */
    set(size - 8, 8, 1);
    for (let i = 0; i <= 8; i++) { if (m[8][i] === null) set(8, i, 0); if (m[i][8] === null) set(i, 8, 0); }
    for (let i = 0; i < 8; i++) { set(8, size - 1 - i, 0); set(size - 1 - i, 8, 0); }
    if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { set(size - 11 + j, i, 0); set(i, size - 11 + j, 0); }

    /* data placement: right-to-left columns, boustrophedon */
    let bitIndex = 0;
    const totalBits = codewords.length * 8;
    const getBit = (i) => (i < totalBits ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0);
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (reserved[r][c]) continue;
          m[r][c] = getBit(bitIndex++);
        }
      }
    }

    /* masking */
    const maskFn = [
      (r, c) => (r + c) % 2 === 0,
      (r) => r % 2 === 0,
      (_, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ][mask];
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!reserved[r][c]) m[r][c] ^= maskFn(r, c) ? 1 : 0;

    /* format information (EC + mask, BCH(15,5), mask 0x5412) */
    let fmt = (EC_BITS[ec] << 3) | mask;
    let d = fmt << 10;
    for (let i = 14; i >= 10; i--) if ((d >>> i) & 1) d ^= 0x537 << (i - 10);
    const fmtBits = ((fmt << 10) | d) ^ 0x5412;
    for (let i = 0; i < 15; i++) {
      const bit = (fmtBits >> i) & 1;
      /* first copy — vertical strip beside the top-left finder */
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else m[size - 15 + i][8] = bit;
      /* second copy — horizontal strip under the top-right finder */
      if (i < 8) m[8][size - 1 - i] = bit;
      else if (i === 8) m[8][7] = bit;
      else m[8][14 - i] = bit;
    }
    m[size - 8][8] = 1;                       // dark module wins

    /* version information (v >= 7): BCH(18,6), generator 0x1F25 */
    if (version >= 7) {
      let v = version << 12;
      for (let i = 17; i >= 12; i--) if ((v >>> i) & 1) v ^= 0x1f25 << (i - 12);
      const vBits = (version << 12) | v;
      for (let i = 0; i < 18; i++) {
        const bit = (vBits >> i) & 1;
        const r = Math.floor(i / 3), c = i % 3;
        m[size - 11 + c][r] = bit;
        m[r][size - 11 + c] = bit;
      }
    }
    return m;
  };

  /* ---------- mask penalty (ISO/IEC 18004 §8.8.2) ------------------------ */
  const penalty = (m) => {
    const size = m.length;
    let score = 0;
    const runs = (line) => {
      let s = 0, run = 1;
      for (let i = 1; i < line.length; i++) {
        if (line[i] === line[i - 1]) run++;
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) s += 3 + (run - 5);
      return s;
    };
    for (let i = 0; i < size; i++) { score += runs(m[i]); score += runs(m.map(row => row[i])); }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
    const pattern = [1, 0, 1, 1, 1, 0, 1];
    const hasPattern = (line, i) => {
      for (let k = 0; k < 7; k++) if (line[i + k] !== pattern[k]) return false;
      const before = line.slice(Math.max(0, i - 4), i);
      const after = line.slice(i + 7, i + 11);
      return before.every(x => x === 0) || after.every(x => x === 0);
    };
    for (let i = 0; i < size; i++) {
      const row = m[i], col = m.map(r => r[i]);
      for (let j = 0; j + 7 <= size; j++) { if (hasPattern(row, j)) score += 40; if (hasPattern(col, j)) score += 40; }
    }
    const dark = m.flat().reduce((a, b) => a + b, 0);
    const ratio = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return score;
  };

  /* ---------- public API -------------------------------------------------- */
  /**
   * encode(text, {ec:'M', mask:null}) → {size, modules:[[0|1]], version, mask, ec}
   * With mask=null the mask with the lowest penalty score is chosen (spec).
   */
  const encode = (text, opts = {}) => {
    const ec = (opts.ec || 'M').toUpperCase();
    if (!BLOCKS[ec]) throw new Error('qr: bad ec level ' + ec);
    const bytes = QV.utf8(text);
    const version = opts.version || pickVersion(bytes.length, ec);
    const codewords = encodeCodewords(text, version, ec);
    if (opts.mask !== undefined && opts.mask !== null) {
      return { size: version * 4 + 17, modules: buildMatrix(codewords, version, ec, opts.mask), version, mask: opts.mask, ec };
    }
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const m = buildMatrix(codewords, version, ec, mask);
      const p = penalty(m);
      if (!best || p < best.p) best = { m, p, mask };
    }
    return { size: version * 4 + 17, modules: best.m, version, mask: best.mask, ec };
  };

  /** inline SVG (no external requests — safe inside strict CSP & the preview) */
  const toSvg = (text, opts = {}) => {
    const { size, modules, version, mask, ec } = encode(text, opts);
    const scale = opts.scale || 4;
    const quiet = opts.quiet ?? 4;
    const dim = (size + quiet * 2) * scale;
    const rects = [];
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (modules[r][c]) rects.push(`<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}"/>`);
    }
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges" role="img" aria-label="QR">` +
        `<rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`,
      version, mask, ec, size,
    };
  };

  /** compact data-URI variant for embedding in HTML */
  const toDataUri = (text, opts = {}) => 'data:image/svg+xml;base64,' + QV.b64.enc(QV.utf8(toSvg(text, opts).svg));

  return { encode, toSvg, toDataUri, pickVersion, BLOCKS, TOTAL_CODEWORDS };
})();
