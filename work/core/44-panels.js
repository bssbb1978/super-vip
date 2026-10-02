/* ═══════════════════════════════════════════════════════════════════════════
 * A5 · CONTROL PANELS — one self-contained HTML bundle, zero external assets
 * ═══════════════════════════════════════════════════════════════════════════
 *  `QV.panels.render()` returns the whole single-page console: dashboard,
 *  users, live sessions, anti-DPI strategy, SNI pool, clean-IP scanner,
 *  DNS workbench, AI copilot, logs, backup/restore and the self-test panel.
 *  Everything is inline (CSS + JS) so it renders identically on Workers,
 *  on Pages, offline, and inside a sandboxed iframe.  The console speaks
 *  Persian and English and follows the admin's choice.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function panels() {
  const CSS = `
  :root{--bg:#0b1020;--bg2:#121a33;--card:#161f3d;--line:#243154;--fg:#e9eefb;--dim:#93a0c4;
        --acc:#5b8cff;--acc2:#22d3a6;--warn:#ffb020;--bad:#ff5c75;--ok:#2ee6a8;--rad:14px}
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(160deg,#070b16,#0b1020 40%,#0a1226);color:var(--fg);
       font:14px/1.6 Vazirmatn,system-ui,-apple-system,"Segoe UI",Roboto,Tahoma,sans-serif;min-height:100vh}
  body[dir=rtl]{font-family:Vazirmatn,Tahoma,system-ui,sans-serif}
  a{color:var(--acc)}
  .wrap{max-width:1180px;margin:0 auto;padding:18px}
  .top{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:16px}
  .brand{display:flex;gap:10px;align-items:center;font-weight:700;letter-spacing:.2px}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--ok);box-shadow:0 0 12px var(--ok)}
  .grid{display:grid;gap:14px}
  .g4{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
  .g2{grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
  .card{background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.01)),var(--card);
        border:1px solid var(--line);border-radius:var(--rad);padding:16px}
  .card h3{margin:0 0 10px;font-size:14px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.6px}
  .kpi{font-size:26px;font-weight:800}
  .sub{color:var(--dim);font-size:12px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .sp{flex:1}
  button,.btn{background:var(--acc);color:#fff;border:0;border-radius:10px;padding:9px 14px;font:inherit;
        font-weight:600;cursor:pointer;transition:.15s;text-decoration:none;display:inline-block}
  button:hover,.btn:hover{filter:brightness(1.1)}
  button.ghost{background:transparent;border:1px solid var(--line);color:var(--fg)}
  button.bad{background:var(--bad)}button.warn{background:var(--warn);color:#231a00}button.ok{background:var(--acc2);color:#04231a}
  button.sm{padding:5px 9px;font-size:12px;border-radius:8px}
  input,select,textarea{background:#0d1428;border:1px solid var(--line);color:var(--fg);border-radius:10px;
        padding:9px 11px;font:inherit;width:100%}
  input:focus,select:focus,textarea:focus{outline:1px solid var(--acc)}
  label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:8px 6px;border-bottom:1px solid var(--line);text-align:start;vertical-align:middle}
  th{color:var(--dim);font-weight:600;font-size:12px}
  tr:hover td{background:rgba(91,140,255,.06)}
  .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700}
  .pill.on{background:rgba(46,230,168,.16);color:var(--ok)}
  .pill.off{background:rgba(255,92,117,.16);color:var(--bad)}
  .pill.mid{background:rgba(255,176,32,.16);color:var(--warn)}
  .tabs{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 14px}
  .tabs button{background:transparent;border:1px solid var(--line);color:var(--dim)}
  .tabs button.active{background:var(--acc);color:#fff;border-color:transparent}
  .muted{color:var(--dim)}
  .ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
  pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  pre{background:#0a0f20;border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;max-height:340px;direction:ltr}
  .code{background:#0a0f20;border:1px dashed var(--line);border-radius:10px;padding:10px;word-break:break-all;
        direction:ltr;text-align:left;font-family:ui-monospace,monospace;font-size:12px}
  .bar{height:8px;border-radius:99px;background:#0d1428;overflow:hidden}
  .bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--acc2),var(--acc))}
  .toast{position:fixed;inset-inline-end:16px;bottom:16px;background:#0d1428;border:1px solid var(--line);
        border-radius:12px;padding:12px 14px;max-width:340px;z-index:99;box-shadow:0 12px 40px #0008}
  .chat{height:320px;overflow:auto;background:#0a0f20;border:1px solid var(--line);border-radius:10px;padding:10px}
  .msg{margin:6px 0;padding:8px 10px;border-radius:10px;max-width:88%;white-space:pre-wrap}
  .msg.me{background:rgba(91,140,255,.18);margin-inline-start:auto}
  .msg.ai{background:rgba(34,211,166,.12)}
  .login{max-width:360px;margin:8vh auto}
  .logo{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--acc),var(--acc2));
        display:grid;place-items:center;font-weight:900;color:#04121f}
  .kv{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed var(--line)}
  .kv:last-child{border:0}
  .hidden{display:none!important}
  @media(max-width:640px){.kpi{font-size:22px}.wrap{padding:12px}}
  `;

  /* The client application is real JavaScript in this file, not a nested
     string: it is serialised with Function.prototype.toString() and shipped
     into the page.  That keeps template literals usable on both sides. */
  function clientApp() {

  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
  const state = { tab:'dash', lang: localStorage.getItem('qv.lang') || 'fa', token: sessionStorage.getItem('qv.token') || '', data:{} };
  const T = {
    fa:{dash:'داشبورد',users:'کاربران',sessions:'اتصال‌ها',strategy:'ضدDPI',sni:'مخزن SNI',ips:'آی‌پی تمیز',dns:'DNS',
        ai:'دستیار هوش مصنوعی',logs:'رویدادها',backup:'پشتیبان',test:'خودآزمون',logout:'خروج',login:'ورود',save:'ذخیره',
        add:'کاربر جدید',run:'اجرا',refresh:'به‌روزرسانی',search:'جستجو',total:'کل کاربران',online:'آنلاین',traffic:'ترافیک',
        quota:'سهمیه',status:'وضعیت',actions:'عملیات',revive:'فعال‌سازی',kill:'قطع کانفیگ',del:'حذف',sub:'لینک اشتراک',
        copy:'کپی',ask:'بپرسید…',send:'ارسال',download:'دانلود',restore:'بازیابی',yes:'بله',no:'خیر',
        access:'دسترسی تلگرام',
        hint:'برای دیدن کانفیگ روی «لینک اشتراک» بزنید.'},
    en:{dash:'Dashboard',users:'Users',sessions:'Sessions',strategy:'Anti-DPI',sni:'SNI Pool',ips:'Clean IPs',dns:'DNS',
        ai:'AI Copilot',logs:'Events',backup:'Backup',test:'Self-test',logout:'Sign out',login:'Sign in',save:'Save',
        add:'New user',run:'Run',refresh:'Refresh',search:'Search',total:'Users',online:'Online',traffic:'Traffic',
        quota:'Quota',status:'Status',actions:'Actions',revive:'Revive',kill:'Cut config',del:'Delete',sub:'Sub link',
        copy:'Copy',ask:'Ask…',send:'Send',download:'Download',restore:'Restore',yes:'Yes',no:'No',
        access:'Telegram access',
        hint:'Click "Sub link" to reveal a config.'}
  };
  const t = (k) => (T[state.lang]||T.fa)[k] || k;
  const esc = (s) => String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const bytes = (n) => { n=Number(n)||0; const u=['B','KB','MB','GB','TB']; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return n.toFixed(n<10&&i?1:0)+' '+u[i]; };
  const ago = (ts) => { const s=Math.max(0,Math.floor((Date.now()-ts)/1000)); if(s<60)return s+'s'; if(s<3600)return Math.floor(s/60)+'m'; if(s<86400)return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; };

  async function api(path, opts={}) {
    const res = await fetch('/api/' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({'content-type':'application/json'}, state.token ? {'x-api-token': state.token} : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let json = null; try { json = await res.json(); } catch(e) {}
    if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
    if (!res.ok || (json && json.ok === false)) throw new Error((json && (json.error||json.message)) || ('HTTP ' + res.status));
    return (json && json.data !== undefined) ? json.data : json;
  }
  function toast(msg, kind='ok') {
    const d = document.createElement('div'); d.className='toast';
    d.innerHTML = '<b class="'+kind+'">'+(kind==='bad'?'✖':kind==='warn'?'⚠':'✔')+'</b> '+esc(msg);
    document.body.appendChild(d); setTimeout(()=>d.remove(), 4200);
  }
  function fmt(ts){ if(!ts) return '—'; const d=new Date(Number(ts)); return d.toLocaleString(state.lang==='fa'?'fa-IR':'en-GB',{hour12:false}); }

  const VIEWS = {
    dash: async () => {
      const s = await api('stats');
      const g = s.health || {};
      return `<div class="grid g4">
        ${kpi(t('total'), s.users_total, s.users_enabled + ' ' + (state.lang==='fa'?'فعال':'enabled'))}
        ${kpi(t('online'), s.sessions_active, s.sessions_total + ' ' + (state.lang==='fa'?'کل':'total'))}
        ${kpi(t('traffic'), bytes(s.bytes_24h), bytes(s.bytes_total) + ' ' + (state.lang==='fa'?'کل':'all-time'))}
        ${kpi('D1 / KV', (g.d1?'✔':'✖'), (g.kv?'KV ✔ ':'KV ✖ ') + 'AI ' + (g.ai?'✔':'✖'))}
      </div>
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><h3>${state.lang==='fa'?'استراتژی فعال':'Active strategy'}</h3>
          ${kv('shape', s.strategy && s.strategy.active_shape)}${kv('fragment', JSON.stringify(s.strategy && s.strategy.fragment))}
          ${kv('SNI pool', s.sni_count)}${kv('clean IPs', s.ip_count)}${kv('generation', s.strategy && s.strategy.generation)}
          <div class="row" style="margin-top:10px"><button class="sm" onclick="QV.replan()">${state.lang==='fa'?'بازتحلیل با AI':'Re-plan with AI'}</button>
          <button class="sm ghost" onclick="QV.hunt()">${state.lang==='fa'?'شکار SNI':'Hunt SNI'}</button>
          <button class="sm ghost" onclick="QV.scanIPs()">${state.lang==='fa'?'اسکن آی‌پی تمیز':'Scan clean IPs'}</button></div></div>
        <div class="card"><h3>${state.lang==='fa'?'سلامت و ظرفیت':'Health & capacity'}</h3>
          <div id="health">${state.lang==='fa'?'در حال بارگذاری…':'loading…'}</div>
          <div class="row" style="margin-top:10px"><button class="sm ghost" onclick="QV.selftest()">${t('test')}</button>
          <button class="sm ghost" onclick="QV.cron()">${state.lang==='fa'?'اجرای کرون':'Run cron'}</button></div></div>
      </div>`;
    },
    users: async () => {
      const list = await api('users');
      return `<div class="card"><div class="row"><h3 style="margin:0">${t('users')} (${(list.items||[]).length})</h3><div class="sp"></div>
        <input id="uq" placeholder="${t('search')}" style="max-width:220px" oninput="QV.filterUsers(this.value)">
        <button onclick="QV.newUser()">+ ${t('add')}</button></div>
        <div style="overflow:auto;margin-top:12px"><table><thead><tr>
        <th>${state.lang==='fa'?'نام':'Name'}</th><th>UUID</th><th>${t('quota')}</th><th>${t('traffic')}</th><th>${t('status')}</th><th>${t('actions')}</th>
        </tr></thead><tbody id="urows">${(list.items||[]).map(userRow).join('')}</tbody></table></div></div>`;
    },
    sessions: async () => {
      const s = await api('sessions');
      return `<div class="card"><h3>${t('sessions')} (${(s.items||[]).length})</h3>
      <div style="overflow:auto"><table><thead><tr><th>UUID</th><th>IP</th><th>${state.lang==='fa'?'شروع':'Start'}</th>
      <th>${state.lang==='fa'?'مدت':'Age'}</th><th>${t('traffic')}</th><th>${t('actions')}</th></tr></thead><tbody>
      ${(s.items||[]).map(r=>`<tr><td><code>${esc(String(r.uuid).slice(0,8))}…</code></td><td><code>${esc(r.ip)}</code></td>
      <td class="muted">${fmt(r.started_at)}</td><td>${ago(r.started_at*1000)}</td><td>${bytes(r.bytes_in+r.bytes_out)}</td>
      <td><button class="sm bad" onclick="QV.kick('${esc(r.id)}')">${state.lang==='fa'?'قطع':'Kick'}</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
    },
    strategy: async () => {
      const s = await api('strategy');
      return `<div class="grid g2">
        <div class="card"><h3>${t('strategy')}</h3>
          <label>active shape</label><select id="f-shape">${['ws-tls','ws-tls-fragment','httpupgrade','xhttp','grpc'].map(x=>`<option ${s.active_shape===x?'selected':''}>${x}</option>`).join('')}</select>
          <label>fragment mode</label><select id="f-fmode">${['auto','fixed','off'].map(x=>`<option ${s.fragment&&s.fragment.mode===x?'selected':''}>${x}</option>`).join('')}</select>
          <label>fragment size (bytes)</label><input id="f-fsize" type="number" value="${esc(s.fragment&&s.fragment.size||0)}">
          <label>fragment interval (ms)</label><input id="f-fint" type="number" value="${esc(s.fragment&&s.fragment.interval||0)}">
          <label>${state.lang==='fa'?'حالت سخت‌گیرانه':'Strict evasion'}</label>
          <select id="f-strict"><option value="0" ${!s.strict?'selected':''}>off</option><option value="1" ${s.strict?'selected':''}>on</option></select>
          <div class="row" style="margin-top:12px"><button onclick="QV.saveStrategy()">${t('save')}</button>
          <button class="ghost" onclick="QV.replan()">${state.lang==='fa'?'بازتحلیل با AI':'Re-plan with AI'}</button></div></div>
        <div class="card"><h3>${state.lang==='fa'?'مشاهده خام':'Raw state'}</h3><pre>${esc(JSON.stringify(s,null,1))}</pre></div>
      </div>`;
    },
    sni: async () => {
      const s = await api('sni');
      return `<div class="card"><div class="row"><h3 style="margin:0">${t('sni')} (${(s.items||[]).length})</h3><div class="sp"></div>
      <button onclick="QV.hunt()">${state.lang==='fa'?'شکار SNI جدید':'Hunt'}</button>
      <button class="ghost" onclick="QV.healthSNI()">${state.lang==='fa'?'بررسی سلامت':'Health check'}</button></div>
      <div style="overflow:auto;margin-top:10px"><table><thead><tr><th>SNI</th><th>${state.lang==='fa'?'امتیاز':'Score'}</th>
      <th>${state.lang==='fa'?'تاخیر':'Latency'}</th><th>${state.lang==='fa'?'موفق/ناموفق':'OK/Err'}</th><th>${state.lang==='fa'?'آخرین':'Last'}</th></tr></thead>
      <tbody>${(s.items||[]).map(r=>`<tr><td><code>${esc(r.sni)}</code></td><td>${r.score}</td><td>${r.latency_ms||'—'}ms</td>
      <td class="ok">${r.success||0} / <span class="bad">${r.fail||0}</span></td><td class="muted">${fmt((r.last_check||0)*1000)}</td></tr>`).join('')}</tbody></table></div></div>`;
    },
    ips: async () => {
      const s = await api('ips');
      return `<div class="card"><div class="row"><h3 style="margin:0">${t('ips')} (${(s.items||[]).length})</h3><div class="sp"></div>
      <button onclick="QV.scanIPs()">${state.lang==='fa'?'اسکن':'Scan'}</button></div>
      <div class="sub" style="margin:8px 0">${state.lang==='fa'?'آی‌پی‌های تمیز با کمترین تاخیر برای جایگزینی در کلاینت.':'Lowest-latency clean addresses to swap in on the client.'}</div>
      <div style="overflow:auto"><table><thead><tr><th>IP</th><th>${state.lang==='fa'?'تاخیر':'Latency'}</th><th>colo</th><th>${state.lang==='fa'?'امتیاز':'Score'}</th><th></th></tr></thead>
      <tbody>${(s.items||[]).map(r=>`<tr><td><code>${esc(r.ip)}</code></td><td>${r.latency_ms||'—'}ms</td><td>${esc(r.colo||'')}</td>
      <td>${r.score}</td><td><button class="sm ghost" onclick="QV.copy('${esc(r.ip)}')">${t('copy')}</button></td></tr>`).join('')}</tbody></table></div></div>`;
    },
    dns: async () => {
      const s = await api('dns');
      return `<div class="grid g2">
        <div class="card"><h3>${t('dns')}</h3>
        <label>${state.lang==='fa'?'نام دامنه':'Domain'}</label><input id="d-q" value="cloudflare.com">
        <label>${state.lang==='fa'?'نوع':'Type'}</label><select id="d-t">${['A','AAAA','CNAME','TXT','MX','NS','SRV','SOA','PTR'].map(x=>`<option>${x}</option>`).join('')}</select>
        <div class="row" style="margin-top:10px"><button onclick="QV.dnsQuery()">${t('run')}</button>
        <button class="ghost" onclick="QV.copy(location.origin+'/dns-query')">${state.lang==='fa'?'کپی آدرس DoH':'Copy DoH URL'}</button></div>
        <pre id="d-out">${esc(JSON.stringify({doh:'/dns-query (RFC8484)', nat64:(s.nat64||[]).map(p=>p.prefix).join(', '), upstreams:(s.upstreams||[]).length, cached:s.cached},null,1))}</pre></div>
        <div class="card"><h3>${state.lang==='fa'?'آمار کش':'Cache stats'}</h3><pre>${esc(JSON.stringify(s,null,1))}</pre></div></div>`;
    },
    ai: async () => {
      const s = await api('ai');
      return `<div class="card"><h3>${t('ai')}</h3>
        <div class="sub">${state.lang==='fa'?'مدل فعال:':'Active model:'} <code>${esc(s.active_model||'—')}</code> — ${s.available_models||0} ${state.lang==='fa'?'مدل در کاتالوگ':'models in catalogue'}${s.remote_models?(' / '+s.remote_models+' live'):''}</div>
        <div class="chat" id="chat">${(s.history||[]).map(m=>`<div class="msg ${m.role==='user'?'me':'ai'}">${esc(m.content)}</div>`).join('')}</div>
        <div class="row" style="margin-top:8px"><input id="aiin" placeholder="${t('ask')}" onkeydown="if(event.key==='Enter')QV.ask()"><button onclick="QV.ask()">${t('send')}</button></div>
        <div class="sub" style="margin-top:6px">${state.lang==='fa'?'مثال: «کاربر جدید بساز با ۲۰ گیگ»، «استراتژی رو مقاوم‌تر کن»، «کدام SNI بهتره؟»':'Try: "create a user with 20 GB", "make the strategy stealthier", "which SNI is best?"'}</div></div>`;
    },
    logs: async () => {
      const s = await api('events');
      return `<div class="card"><h3>${t('logs')}</h3><div style="overflow:auto;max-height:60vh"><table><thead><tr>
      <th>${state.lang==='fa'?'زمان':'Time'}</th><th>${state.lang==='fa'?'نوع':'Type'}</th><th>${state.lang==='fa'?'سطح':'Level'}</th><th>${state.lang==='fa'?'پیام':'Message'}</th></tr></thead>
      <tbody>${(s.items||[]).map(r=>`<tr><td class="muted">${fmt(r.ts*1000)}</td><td><code>${esc(r.type)}</code></td>
      <td class="${r.level==='error'?'bad':r.level==='warn'?'warn':'ok'}">${esc(r.level)}</td><td>${esc(r.message||'')}</td></tr>`).join('')}</tbody></table></div></div>`;
    },
    backup: async () => `<div class="grid g2">
        <div class="card"><h3>${t('backup')}</h3><div class="sub">${state.lang==='fa'?'یک فایل JSON کامل از کاربران، نشست‌ها، استراتژی و مخزن SNI.':'A complete JSON snapshot of users, sessions, strategy and the SNI pool.'}</div>
        <div class="row" style="margin-top:10px"><button onclick="QV.backup()">${t('download')}</button></div></div>
        <div class="card"><h3>${t('restore')}</h3><textarea id="restoreBox" rows="9" placeholder='{"users":[…]}'></textarea>
        <div class="row" style="margin-top:10px"><button class="warn" onclick="QV.restore()">${t('restore')}</button></div></div>
      </div>`,
    access: async () => {
      const s = await api('owner');
      const fa = state.lang === 'fa';
      const rows = (s.admins||[]).map(a => `<tr>
        <td><code>${esc(a.id)}</code></td>
        <td><span class="pill ${a.role==='owner'?'on':''}">${esc(a.role)}</span></td>
        <td class="muted">${esc(a.source==='env'?(fa?'متغیر محیطی':'env var'):(fa?'اتصال خودکار':'claimed'))}</td>
        <td class="muted">${esc(a.name||'—')}</td>
        <td>${a.source==='env'?'<span class="muted">🔒</span>':`<button class="sm bad" onclick="QV.ownerRemove('${esc(a.fp)}','${esc(a.id)}')">${t('del')}</button>`}</td></tr>`).join('');
      return `<div class="grid g2">
        <div class="card"><h3>${fa?'اتصال تلگرام':'Telegram binding'}</h3>
          <div class="sub" style="margin-bottom:10px">${fa
            ? 'این گره به <b>ADMIN_TELEGRAM_ID</b> نیازی ندارد. یک کد یک‌بارمصرف بسازید و در تلگرام <code>/claim CODE</code> بفرستید؛ چت شما به‌صورت خودکار مالک می‌شود. شناسهٔ شما هرگز به‌صورت متن آشکار در کد، URL یا لاگ ظاهر نمی‌شود.'
            : 'This node needs <b>no ADMIN_TELEGRAM_ID</b>. Mint a single-use code, then send <code>/claim CODE</code> in Telegram — that chat becomes the owner automatically. Your id is never stored or shown in clear text.'}</div>
          ${kv(fa?'حالت':'mode', s.mode)}
          ${kv(fa?'مالک':'owner', s.claimed ? s.owner : (fa?'— هنوز متصل نشده':'— unclaimed'))}
          ${kv(fa?'کدهای در انتظار':'pending codes', s.pending_codes)}
          ${kv(fa?'هشدارهای در صف':'queued alerts', s.queued_alerts)}
          ${kv(fa?'کلید اثرانگشت':'fingerprint key', s.pepper_source === 'env'
            ? (fa?'پین‌شده با OWNER_PEPPER':'pinned with OWNER_PEPPER')
            : s.pepper_source === 'd1'
              ? (fa?'ثبت‌شده در D1 — پایدار':'committed in D1 — stable')
              : (fa?'مشتق‌شده — ناپایدار':'derived — unstable'))}
          ${(s.pepper_source && s.pepper_source !== 'd1' && s.pepper_source !== 'env')
            ? `<div class="warn sub" style="margin-top:8px">${fa
              ? '⚠️ کلید اثرانگشت هنوز در D1 ثبت نشده است؛ تا پایگاه داده در دسترس نباشد، چرخش رمزها می‌تواند دکمه‌های لغو دسترسی را از کار بیندازد.'
              : '⚠️ the fingerprint key is not committed yet — until the database is reachable, rotating a secret can break the revoke buttons.'}</div>` : ''}
          ${s.locked?`<div class="bad sub" style="margin-top:8px">🔒 OWNER_LOCK=1</div>`:''}
          <div class="row" style="margin-top:12px">
            <button onclick="QV.ownerInvite()">${fa?'🔑 ساخت کد اتصال':'🔑 New claim code'}</button>
            <button class="ghost" onclick="QV.ownerRotate()">${fa?'♻️ باطل کردن کدها':'♻️ Revoke codes'}</button>
          </div>
          <div id="ownerCode" class="sub" style="margin-top:10px"></div>
        </div>
        <div class="card"><div class="row"><h3 style="margin:0">${fa?'مدیران':'Admins'} (${(s.admins||[]).length})</h3><div class="sp"></div>
          <button class="sm ghost" onclick="QV.ownerAdd()">+ ${fa?'افزودن با شناسه':'Add by id'}</button></div>
          <div style="overflow:auto;margin-top:12px"><table><thead><tr>
          <th>ID</th><th>${fa?'نقش':'Role'}</th><th>${fa?'منبع':'Source'}</th><th>${fa?'نام':'Name'}</th><th></th>
          </tr></thead><tbody>${rows||`<tr><td colspan="5" class="muted">${esc(s.owner_none||'—')}</td></tr>`}</tbody></table></div>
          <div class="sub" style="margin-top:10px">${fa
            ? 'نقش‌ها: <b>owner</b> (همه‌چیز + مدیریت دسترسی)، <b>admin</b> (همه‌چیز جز مدیریت دسترسی)، <b>viewer</b> (فقط آمار).'
            : 'Roles: <b>owner</b> (everything + access control), <b>admin</b> (everything but access control), <b>viewer</b> (read-only).'}</div>
        </div>
      </div>`;
    },
    test: async () => `<div class="grid g2">
        <div class="card"><div class="row"><h3 style="margin:0">${t('test')}</h3><div class="sp"></div>
        <button onclick="QV.selftest(1)">${state.lang==='fa'?'اجرای کامل':'Run full'}</button></div>
        <div id="tst" class="sub" style="margin-top:10px">${state.lang==='fa'?'برای شروع دکمه را بزنید':'press run'}</div>
        <div id="tstout"></div></div>
        <div class="card"><div class="row"><h3 style="margin:0">${state.lang==='fa'?'سنجش شبکهٔ من':'Measure my network'}</h3><div class="sp"></div>
        <button onclick="QV.measure()">${state.lang==='fa'?'سنجش':'Run probe'}</button></div>
        <div class="sub" style="margin-top:10px">${state.lang==='fa'
          ? 'مرورگر همین حالا چند نشانی و میزبان را می‌آزماید و نتیجهٔ بی‌نام (فقط ASN و کشور) را برمی‌گرداند.'
          : 'Your browser tests the assigned addresses and hostnames and reports the result anonymously (ASN + country only).'}</div>
        <div id="ciout" class="sub" style="margin-top:10px"></div></div>
      </div>`,
  };
  const kpi = (label, value, sub) => `<div class="card"><h3>${esc(label)}</h3><div class="kpi">${esc(value)}</div><div class="sub">${esc(sub||'')}</div></div>`;
  const kv = (k,v) => `<div class="kv"><span class="muted">${esc(k)}</span><b>${esc(v==null?'—':v)}</b></div>`;
  const userRow = (u) => `<tr data-name="${esc((u.name||'')+' '+u.uuid)}"><td>${esc(u.name||'—')}<div class="sub">${esc(u.telegram_id?('tg:'+u.telegram_id):'')}</div></td>
    <td><code>${esc(String(u.uuid).slice(0,8))}…</code></td><td>${bytes(u.used_bytes)} / ${bytes(u.quota_bytes)}<div class="bar"><i style="width:${Math.min(100,Math.round((u.used_bytes/(u.quota_bytes||1))*100))}%"></i></div></td>
    <td>${u.enabled&&!u.killswitch?'<span class="pill on">'+(state.lang==='fa'?'فعال':'on')+'</span>':'<span class="pill off">'+(state.lang==='fa'?'قطع':'cut')+'</span>'}</td>
    <td class="row"><button class="sm ghost" onclick="QV.sub('${esc(u.uuid)}')">${t('sub')}</button>
    <button class="sm ${u.killswitch?'ok':'bad'}" onclick="QV.toggleKill('${esc(u.uuid)}',${u.killswitch?0:1})">${u.killswitch?t('revive'):t('kill')}</button>
    <button class="sm ghost" onclick="QV.quota('${esc(u.uuid)}')">${t('quota')}</button>
    <button class="sm bad" onclick="QV.delUser('${esc(u.uuid)}')">${t('del')}</button></td></tr>`;

  const PANEL = {
    async render() {
      const body = await (VIEWS[state.tab] || VIEWS.dash)();
      $('#view').innerHTML = body;
      if (state.tab === 'dash') QV._health();
      $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
    },
    tab(name) { state.tab = name; PANEL.render(); },
    lang(l) { state.lang = l; localStorage.setItem('qv.lang', l); location.reload(); },
  };

  window.QV = Object.assign(window.QV || {}, {
    tab: (n) => PANEL.tab(n),
    lang: (l) => PANEL.lang(l),
    reload: () => PANEL.render(),
    _health: async () => { try { const h = await api('selftest?quick=1'); $('#health').innerHTML = `<div class="sub">${esc(h.summary)}</div>` +
      `<pre>${esc(JSON.stringify(h.results.filter(r=>!r.pass),null,1))}</pre>`; } catch(e) { $('#health').innerHTML = '<span class="bad">'+esc(e.message)+'</span>'; } },
    selftest: async (full) => { $('#tst').textContent = '…'; const r = await api('selftest' + (full?'?full=1':'?quick=1'));
      $('#tst').innerHTML = `<b class="${r.ok?'ok':'bad'}">${esc(r.summary)}</b>`;
      $('#tstout').innerHTML = '<pre>'+esc(JSON.stringify(r.results,null,1))+'</pre>'; },
    cron: async () => { const r = await api('cron',{method:'POST',body:{}}); toast('cron: '+Object.keys(r.results||{}).length+' tasks'); },
    replan: async () => { await api('ai',{method:'POST',body:{action:'replan'}}); toast('strategy re-planned'); },
    hunt: async () => { toast('hunting…','warn'); const r = await api('sni',{method:'POST',body:{action:'hunt'}}); toast('found '+(r.found||0)); PANEL.render(); },
    measure: async () => {
      const box = $('#ciout'); if (!box) return;
      box.textContent = '…';
      try {
        if (!window.QVProbe) {
          await new Promise((res, rej) => { const el = document.createElement('script'); el.src = '/probe.js'; el.onload = res; el.onerror = rej; document.head.appendChild(el); });
        }
        const rep = await window.QVProbe.run({ force: true, uuid: (location.pathname.match(/sub\/([0-9a-f-]{6,64})/i) || [])[1] || '' });
        box.innerHTML = '<pre>' + esc(JSON.stringify(rep, null, 1)) + '</pre>';
      } catch (e) { box.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; }
    },
    /* the raw ranking, including the per-ASN scopes and the provider list */
    endpoints: async () => {
      const r = await api('endpoints');
      return r;
    },
    healthSNI: async () => { toast('checking…','warn'); const r = await api('sni',{method:'POST',body:{action:'health'}}); toast('checked '+(r.checked||0)); PANEL.render(); },
    scanIPs: async () => { toast('scanning…','warn'); const r = await api('ips',{method:'POST',body:{action:'scan'}}); toast('found '+(r.found||0)); PANEL.render(); },
    saveStrategy: async () => {
      await api('strategy',{method:'POST',body:{ active_shape:$('#f-shape').value,
        fragment:{ mode:$('#f-fmode').value, size:Number($('#f-fsize').value), interval:Number($('#f-fint').value) },
        strict: $('#f-strict').value === '1' }});
      toast('saved'); },
    newUser: async () => { const name = prompt(state.lang==='fa'?'نام کاربر:':'User name:'); if(!name) return;
      const gb = Number(prompt(state.lang==='fa'?'سهمیه (گیگابایت):':'Quota (GB):','50')||50);
      const r = await api('users',{method:'POST',body:{name, quota_bytes: Math.round(gb*1073741824)}});
      toast('user '+ (r.item&&r.item.uuid||'').slice(0,8) +' created'); PANEL.render(); },
    delUser: async (uuid) => { if(!confirm(t('del')+' '+uuid.slice(0,8)+'?')) return; await api('users/'+uuid,{method:'DELETE'}); toast('deleted'); PANEL.render(); },
    kick: async (id) => { await api('sessions/'+id,{method:'DELETE'}); toast('kicked'); PANEL.render(); },
    toggleKill: async (uuid, v) => { await api('users/'+uuid,{method:'PATCH',body:{killswitch:v}}); toast(v?'config cut':'revived'); PANEL.render(); },
    sub: async (uuid) => { const r = await api('sub/'+uuid);
      const box = document.createElement('div'); box.className='toast'; box.style.maxWidth='520px';
      box.innerHTML = `<b>${t('sub')}</b><div class="code">${esc(r.url)}</div>
        <div class="row" style="margin-top:8px"><button class="sm" onclick="QV.copy('${esc(r.url)}')">${t('copy')}</button>
        <a class="btn sm ghost" href="/qr?d=${encodeURIComponent(r.url)}&s=6" target="_blank">QR</a></div>`;
      document.body.appendChild(box); setTimeout(()=>box.remove(), 20000); },
    quota: async (uuid) => { const gb = Number(prompt(state.lang==='fa'?'سهمیه جدید (گیگابایت):':'New quota (GB):','50')||0);
      if(!gb) return; await api('users/'+uuid,{method:'PATCH',body:{quota_bytes: Math.round(gb*1073741824)}}); toast('quota updated'); PANEL.render(); },
    ask: async () => { const input = $('#aiin'); const q = input.value.trim(); if(!q) return; input.value='';
      const chat = $('#chat'); chat.insertAdjacentHTML('beforeend','<div class="msg me">'+esc(q)+'</div>');
      const r = await api('ai',{method:'POST',body:{action:'chat',prompt:q}});
      chat.insertAdjacentHTML('beforeend','<div class="msg ai">'+esc(r.answer||r.message||'')+'</div>'); chat.scrollTop = chat.scrollHeight; },
    dnsQuery: async () => { const r = await api('dns',{method:'POST',body:{name:$('#d-q').value,type:$('#d-t').value}});
      $('#d-out').textContent = JSON.stringify(r,null,1); },
    backup: async () => { const r = await api('backup',{method:'POST',body:{}}); const a=document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(r,null,1)],{type:'application/json'}));
      a.download = 'qv-backup-'+new Date().toISOString().slice(0,10)+'.json'; a.click(); },
    restore: async () => { const raw = $('#restoreBox').value; try { const r = await api('backup',{method:'PUT',body:JSON.parse(raw)}); toast('restored '+JSON.stringify(r.counts||{})); }
      catch(e){ toast(e.message,'bad'); } },
    filterUsers: (q) => { q = q.toLowerCase(); $$('#urows tr').forEach(tr => tr.classList.toggle('hidden', !tr.dataset.name.toLowerCase().includes(q))); },
    copy: async (txt) => { try { await navigator.clipboard.writeText(txt); toast('copied'); } catch(e){ prompt('copy', txt); } },
    /* ── Telegram owner binding ───────────────────────────────────────────
       The code is rendered once, in this tab, and never persisted anywhere:
       not in localStorage, not in the URL, not in a log line. */
    ownerInvite: async () => {
      const box = $('#ownerCode'); if (box) box.innerHTML = '…';
      try {
        const r = await api('owner', { method:'POST', body:{ action:'invite' } });
        const fa = state.lang === 'fa';
        if (box) box.innerHTML =
          `<div class="card" style="margin:0;background:#0a0f20">
             <div class="sub">${fa?'کد یک‌بارمصرف — فقط یک بار قابل استفاده است':'Single-use code — valid once'}</div>
             <div class="code" style="font-size:18px;letter-spacing:2px">${esc(r.code)}</div>
             <div class="sub" style="margin-top:6px">${fa?'اعتبار':'expires in'}: ${esc(r.ttl_min)} ${fa?'دقیقه':'min'} · ${esc(r.note||'')}</div>
             <div class="row" style="margin-top:8px">
               <button class="sm" onclick="QV.copy('${esc(r.code)}')">${t('copy')}</button>
               <button class="sm ghost" onclick="QV.copy('/claim ${esc(r.code)}')">${fa?'کپی دستور':'Copy command'}</button>
               ${r.link?`<a class="btn sm ghost" href="${esc(r.link)}" target="_blank" rel="noopener">${fa?'📲 بازکردن در تلگرام':'📲 Open in Telegram'}</a>`:''}
             </div>
           </div>`;
        toast(fa ? 'کد ساخته شد' : 'claim code minted');
      } catch(e) { if (box) box.innerHTML = '<span class="bad">'+esc(e.message)+'</span>'; toast(e.message,'bad'); }
    },
    ownerRotate: async () => { try { const r = await api('owner',{method:'POST',body:{action:'rotate'}});
      toast((state.lang==='fa'?'باطل شد: ':'revoked: ')+(r.revoked||0)); PANEL.render(); } catch(e){ toast(e.message,'bad'); } },
    ownerAdd: async () => {
      const fa = state.lang === 'fa';
      const id = prompt(fa?'شناسهٔ عددی تلگرام:':'Numeric Telegram id:'); if(!id) return;
      const role = prompt(fa?'نقش (owner/admin/viewer):':'Role (owner/admin/viewer):','admin')||'admin';
      try { const r = await api('owner',{method:'POST',body:{action:'add',telegram_id:id.trim(),role:role.trim()}});
        if (r && r.ok === false) throw new Error(r.error||'failed');
        toast(fa?'اضافه شد':'added'); PANEL.render(); } catch(e){ toast(e.message,'bad'); }
    },
    ownerRemove: async (fp, shown) => {
      /* the button carries the non-reversible fingerprint, never the real id */
      if(!confirm((state.lang==='fa'?'دسترسی حذف شود؟ ':'Revoke access? ')+(shown||fp))) return;
      try { const r = await api('owner/'+encodeURIComponent(String(fp||'')),{method:'DELETE'});
        if (r && r.ok === false) throw new Error(r.error||'failed');
        toast(state.lang==='fa'?'حذف شد':'revoked'); PANEL.render(); } catch(e){ toast(e.message,'bad'); }
    },
  });

  window.addEventListener('DOMContentLoaded', async () => {
    document.documentElement.setAttribute('dir', state.lang==='fa' ? 'rtl' : 'ltr');
    $('#lang') && ($('#lang').value = state.lang);
    if (!state.token) { try { const me = await api('me'); state.token = me.token || ''; if (state.token) sessionStorage.setItem('qv.token', state.token); } catch(e) { return showLogin(); } }
    PANEL.render();
    setInterval(() => { if (state.tab === 'sessions' || state.tab === 'dash') PANEL.render(); }, 20000);
  });
  window.showLogin = (msg) => {
    document.documentElement.setAttribute('dir', state.lang==='fa' ? 'rtl' : 'ltr');
    $('#app').innerHTML = `<div class="login card"><div class="row"><div class="logo">QV</div><b>QUANTUM VEIL</b></div>
      <label>${t('login')}</label><input id="pw" type="password" placeholder="••••••" onkeydown="if(event.key==='Enter')doLogin()">
      ${msg?`<div class="bad sub" style="margin-top:8px">${esc(msg)}</div>`:''}
      <div class="row" style="margin-top:12px"><button onclick="doLogin()" style="width:100%">${t('login')}</button></div>
      <div class="sub" style="margin-top:8px">${state.lang==='fa'?'با رمز مدیر (ADMIN_PASSWORD) وارد شوید.':'Sign in with ADMIN_PASSWORD.'}</div></div>`;
  };
  window.doLogin = async () => {
    const pw = $('#pw').value;
    try { const r = await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw})});
      const j = await r.json(); if(!r.ok || j.ok===false) throw new Error(j.error||'login failed');
      state.token = j.data.token; sessionStorage.setItem('qv.token', state.token); location.reload(); }
    catch(e){ toast(e.message,'bad'); }
  };
  
  }
  const JS = '(' + clientApp.toString() + ')();';

  /* the page shell: one document, everything inline */
  const shell = (opts = {}) => {
    const lang = opts.lang === 'en' ? 'en' : 'fa';
    const dir = lang === 'fa' ? 'rtl' : 'ltr';
    const tabs = [['dash', '📊'], ['users', '👥'], ['sessions', '🔌'], ['strategy', '🛡'], ['sni', '🎭'], ['ips', '🌐'], ['dns', '🧭'], ['ai', '🤖'], ['logs', '📜'], ['access', '🔐'], ['backup', '💾'], ['test', '🧪']];
    return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="dark">
<title>${opts.title || 'Console'}</title><style>${CSS}</style></head><body>
<div class="wrap" id="app">
  <div class="top"><div class="brand"><div class="logo">QV</div><div>${opts.title || 'QUANTUM VEIL'}<div class="sub">v${opts.version || ''} · ${opts.subtitle || ''}</div></div></div>
    <div class="row"><select id="lang" onchange="QV.lang(this.value)" style="width:auto">
      <option value="fa" ${lang === 'fa' ? 'selected' : ''}>فارسی</option><option value="en" ${lang === 'en' ? 'selected' : ''}>English</option></select>
      <button class="ghost" onclick="sessionStorage.clear();location.reload()">⎋</button></div></div>
  <div class="tabs">${tabs.map(([id, ic]) => `<button data-tab="${id}" onclick="QV.tab('${id}')">${ic} <span data-t="${id}"></span></button>`).join('')}</div>
  <div id="view"><div class="card">…</div></div>
  <div class="sub" style="margin:18px 0 6px;text-align:center">${opts.footer || ''}</div>
</div>
<script>${JS}</script></body></html>`;
  };

  /** the user-facing panel: shows the user's own config(s) and usage */
  const userShell = (user, subs) => `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>اشتراک من</title><style>${CSS}</style></head><body><div class="wrap" style="max-width:760px">
<div class="top"><div class="brand"><div class="logo">QV</div><div>اشتراک من<div class="sub">${user.name || ''}</div></div></div>
  <button class="ghost" onclick="location.href='/'">⌂</button></div>
<div class="grid g2">
  <div class="card"><h3>مصرف</h3><div class="kpi">${(user.used_bytes / 1073741824).toFixed(2)} GB</div>
    <div class="sub">از ${(user.quota_bytes / 1073741824).toFixed(0)} GB</div>
    <div class="bar" style="margin-top:8px"><i style="width:${Math.min(100, Math.round((user.used_bytes / (user.quota_bytes || 1)) * 100))}%"></i></div>
    <div class="kv" style="margin-top:10px"><span class="muted">وضعیت</span><b>${user.enabled && !user.killswitch ? 'فعال' : 'قطع'}</b></div>
    <div class="kv"><span class="muted">انقضا</span><b>${user.expires_at ? new Date(user.expires_at * 1000).toLocaleDateString('fa-IR') : 'نامحدود'}</b></div></div>
  <div class="card"><h3>لینک‌ها</h3>
    <div class="sub">اشتراک (V2Ray/Clash/sing-box):</div><div class="code">${subs.subUrl}</div>
    <div class="row" style="margin-top:8px"><button class="sm" onclick="navigator.clipboard.writeText('${subs.subUrl}')">کپی</button>
      <a class="btn sm ghost" href="/qr?d=${encodeURIComponent(subs.subUrl)}&s=6" target="_blank">QR</a></div>
    <div class="sub" style="margin-top:12px">کانفیگ مستقیم:</div>
    <div class="code" style="max-height:120px;overflow:auto">${subs.nodes.join('\n')}</div></div>
</div></div></body></html>`;

  QV.panels = {
    /** a tiny inline SVG mark — no external asset, no request to anywhere */
    favicon: () => new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0d1117"/>'
      + '<path d="M18 40c0-8 6-14 14-14s14 6 14 14" stroke="#4ecdc4" stroke-width="5" fill="none" stroke-linecap="round"/>'
      + '<circle cx="32" cy="46" r="4" fill="#ffd166"/></svg>',
      { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=604800' } },
    ),
    render: (env, opts) => new Response(shell(Object.assign({ version: QV.VERSION, subtitle: 'Quantum Veil Console' }, opts)), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
    }),
    user: (env, user, subs) => new Response(userShell(user, subs), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    }),
    login: () => new Response(shell({ title: 'Console', subtitle: 'sign in' }).replace('<div id="view"><div class="card">…</div></div>', '<div id="view"></div>'), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    }),
    css: CSS, js: JS,
  };

  /* historic spellings used by the compatibility layer and old plugins */
  QV.panels.userPage = QV.panels.userPage || QV.panels.user;
  QV.panels.adminPage = QV.panels.adminPage || QV.panels.admin;
})();
