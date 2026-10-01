/* The webhook secret is derived from the bot token when no static secret is
   configured — that is the deployment path, so it is covered on its own. */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { boot } from './helpers.mjs';

const TOKEN = '123456:TEST-TOKEN';
const derive = (token) => crypto.createHmac('sha256', Buffer.from('qv-webhook:' + token))
  .update(Buffer.from('qv')).digest('hex').slice(0, 40);

let qv;
beforeAll(async () => { qv = await boot({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: '' }); }, 60000);
afterAll(async () => { await qv?.dispose(); });

describe('telegram webhook, secret derived from the token', () => {
  test('the status endpoint reports a fingerprint of the live secret', async () => {
    const st = (await qv.json('/api/tg', { headers: qv.auth() })).data;
    expect(st.secret_fingerprint).toBe(derive(TOKEN).slice(0, 8));
  });

  test('a request signed with the derived secret is accepted', async () => {
    const r = await qv.post('/tg/webhook', { update_id: 1 }, { 'x-telegram-bot-api-secret-token': derive(TOKEN) });
    expect(r.status).toBe(200);
  });

  test('a request with any other secret is refused', async () => {
    const r = await qv.post('/tg/webhook', { update_id: 1 }, { 'x-telegram-bot-api-secret-token': derive('123456:OTHER') });
    expect(r.status).toBe(403);
  });

  test('a bot without a token answers 503 instead of leaking', async () => {
    const bare = await boot({ TELEGRAM_BOT_TOKEN: '' });
    const r = await bare.post('/tg/webhook', { update_id: 1 }, {});
    expect(r.status).toBe(503);
    await bare.dispose();
  }, 30000);
});
