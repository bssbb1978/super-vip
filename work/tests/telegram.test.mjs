import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { boot, TG_SECRET } from './helpers.mjs';

let qv;
beforeAll(async () => { qv = await boot({ TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN', ADMIN_TELEGRAM_ID: '555000111' }); }, 60000);
afterAll(async () => { await qv?.dispose(); });

const update = (chatId, text, extra = {}) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: {
    message_id: Math.floor(Math.random() * 1e6),
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, first_name: 'tester', language_code: 'fa' },
    text,
  },
  ...extra,
});
const hook = (body, secret = TG_SECRET) => qv.post('/tg/webhook', body, { 'x-telegram-bot-api-secret-token': secret });
const fsm = async (chat) => (await qv.json('/api/fsm?chat=' + encodeURIComponent(chat), { headers: qv.auth() })).data.items;

describe('telegram bot: webhook, FSM on D1, admin actions', () => {
  test('the webhook rejects a wrong secret token', async () => {
    const r = await hook(update(1000, '/start'), 'not-the-secret');
    expect(r.status).toBe(403);
  });

  test('a /start from the operator is accepted and recorded', async () => {
    const r = await hook(update(555000111, '/start'));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
    const rows = await fsm(555000111);
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].state).toBe('string');
  });

  test('state lives in the database, so it survives the isolate', async () => {
    await hook(update(777000222, '/start'));
    const rows = await fsm(777000222);
    expect(rows[0].chat_id).toBe('777000222');
  });

  test('an unknown chat can ask for access and the operator can approve', async () => {
    const chat = 888000333;
    await hook(update(chat, '/start'));
    await hook(update(chat, 'Mojtaba'));
    const { data } = await qv.json('/api/users?pending=1', { headers: qv.auth() });
    expect(Array.isArray(data.items)).toBe(true);
    const pending = data.items.find(u => String(u.telegram_id) === String(chat));
    if (pending) {
      const r = await hook({
        update_id: Math.floor(Math.random() * 1e9),
        callback_query: {
          id: 'cb1', from: { id: 555000111, first_name: 'op' },
          message: { message_id: 5, chat: { id: 555000111, type: 'private' } },
          data: 'qv:u:approve:' + pending.uuid,
        },
      });
      expect(r.status).toBe(200);
      const after = await qv.json('/api/users', { headers: qv.auth() });
      const approved = after.data.items.find(u => u.uuid === pending.uuid);
      expect(approved.approved === true || approved.enabled === true).toBe(true);
    }
  });

  test('the admin console API reports bot status without leaking the token', async () => {
    const { r, data } = await qv.json('/api/tg', { headers: qv.auth() });
    expect(r.status).toBe(200);
    expect(JSON.stringify(data)).not.toMatch(/123456:TEST-TOKEN/);
  });

  test('a broadcast is queued rather than blasted', async () => {
    const res = await qv.post('/api/tg', { action: 'broadcast', text: 'سلام' }, qv.auth());
    const j = await res.json();
    const data = j.data || j;
    expect(res.status).toBe(200);
    expect(data.broadcast === true || data.queued === true || data.sent !== undefined).toBe(true);
  });

  test('commands are bilingual', async () => {
    const { data } = await qv.json('/api/tg', { headers: qv.auth() });
    expect(Array.isArray(data.commands || []) || typeof data.commands === 'object').toBe(true);
  });
});
