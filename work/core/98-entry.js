/* ═══════════════════════════════════════════════════════════════════════════
 * C · ENTRY POINTS — the single module surface of the whole file
 * ═══════════════════════════════════════════════════════════════════════════
 *  Cloudflare Workers  : the default export carries { fetch, scheduled, queue }
 *  Cloudflare Pages    : the same object works as  /_worker.js  (advanced
 *                        mode); the onRequest* aliases below cover the classic
 *                        Pages Functions signature as well.
 *  Durable Objects     : QVRelay is exported and used automatically when a
 *                        binding of that class is configured (optional).
 *  Node / vitest       : the module is importable; the handlers are plain
 *                        functions taking (request, env, ctx).
 * ═══════════════════════════════════════════════════════════════════════════ */

const __QV_HANDLER = {
  async fetch(request, env, ctx) {
    return QV.router.handleFetch(request, env, ctx || {});
  },
  async scheduled(event, env, ctx) {
    return QV.router.scheduled(event, env, ctx || {});
  },
  async queue(batch, env, ctx) {
    return QV.router.queue(batch, env, ctx || {});
  },
  /** some generations shipped a `durableObject` handler name; keep it working */
  async durableObject(request, env, ctx) {
    const cfg = await QV.env.prepare(env, ctx);
    const ns = cfg.do && cfg.do[0];
    if (!ns) return new Response('no durable object bound', { status: 501 });
    const id = ns.idFromName(new URL(request.url).pathname);
    return ns.get(id).fetch(request);
  },
};

/* ⚠️  NEVER export a binding literally named `fetch`: in an ES module that
 * creates a module-scoped lexical `fetch` which SHADOWS the global fetch for
 * every line of this file (the whole engine would then call itself and every
 * outbound request — Workers AI, DoH, Telegram — would fail).  The default
 * export object carries the handler names instead, which is what the Workers
 * and Pages runtimes actually require. */
export default __QV_HANDLER;

/* Cloudflare Pages (classic Functions signature) compatibility. Only the
 * onRequest* names are exported, so nothing shadows the platform globals. */
export const onRequest = (context) => __QV_HANDLER.fetch(context.request, context.env, context);
export const onRequestGet = (context) => __QV_HANDLER.fetch(context.request, context.env, context);
export const onRequestPost = (context) => __QV_HANDLER.fetch(context.request, context.env, context);
export const onRequestPut = (context) => __QV_HANDLER.fetch(context.request, context.env, context);
export const onRequestDelete = (context) => __QV_HANDLER.fetch(context.request, context.env, context);
export const onRequestOptions = (context) => __QV_HANDLER.fetch(context.request, context.env, context);

/* ── optional Durable Object: sticky session/route state ──────────────────
 * Only instantiated when the operator adds the binding; until then the whole
 * engine runs statelessly out of D1.  It gives the deployment a place to keep
 * per-tunnel routing, live counters and a WebSocket fan-out in memory. */
export class QVRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();          // uuid → WebSocket
    this.started = Date.now();
    if (this.state && this.state.blockConcurrencyWhile) {
      this.state.blockConcurrencyWhile(async () => {
        this.meta = (await this.state.storage.get('meta')) || { created: Date.now(), version: QV.VERSION };
      });
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || 'default';

    if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.set(key, server);
      server.addEventListener('message', (ev) => {
        for (const [k, ws] of this.sockets) if (k !== key) { try { ws.send(ev.data); } catch (e) {} }
      });
      server.addEventListener('close', () => this.sockets.delete(key));
      return new Response(null, { status: 101, webSocket: client });
    }

    switch (url.pathname.split('/').pop()) {
      case 'ping': return Response.json({ ok: true, pong: Date.now(), peers: this.sockets.size });
      case 'get': {
        const value = await this.state.storage.get(key);
        return Response.json({ ok: true, key, value: value ?? null });
      }
      case 'put': {
        const body = await request.json().catch(() => null);
        if (body) await this.state.storage.put(key, body);
        return Response.json({ ok: !!body });
      }
      case 'incr': {
        const value = ((await this.state.storage.get(key)) || 0) + (Number(url.searchParams.get('by')) || 1);
        await this.state.storage.put(key, value);
        return Response.json({ ok: true, key, value });
      }
      case 'stats': return Response.json({
        ok: true, peers: this.sockets.size, uptime_ms: Date.now() - this.started,
        keys: this.state && this.state.storage.list ? (await this.state.storage.list({ limit: 50 })).size : 0,
      });
      default: return Response.json({ ok: true, version: QV.VERSION, hint: 'ping|get|put|incr|stats' });
    }
  }

  /** periodic housekeeping the runtime can schedule through storage alarms */
  async alarm() {
    const cutoff = Date.now() - 3600000;
    for (const [k, ws] of this.sockets) {
      if (!ws || ws.readyState > 1) this.sockets.delete(k);
    }
    if (this.state && this.state.storage.setAlarm) {
      const next = await this.state.storage.getAlarm();
      if (!next || next < cutoff) await this.state.storage.setAlarm(Date.now() + 900000);
    }
  }
}

/* Tests, the console and scripted ops reach the engine through this global
   (it is a global, not an export: workerd requires exported values to have a
   prototype chain that ends in Object, and QV is deliberately null-prototyped). */
globalThis.QV = QV;
if (typeof globalThis.__QV_ENTRY__ === 'undefined') globalThis.__QV_ENTRY__ = __QV_HANDLER;
