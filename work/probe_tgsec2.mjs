import { boot } from './tests/helpers.mjs';
const qv = await boot({ TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN' });
const st = (await qv.json('/api/tg', { headers: qv.auth() })).data;
console.log('tg status:', JSON.stringify(st).slice(0, 400));
await qv.dispose();
