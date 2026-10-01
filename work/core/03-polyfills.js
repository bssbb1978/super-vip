/* ═══════════════════════════════════════════════════════════════════════════
 * A1c · RUNTIME POLYFILLS — so a single file runs in ANY Worker configuration
 * ═══════════════════════════════════════════════════════════════════════════
 *  The bundled generations contain code from Node-oriented libraries
 *  (drizzle-orm, zod) that touches `Buffer`.  With the `nodejs_compat` flag
 *  the runtime provides a real Buffer and this file does nothing at all; with
 *  the flag absent (or on Pages) the minimal implementation below keeps every
 *  one of those call sites working instead of throwing ReferenceError.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function polyfills() {
  /* the two decoders the Buffer shim needs, always defined so any caller can
     use them whether or not the runtime already ships a Buffer */
  QV.moduleBufferFromBase64 = (s) => QV.b64.dec(String(s));
  QV.moduleBufferFromHex = (s) => QV.unhex(String(s).replace(/[^0-9a-f]/gi, ''));

  if (typeof globalThis.Buffer === 'undefined') {
    class QVBuffer extends Uint8Array {
      static from(input, encodingOrOffset, length) {
        if (typeof input === 'string') {
          if (encodingOrOffset === 'base64') return QV.moduleBufferFromBase64(input);
          if (encodingOrOffset === 'hex') return QV.moduleBufferFromHex(input);
          return QV.utf8(input);
        }
        if (input instanceof ArrayBuffer) return new Uint8Array(input, encodingOrOffset || 0, length);
        if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        if (Array.isArray(input)) return new Uint8Array(input);
        if (input && typeof input.length === 'number') return new Uint8Array(input);
        return new Uint8Array(0);
      }
      static alloc(size, fill) { const b = new Uint8Array(size); if (fill !== undefined) b.fill(fill); return b; }
      static isBuffer(v) { return v instanceof Uint8Array; }
      static concat(list, total) {
        const arrs = list.map(x => (x instanceof Uint8Array ? x : new Uint8Array(x)));
        const out = new Uint8Array(total !== undefined ? total : arrs.reduce((s, a) => s + a.length, 0));
        let off = 0;
        for (const a of arrs) { out.set(a, off); off += a.length; }
        return out;
      }
      static byteLength(s, enc) { return enc === 'base64' ? Math.ceil(String(s).length * 0.75) : QV.utf8(String(s)).length; }
      toString(encoding = 'utf8') {
        if (encoding === 'base64') return QV.b64.enc(this);
        if (encoding === 'hex') return QV.hex(this);
        if (encoding === 'latin1' || encoding === 'binary') return String.fromCharCode.apply(null, this.subarray(0, 8192));
        return QV.dec.decode(this);
      }
      equals(other) { return QV.bytesEqual(this, other); }
      slice(a, b) { return this.subarray(a, b); }
      toJSON() { return { type: 'Buffer', data: [...this] }; }
    }
    globalThis.Buffer = QVBuffer;
  }

  /* Minimal `process` surface: some bundled libs read process.env.NODE_ENV */
  if (typeof globalThis.process === 'undefined') {
    globalThis.process = {
      env: Object.freeze({ NODE_ENV: 'production', NODE_DEBUG: '' }),
      version: 'v20.0.0', platform: 'workers', arch: 'wasm32',
      nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
      stdout: { write: () => {} }, stderr: { write: () => {} },
      on: () => {}, exit: () => {}, cwd: () => '/',
    };
  }

  /* AbortSignal.timeout is present in modern workerd; keep a fallback for
     older compatibility dates. */
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = (ms) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(new Error('timeout')), ms);
      return ac.signal;
    };
  }

  /* `queueMicrotask` is standard; `setImmediate` is not — alias it because the
     bundled generations use it in a few timers. */
  if (typeof globalThis.setImmediate === 'undefined') {
    globalThis.setImmediate = (fn, ...args) => setTimeout(() => fn(...args), 0);
    globalThis.clearImmediate = (id) => clearTimeout(id);
  }
})();
