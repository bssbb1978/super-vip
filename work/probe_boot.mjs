import { boot } from './tests/helpers.mjs';
import crypto from 'node:crypto';
const qv = await boot({ TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN' });   /* no TELEGRAM_WEBHOOK_SECRET on purpose */
const A = qv.auth();
const h = (await qv.json('/health')).data;
console.log('health boot_id', h.boot_id, 'uptime_s', h.uptime_s, 'ok', h.ok);
const st = (await qv.json('/api/stats', { headers: A })).data;
console.log('stats uptime_ms', st.uptime_ms, 'version', st.version);
const want = crypto.createHmac('sha256', Buffer.from('qv-webhook:123456:TEST-TOKEN')).update(Buffer.from('qv')).digest('hex').slice(0, 40);
const ok = await qv.post('/tg/webhook', { update_id: 1 }, { 'x-telegram-bot-api-secret-token': want });
console.log('derived webhook secret accepted:', ok.status === 200 ? 'yes(' + ok.status + ')' : 'NO(' + ok.status + ')');
await qv.dispose();
