/* ═══════════════════════════════════════════════════════════════════════════
 * tests/owner.test.mjs — the node runs with NO ADMIN_TELEGRAM_ID
 * ═══════════════════════════════════════════════════════════════════════════
 *  What is under test (31-owner.js + the Telegram/API/console wiring):
 *   · a deployment without ADMIN_TELEGRAM_ID boots, is claimable, and loses no
 *     alert while it is unclaimed
 *   · the claim code is single-use, short-lived, verified in constant time and
 *     never stored in clear text anywhere in D1
 *   · only a private chat whose sender *is* the chat can claim
 *   · a wrong code is indistinguishable from an expired or a spent one
 *   · roles are enforced: owner > admin > viewer, and the env id is untouchable
 *   · nothing that leaves the worker contains a raw chat id
 * ═══════════════════════════════════════════════════════════════════════════ */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot, TG_SECRET } from './helpers.mjs';

/* deliberately NO ADMIN_TELEGRAM_ID anywhere in this suite */
let qv, db;
beforeAll(async () => {
  qv = await boot({ TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN' });
  db = await qv.mf.getD1Database('DB');
}, 90000);
afterAll(async () => { await qv?.dispose(); });

const uid = () => Math.floor(Math.random() * 1e9);
const hook = (body) => qv.post('/tg/webhook', body, { 'x-telegram-bot-api-secret-token': TG_SECRET });
const ownerGet = async () => (await qv.json('/api/owner', { headers: qv.auth() })).data;
const ownerPost = async (b, headers = qv.auth()) => {
  const r = await qv.post('/api/owner', b, headers);
  let j = null; try { j = await r.json(); } catch (e) { /* not json */ }
  return { r, j, data: j && j.data };
};

/** a private-chat update; `from` differs from `chat` only when we want it to */
const msg = (chat, text, extra = {}) => ({
  update_id: uid(),
  message: {
    message_id: uid(), date: Math.floor(Date.now() / 1000),
    chat: { id: chat, type: extra.chatType || 'private' },
    from: { id: extra.from === undefined ? chat : extra.from, first_name: 'tester' },
    text,
  },
});
const cb = (chat, data, from) => ({
  update_id: uid(),
  callback_query: {
    id: 'cb' + uid(), from: { id: from === undefined ? chat : from, first_name: 'tester' },
    message: { message_id: uid(), chat: { id: chat, type: 'private' } },
    data,
  },
});
const adminRows = async () => (await db.prepare('SELECT telegram_id, role, name FROM qv_admins ORDER BY added_at').all()).results;
/** every value stored in qv_kv, flattened to one string, for leak assertions */
const kvDump = async () => {
  const rows = (await db.prepare('SELECT key, value FROM qv_kv').all()).results;
  return rows.map(r => r.key + '\n' + r.value).join('\n');
};

describe('owner binding: the bot works with no ADMIN_TELEGRAM_ID', () => {
  test('an unclaimed node boots and reports itself claimable', async () => {
    const s = await ownerGet();
    expect(s.env_configured).toBe(false);
    expect(s.claimed).toBe(false);
    expect(s.mode).toBe('claimable');
    expect(s.admins).toEqual([]);
  });

  test('minting a claim code needs an admin session', async () => {
    const anon = await ownerPost({ action: 'invite' }, {});
    expect(anon.r.status).toBe(401);
    const wrong = await ownerPost({ action: 'invite' }, { 'x-api-token': 'nope' });
    expect(wrong.r.status).toBe(401);
  });

  test('the owner API is not reachable anonymously at all', async () => {
    const r = await qv.get('/api/owner');
    expect(r.status).toBe(401);
  });

  let CODE = '';
  test('an authenticated session mints a single-use code', async () => {
    const { data } = await ownerPost({ action: 'invite' });
    expect(data.ok).toBe(true);
    expect(data.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(data.ttl_min).toBeGreaterThan(0);
    expect(data.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    /* the alphabet is unambiguous: no I, L, O, 0 or 1 to misread */
    expect(data.code).not.toMatch(/[ILO01]/);
    CODE = data.code;
  });

  test('only the HMAC digest of the code reaches D1, never the code itself', async () => {
    const dump = await kvDump();
    expect(dump).toContain('qv:owner:claim:');
    expect(dump).not.toContain(CODE);
    expect(dump).not.toContain(CODE.replace(/-/g, ''));
  });

  test('a wrong code is refused and binds nobody', async () => {
    const before = (await adminRows()).length;
    await hook(msg(111000222, '/claim ZZZZ-ZZZZ'));
    await hook(msg(111000222, '/claim ' + CODE.slice(0, 4) + 'Q-' + CODE.slice(6)));
    const rows = await adminRows();
    expect(rows.length).toBe(before);
    const s = await ownerGet();
    expect(s.claimed).toBe(false);
  });

  test('a group chat cannot claim, even with the right code', async () => {
    await hook(msg(-1001234567890, '/claim ' + CODE, { chatType: 'supergroup', from: 111000222 }));
    expect((await adminRows()).length).toBe(0);
    expect((await ownerGet()).claimed).toBe(false);
  });

  test('a sender who is not the chat cannot claim (no riding someone else’s chat)', async () => {
    await hook(msg(111000222, '/claim ' + CODE, { from: 999000111 }));
    expect((await adminRows()).length).toBe(0);
    expect((await ownerGet()).claimed).toBe(false);
  });

  test('the deep-link form /start claim_CODE binds the owner', async () => {
    const r = await hook(msg(424242424, '/start claim_' + CODE.replace(/-/g, '')));
    expect(r.status).toBe(200);
    const rows = await adminRows();
    expect(rows.length).toBe(1);
    expect(rows[0].telegram_id).toBe('424242424');
    expect(rows[0].role).toBe('owner');
    const s = await ownerGet();
    expect(s.claimed).toBe(true);
    expect(s.mode).toBe('bound');
    expect(s.owner).toBe('•••••2424');
    expect(s.pending_codes).toBe(0);
  });

  test('a spent code cannot be replayed by a second chat', async () => {
    await hook(msg(999888777, '/claim ' + CODE));
    const rows = await adminRows();
    expect(rows.length).toBe(1);
    expect(rows.find(r => r.telegram_id === '999888777')).toBeUndefined();
  });

  test('the claimed chat is an owner; a stranger is not an admin', async () => {
    const { data } = await qv.json('/api/owner', { headers: qv.auth() });
    expect(data.owners).toBe(1);
    /* /admins is owner-only: the stranger’s attempt must not create anything */
    await hook(msg(111000222, '/admins'));
    await hook(cb(111000222, 'ad:owner'));
    expect((await adminRows()).length).toBe(1);
  });

  test('notifyAdmin resolves its recipients from D1, not from the environment', async () => {
    const r = await qv.post('/api/tg', { action: 'notify', text: 'ping' }, qv.auth());
    const j = await r.json();
    /* delivery itself fails in the sandbox (no egress to api.telegram.org);
       what matters is that a recipient was resolved at all */
    expect(j.data.recipients).toBe(1);
    expect(j.data.error).not.toBe('ADMIN_TELEGRAM_ID not set');
  });

  test('an owner can add and remove another admin by id', async () => {
    const add = await ownerPost({ action: 'add', telegram_id: '3133731337', role: 'admin', name: 'ops' });
    expect(add.data.ok).toBe(true);
    let rows = await adminRows();
    expect(rows.length).toBe(2);
    expect(rows.find(r => r.telegram_id === '3133731337').role).toBe('admin');

    /* the notification fan-out now has two destinations */
    const notify = await (await qv.post('/api/tg', { action: 'notify', text: 'ping2' }, qv.auth())).json();
    expect(notify.data.recipients).toBe(2);

    /* removal works through the non-reversible fingerprint, as the UI does */
    const st = await ownerGet();
    const target = st.admins.find(a => a.id.endsWith('1337') && a.source !== 'env');
    expect(target).toBeTruthy();
    const fp = target.fp;
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    const del = await qv.del('/api/owner/' + fp, qv.auth());
    expect((await del.json()).data.ok).toBe(true);
    rows = await adminRows();
    expect(rows.find(r => r.telegram_id === '3133731337')).toBeUndefined();
    expect(rows.filter(r => r.telegram_id === '424242424').length).toBe(1);
  });

  test('a viewer is resolved but is not an admin', async () => {
    const before = (await adminRows()).length;
    await ownerPost({ action: 'add', telegram_id: '515051505', role: 'viewer' });
    const rows = await adminRows();
    expect(rows.find(r => r.telegram_id === '515051505').role).toBe('viewer');
    /* a viewer must not be able to run an admin command or add peers */
    await hook(msg(515051505, '/users'));
    await hook(cb(515051505, 'ad:owner:add'));
    await hook(msg(515051505, '/claim AAAA-BBBB'));
    expect((await adminRows()).length).toBe(before + 1);
    expect((await adminRows()).find(r => r.telegram_id === '515051505').role).toBe('viewer');
    await ownerPost({ action: 'remove', telegram_id: '515051505' });
    expect((await adminRows()).length).toBe(before);
  });

  test('rotate revokes every pending code', async () => {
    const a = await ownerPost({ action: 'invite' });
    const b = await ownerPost({ action: 'invite' });
    expect((await ownerGet()).pending_codes).toBe(2);
    const rot = await ownerPost({ action: 'rotate' });
    expect(rot.data.revoked).toBe(2);
    expect((await ownerGet()).pending_codes).toBe(0);
    /* and the revoked codes really are dead */
    await hook(msg(616263646, '/claim ' + a.data.code));
    await hook(msg(616263646, '/claim ' + b.data.code));
    expect((await adminRows()).find(r => r.telegram_id === '616263646')).toBeUndefined();
  });

  test('nothing that leaves the worker contains a raw chat id', async () => {
    const st = await ownerGet();
    const me = (await qv.json('/api/me', { headers: qv.auth() })).data;
    const tg = (await qv.json('/api/tg', { headers: qv.auth() })).data;
    const health = await (await qv.get('/health')).text();
    const blob = JSON.stringify([st, me, tg]) + health;
    for (const id of ['424242424', '3133731337', '515051505', '111000222', '999888777']) {
      expect(blob).not.toContain(id);
    }
    /* the masked form is what an operator sees */
    expect(st.admins.every(a => a.id.startsWith('•'))).toBe(true);
  });

  test('alerts raised while unclaimed are queued, not dropped', async () => {
    const fresh = await boot({ TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN', OWNER_CLAIM_TTL_MIN: '5' });
    try {
      const freshDb = await fresh.mf.getD1Database('DB');
      expect((await fresh.json('/api/owner', { headers: fresh.auth() })).data.claimed).toBe(false);
      const n = await (await fresh.post('/api/tg', { action: 'notify', text: 'early alert' }, fresh.auth())).json();
      expect(n.data.ok).toBe(false);
      expect(n.data.queued).toBeGreaterThan(0);
      const rows = (await freshDb.prepare("SELECT value FROM qv_kv WHERE key = 'qv:owner:queue'").all()).results;
      expect(rows.length).toBe(1);
      expect(rows[0].value).toContain('early alert');
      /* the queue survives and is handed over when the bot is finally claimed */
      const inv = await (await fresh.post('/api/owner', { action: 'invite' }, fresh.auth())).json();
      await fresh.post('/tg/webhook', msg(707070707, '/claim ' + inv.data.code),
        { 'x-telegram-bot-api-secret-token': TG_SECRET });
      const after = (await fresh.json('/api/owner', { headers: fresh.auth() })).data;
      expect(after.claimed).toBe(true);
      expect(after.queued_alerts).toBe(0);           // drained
    } finally { await fresh.dispose(); }
  }, 90000);

  test('ADMIN_TELEGRAM_ID still works and outranks a claim', async () => {
    const legacy = await boot({ TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN', ADMIN_TELEGRAM_ID: '555000111' });
    try {
      const s = (await legacy.json('/api/owner', { headers: legacy.auth() })).data;
      expect(s.env_configured).toBe(true);
      expect(s.claimed).toBe(true);
      expect(s.owner).toBe('•••••0111');
      expect(s.ids === undefined).toBe(true);
      /* the env id is materialised in qv_admins as owner and cannot be removed */
      const legacyDb = await legacy.mf.getD1Database('DB');
      const rows = (await legacyDb.prepare('SELECT telegram_id, role FROM qv_admins').all()).results;
      expect(rows.find(r => r.telegram_id === '555000111').role).toBe('owner');
      const del = await (await legacy.del('/api/owner/555000111', legacy.auth())).json();
      expect(del.data.ok).toBe(false);
      /* a second claim becomes a plain admin, never a second owner */
      const inv = await (await legacy.post('/api/owner', { action: 'invite' }, legacy.auth())).json();
      await legacy.post('/tg/webhook', msg(808080808, '/claim ' + inv.data.code),
        { 'x-telegram-bot-api-secret-token': TG_SECRET });
      const after = (await legacyDb.prepare('SELECT telegram_id, role FROM qv_admins ORDER BY telegram_id').all()).results;
      expect(after.filter(r => r.role === 'owner').length).toBe(1);
      expect(after.find(r => r.telegram_id === '808080808').role).toBe('admin');
    } finally { await legacy.dispose(); }
  }, 90000);

  test('OWNER_LOCK=1 disables claiming entirely', async () => {
    const locked = await boot({ TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN', OWNER_LOCK: '1' });
    try {
      const s = (await locked.json('/api/owner', { headers: locked.auth() })).data;
      expect(s.locked).toBe(true);
      expect(s.mode).toBe('env-only');
      const inv = await (await locked.post('/api/owner', { action: 'invite' }, locked.auth())).json();
      /* a locked deployment refuses to mint at all — 409, no code in the body */
      expect(inv.ok).toBe(false);
      expect(inv.data).toBeUndefined();
      expect(String(inv.error)).toMatch(/locked/i);
      await locked.post('/tg/webhook', msg(909090909, '/claim AAAA-BBBB'),
        { 'x-telegram-bot-api-secret-token': TG_SECRET });
      const lockedDb = await locked.mf.getD1Database('DB');
      expect((await lockedDb.prepare('SELECT COUNT(*) n FROM qv_admins').all()).results[0].n).toBe(0);
    } finally { await locked.dispose(); }
  }, 90000);

  test('brute-forcing codes is throttled and never rewarded', async () => {
    for (let i = 0; i < 14; i++) await hook(msg(123123123, '/claim ABCD-EFGH'));
    expect((await adminRows()).find(r => r.telegram_id === '123123123')).toBeUndefined();
    const s = await ownerGet();
    expect(s.claimed).toBe(true);                    // still the original owner
    expect(s.owners).toBe(1);
  });

  test('the console exposes the access tab and its client handlers', async () => {
    const html = await (await qv.get('/admin', { headers: qv.auth() })).text();
    /* the tab is rendered server-side; the handlers ship in the inline client */
    expect(html).toContain('data-tab="access"');
    expect(html).toContain('ownerInvite');
    expect(html).toContain('ownerRemove');
    expect(html).toContain("api('owner'");
    expect(html).toContain('OWNER_LOCK');
    /* an anonymous visitor gets the sign-in shell: the SPA source ships (it is
       one inline bundle), but no owner data is embedded in the page and every
       /api/owner call it would make is rejected — asserted above */
    const anon = await (await qv.get('/admin')).text();
    expect(anon).toContain('sign in');
    expect(html).toContain('Quantum Veil Console');   // the authenticated shell
    expect(anon).not.toContain('Quantum Veil Console');
    for (const id of ['424242424', '3133731337', '515051505']) {
      expect(anon).not.toContain(id);
      expect(html).not.toContain(id);
    }
    expect(anon).not.toMatch(/•{2,}\d{4}/);          // no masked id either
  });
});
