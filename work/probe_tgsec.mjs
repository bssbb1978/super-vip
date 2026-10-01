import { boot } from './tests/helpers.mjs';
import crypto from 'node:crypto';
const qv = await boot({ TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN', TELEGRAM_WEBHOOK_SECRET: '' });
const token = '123456:TEST-TOKEN';
const h = (k, m) => crypto.createHmac('sha256', Buffer.from(k)).update(Buffer.from(m)).digest('hex').slice(0, 40);
const cands = {
  'hmac(qv-webhook:tok, qv)': h('qv-webhook:' + token, 'qv'),
  'hmac(tok, qv-webhook:tok)': h(token, 'qv-webhook:' + token),
  'hmac(qv, qv-webhook:tok)': h('qv', 'qv-webhook:' + token),
  'hmac(qv-webhook:tok, token)': h('qv-webhook:' + token, token),
  'sha256(qv-webhook:tok)': crypto.createHash('sha256').update('qv-webhook:' + token).digest('hex').slice(0, 40),
  'no header': null,
};
for (const [name, sec] of Object.entries(cands)) {
  const headers = sec ? { 'x-telegram-bot-api-secret-token': sec } : {};
  const r = await qv.post('/tg/webhook', { update_id: 7 }, headers);
  console.log(String(r.status).padEnd(4), name, sec ? sec.slice(0, 12) + '…' : '');
}
await qv.dispose();
