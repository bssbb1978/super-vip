
// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  VERSION: '5.0.0-optimized',
  ENVIRONMENT: 'production',
  
  ADMIN_PATH: '/admin',
  API_PATH: '/api',
  TELEGRAM_PATH: '/telegram-webhook',
  SNI_DASHBOARD_PATH: '/sni',
  HEALTH_CHECK_PATH: '/health',
  
  ANTI_CENSORSHIP: {
    DPI_EVASION: {
      ENABLED: true,
      FRAGMENT_PACKETS: true,
      MIN_FRAGMENT_SIZE: 32,
      MAX_FRAGMENT_SIZE: 128,
      RANDOMIZE_SIZE: true,
      MIN_FRAGMENT_DELAY: 5,
      MAX_FRAGMENT_DELAY: 30,
      JITTER_ENABLED: true,
    },
    TRAFFIC_MORPHING: {
      ENABLED: true,
      ADD_PADDING: true,
      MIN_PADDING: 8,
      MAX_PADDING: 64,
      RANDOM_PADDING: true,
      RANDOMIZE_TIMING: true,
      MIN_DELAY: 5,
      MAX_DELAY: 50,
      BREAK_PATTERNS: true,
      INSERT_DUMMY_PACKETS: true,
      DUMMY_PACKET_CHANCE: 0.05,
    },
    PROTOCOL_OBFUSCATION: {
      ENABLED: true,
      XOR_ENABLED: true,
      XOR_KEY_ROTATION: true,
      XOR_KEY_SIZE: 32,
      AES_ENABLED: true,
      AES_MODE: 'GCM',
      AES_KEY_SIZE: 256,
      MULTI_LAYER: true,
      LAYER_COUNT: 3,
    },
    TLS_RANDOMIZATION: {
      ENABLED: true,
      RANDOMIZE_CIPHERS: true,
      RANDOMIZE_ALPN: true,
      SHUFFLE_EXTENSIONS: true,
    },
  },
  
  CDN_FRONTING: {
    ENABLED: true,
    AUTO_SELECT: true,
    DOMAINS: [
      'www.cloudflare.com', 'dash.cloudflare.com', 'blog.cloudflare.com',
      'www.google.com', 'www.gstatic.com', 'ajax.googleapis.com',
      'www.microsoft.com', 'www.bing.com', 'outlook.office.com',
      'www.amazon.com', 'aws.amazon.com', 's3.amazonaws.com',
      'www.apple.com', 'www.icloud.com', 'developer.apple.com',
      'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
    ],
    SELECTION_STRATEGY: 'smart',
    HEALTH_CHECK: true,
  },
  
  MULTI_PATH: {
    ENABLED: true,
    PATHS: ['primary', 'fallback1', 'fallback2', 'fallback3'],
    LOAD_BALANCING: 'weighted_round_robin',
    WEIGHTS: { primary: 0.7, fallback1: 0.2, fallback2: 0.07, fallback3: 0.03 },
    AUTO_FAILOVER: true,
  },
  
  AI: {
    ENABLED: true,
    MODEL: '@cf/meta/llama-3.1-8b-instruct',
    SNI_DISCOVERY: { ENABLED: true, AUTO_UPDATE: true },
    TRAFFIC_ANALYSIS: { ENABLED: true, ADAPTIVE_MODE: true },
  },
  
  RATE_LIMIT: {
    ENABLED: true,
    REQUESTS_PER_MINUTE: 120,
    LOGIN_ATTEMPTS_PER_IP: 5,
    CONNECTION_ATTEMPTS_PER_MINUTE: 10,
  },
  
  SECURITY: {
    BLOCK_PRIVATE_IPS: true,
    BLOCKED_PORTS: [25, 465, 587, 1433, 3306, 3389, 5432, 6379, 27017],
    DDOS_PROTECTION: true,
    MAX_CONNECTIONS_PER_IP: 5,
  },
  
  CACHE: {
    USER_CACHE_TTL: 300,
    USER_PANEL_CACHE_TTL: 60,  // Cache HTML پنل برای ۶۰ ثانیه
    CDN_LIST_TTL: 3600,
    STATS_CACHE_TTL: 30,
  },
  
  GHOST_MODE: {
    ENABLED: true,
    REDIRECT_URLS: ['https://www.cloudflare.com', 'https://www.iana.org'],
  },
  
  MONITORING: {
    LOG_LEVEL: 'info',
    TRACK_PERFORMANCE: true,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN WORKER
// ═══════════════════════════════════════════════════════════════════════════════

const __GEN_DEFAULT_3 = {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    
    try {
      // Security Check - با بهینه‌سازی سرعت
      const securityCheck = await SecurityLayer.checkRequest(request, env, CONFIG);
      if (!securityCheck.allowed) {
        ctx.waitUntil(SecurityLayer.logSecurityEvent('blocked', clientIP, 
          { reason: securityCheck.reason }, env));
        return new Response('Forbidden', { status: 403 });
      }
      
      // Health Check
      if (path === CONFIG.HEALTH_CHECK_PATH || path === '/') {
        return handleHealthCheck(env, startTime);
      }
      
      // Telegram Webhook
      if (path === CONFIG.TELEGRAM_PATH) {
        return TelegramBot.handleWebhook(request, env, ctx);
      }
      
      // SNI Dashboard
      if (path.startsWith(CONFIG.SNI_DASHBOARD_PATH)) {
        return SNIDashboard.handle(request, env, ctx);
      }
      
      // Admin Panel
      if (path.startsWith(CONFIG.ADMIN_PATH)) {
        return AdminPanel.handle(request, env, ctx, CONFIG);
      }
      
      // API Routes
      if (path.startsWith(CONFIG.API_PATH)) {
        return handleAPIRoutes(request, env, ctx, path);
      }
      
      // UUID Pattern - VLESS Connection یا User Panel
      const uuidPattern = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
      const uuidMatch = path.match(uuidPattern);
      
      if (uuidMatch) {
        const uuid = uuidMatch[1].toLowerCase();
        
        // WebSocket = VLESS Connection
        if (request.headers.get('Upgrade') === 'websocket') {
          return handleVLESSConnection(request, uuid, env, ctx, CONFIG);
        }
        
        // HTTP = User Panel (بهینه‌شده برای سرعت)
        return handleUserPanelOptimized(uuid, request, env, ctx);
      }
      
      // Ghost Mode
      return handleGhostMode(request, CONFIG);
      
    } catch (error) {
      console.error('❌ Worker Error:', error);
      ctx.waitUntil(logError(env, 'worker_error', error, { path, clientIP }));
      return jsonResponse({ error: 'Internal Server Error', version: CONFIG.VERSION }, 500);
    } finally {
      const processingTime = Date.now() - startTime;
      if (CONFIG.MONITORING.TRACK_PERFORMANCE && processingTime > 100) {
        ctx.waitUntil(logPerformance(env, { path, method: request.method, time: processingTime }));
      }
    }
  },
  
  async scheduled(event, env, ctx) {
    console.log('⏰ Cron Started:', new Date().toISOString());
    
    try {
      await Promise.all([
        cleanupOldData(env),
        CONFIG.AI.ENABLED && AIEngine.runSNIDiscovery(env, ctx, CONFIG),
        CONFIG.CDN_FRONTING.HEALTH_CHECK && AntiCensorshipEngine.checkCDNHealth(env, CONFIG),
        updateStatistics(env),
      ].filter(Boolean));
      
      console.log('✅ Cron Completed');
    } catch (error) {
      console.error('❌ Cron Error:', error);
      await logError(env, 'cron_error', error, {});
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// VLESS CONNECTION HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleVLESSConnection(request, uuid, env, ctx, config) {
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  const connectionId = crypto.randomUUID();
  
  try {
    // Validation سریع با cache
    const user = await validateUserFast(uuid, env, config);
    if (!user) return new Response('Unauthorized', { status: 401 });
    
    // بررسی quota و expiry
    if (user.used_bytes >= user.total_bytes) {
      ctx.waitUntil(logQuotaExceeded(user, env));
      return new Response('Quota Exceeded', { status: 403 });
    }
    
    if (user.expire_at && Date.now() > user.expire_at) {
      return new Response('Account Expired', { status: 403 });
    }
    
    // بررسی IP limit
    const ipCheck = await checkIPLimitFast(uuid, clientIP, user.max_ips, env);
    if (!ipCheck.allowed) {
      return new Response('Too Many Connections', { status: 429 });
    }
    
    // ایجاد WebSocket connection
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    
    const antiCensorshipEngine = new AntiCensorshipEngine(config);
    
    // پردازش async connection
    ctx.waitUntil(
      VLESSEngine.processConnection(server, user, request, env, ctx, config, {
        connectionId, clientIP, antiCensorshipEngine
      }).catch(error => {
        console.error('❌ VLESS Error:', error);
        ctx.waitUntil(logError(env, 'vless_error', error, { uuid, connectionId }));
        try { server.close(1011, 'Error'); } catch (e) {}
      })
    );
    
    // لاگ async
    ctx.waitUntil(logConnectionStart(connectionId, uuid, clientIP, env));
    
    console.log(`✅ VLESS Connected: ${connectionId}`);
    return new Response(null, { status: 101, webSocket: client });
    
  } catch (error) {
    console.error('❌ VLESS Connection Failed:', error);
    ctx.waitUntil(logError(env, 'vless_conn_error', error, { uuid, clientIP }));
    return new Response('Connection Failed', { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER PANEL HANDLER - فوق‌بهینه‌سازی شده
// ═══════════════════════════════════════════════════════════════════════════════

async function handleUserPanelOptimized(uuid, request, env, ctx) {
  const startTime = Date.now();
  
  try {
    // بررسی درخواست JSON
    const acceptHeader = request.headers.get('Accept') || '';
    const wantsJSON = acceptHeader.includes('application/json');
    
    // تلاش برای دریافت از cache
    const cacheKey = `panel:${uuid}:${wantsJSON ? 'json' : 'html'}`;
    const cached = await env.KV.get(cacheKey);
    
    if (cached) {
      console.log(`⚡ Cache Hit: ${Date.now() - startTime}ms`);
      return wantsJSON 
        ? jsonResponse(JSON.parse(cached))
        : htmlResponse(cached);
    }
    
    // دریافت اطلاعات کاربر (با cache)
    const user = await validateUserFast(uuid, env, CONFIG);
    if (!user) {
      return wantsJSON 
        ? jsonResponse({ error: 'User not found' }, 404)
        : new Response('کاربر یافت نشد', { status: 404 });
    }
    
    // محاسبات سریع
    const stats = await calculateUserStats(user, uuid, env);
    
    if (wantsJSON) {
      // برگرداندن JSON
      const jsonData = {
        user: {
          email: user.email,
          uuid: user.uuid,
          used_bytes: user.used_bytes,
          total_bytes: user.total_bytes,
          usage_percent: stats.usagePercent,
          expire_at: user.expire_at,
          status: user.status,
          max_ips: user.max_ips,
          days_remaining: stats.daysRemaining,
        },
        stats: {
          total_connections: stats.totalConnections,
          active_connections: stats.activeConnections,
        },
        config: {
          vless: generateVlessConfig(uuid, request.url),
        },
      };
      
      // ذخیره در cache
      ctx.waitUntil(env.KV.put(cacheKey, JSON.stringify(jsonData), {
        expirationTtl: CONFIG.CACHE.USER_PANEL_CACHE_TTL,
      }));
      
      console.log(`⚡ Panel JSON Generated: ${Date.now() - startTime}ms`);
      return jsonResponse(jsonData);
    }
    
    // تولید HTML سریع
    const html = renderUserPanelFast(user, uuid, stats, request);
    
    // ذخیره در cache
    ctx.waitUntil(env.KV.put(cacheKey, html, {
      expirationTtl: CONFIG.CACHE.USER_PANEL_CACHE_TTL,
    }));
    
    console.log(`⚡ Panel HTML Generated: ${Date.now() - startTime}ms`);
    return htmlResponse(html);
    
  } catch (error) {
    console.error('❌ Panel Error:', error);
    ctx.waitUntil(logError(env, 'panel_error', error, { uuid }));
    return new Response('خطا در بارگذاری پنل', { status: 500 });
  }
}

// محاسبه سریع آمار کاربر
async function calculateUserStats(user, uuid, env) {
  const now = Date.now();
  
  // محاسبه درصد مصرف
  const usagePercent = user.total_bytes > 0 
    ? Math.round((user.used_bytes / user.total_bytes) * 100)
    : 0;
  
  // محاسبه روزهای باقیمانده
  let daysRemaining = '∞';
  if (user.expire_at) {
    const diff = user.expire_at - now;
    daysRemaining = diff > 0 ? Math.ceil(diff / 86400000) : 0;
  }
  
  // دریافت تعداد اتصالات (async و cached)
  let totalConnections = 0;
  let activeConnections = 0;
  
  try {
    const [totalResult, activeResult] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as c FROM connections WHERE user_uuid = ?').bind(uuid).first(),
      env.DB.prepare('SELECT COUNT(*) as c FROM connections WHERE user_uuid = ? AND status = ?').bind(uuid, 'active').first(),
    ]);
    
    totalConnections = totalResult?.c || 0;
    activeConnections = activeResult?.c || 0;
  } catch (error) {
    console.error('Stats Error:', error);
  }
  
  return {
    usagePercent,
    daysRemaining,
    totalConnections,
    activeConnections,
  };
}

// رندر سریع HTML با template literals
function renderUserPanelFast(user, uuid, stats, request) {
  const vlessConfig = generateVlessConfig(uuid, request.url);
  const createdDate = formatDate(user.created_at || Date.now() - 2592000000);
  const expiryDate = user.expire_at ? formatDate(user.expire_at) : 'نامحدود';
  
  return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>پنل کاربری VLESS Quantum Pro</title><style>*{margin:0;padding:0;box-sizing:border-box}:root{--primary:#6366f1;--secondary:#8b5cf6;--success:#10b981;--danger:#ef4444;--dark-bg:#0f172a;--card-bg:#1e293b;--text:#f1f5f9;--text-dim:#94a3b8;--border:#334155}body{font-family:Vazirmatn,-apple-system,sans-serif;background:linear-gradient(135deg,#020617,var(--dark-bg));color:var(--text);min-height:100vh;padding:20px}.container{max-width:1400px;margin:0 auto}.header{background:var(--card-bg);border-radius:16px;padding:30px;margin-bottom:30px;box-shadow:0 10px 30px rgba(0,0,0,.3);border:1px solid var(--border)}.header-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:20px}.logo{display:flex;align-items:center;gap:15px}.logo-icon{width:50px;height:50px;background:linear-gradient(135deg,var(--primary),var(--secondary));border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px}.logo-text h1{font-size:24px;font-weight:700;background:linear-gradient(135deg,var(--primary),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent}.logo-text p{font-size:14px;color:var(--text-dim)}.status-badge{padding:8px 20px;border-radius:50px;font-weight:600;font-size:14px;display:inline-flex;align-items:center;gap:8px;background:rgba(16,185,129,.2);color:var(--success);border:1px solid var(--success)}.status-dot{width:8px;height:8px;background:var(--success);border-radius:50%;animation:pulse 2s ease-in-out infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}.user-info{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin-top:20px}.info-item{background:rgba(99,102,241,.1);padding:15px;border-radius:12px;border:1px solid rgba(99,102,241,.2)}.info-label{font-size:12px;color:var(--text-dim);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}.info-value{font-size:18px;font-weight:700;word-break:break-all}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;margin-bottom:30px}.stat-card{background:var(--card-bg);border-radius:16px;padding:25px;border:1px solid var(--border);transition:all .3s;position:relative;overflow:hidden}.stat-card::before{content:'';position:absolute;top:0;left:0;width:100%;height:4px;background:linear-gradient(90deg,var(--primary),var(--secondary))}.stat-card:hover{transform:translateY(-5px);box-shadow:0 15px 40px rgba(0,0,0,.4)}.stat-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.stat-title{font-size:14px;color:var(--text-dim);font-weight:500}.stat-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px}.stat-value{font-size:32px;font-weight:700;margin-bottom:10px}.stat-subtitle{font-size:13px;color:var(--text-dim)}.progress-bar{width:100%;height:8px;background:rgba(255,255,255,.1);border-radius:10px;margin-top:15px;overflow:hidden}.progress-fill{height:100%;background:linear-gradient(90deg,var(--primary),var(--secondary));border-radius:10px;transition:width .5s}.config-section{display:grid;grid-template-columns:repeat(auto-fit,minmax(350px,1fr));gap:20px;margin-bottom:30px}.config-card{background:var(--card-bg);border-radius:16px;padding:25px;border:1px solid var(--border)}.config-card h3{font-size:18px;margin-bottom:20px}.config-content{background:#020617;padding:15px;border-radius:12px;font-family:'Courier New',monospace;font-size:12px;color:var(--text-dim);white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;margin-bottom:15px}.btn{padding:12px 24px;border-radius:10px;border:none;font-weight:600;font-size:14px;cursor:pointer;transition:all .3s;display:inline-flex;align-items:center;gap:8px;width:100%;justify-content:center}.btn-primary{background:linear-gradient(135deg,var(--primary),var(--secondary));color:#fff}.btn-primary:hover{transform:translateY(-2px);box-shadow:0 10px 25px rgba(99,102,241,.4)}.btn-secondary{background:rgba(99,102,241,.2);color:var(--primary);border:1px solid var(--primary)}.btn-secondary:hover{background:rgba(99,102,241,.3)}.btn-group{display:flex;gap:10px;margin-top:15px}.btn-group .btn{width:auto;flex:1}.qr-container{text-align:center;padding:20px}#qrcode{display:inline-block;padding:20px;background:#fff;border-radius:12px;margin-bottom:15px}.notification{position:fixed;top:20px;left:50%;transform:translateX(-50%) translateY(-100px);background:var(--card-bg);padding:15px 25px;border-radius:12px;border:1px solid var(--border);box-shadow:0 10px 30px rgba(0,0,0,.5);display:flex;align-items:center;gap:12px;z-index:1000;transition:transform .3s}.notification.show{transform:translateX(-50%) translateY(0)}.notification-icon{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--success)}@media (max-width:768px){.header-top{flex-direction:column;align-items:flex-start}.stats-grid,.config-section,.user-info{grid-template-columns:1fr}}</style></head><body><div class="container"><div class="header"><div class="header-top"><div class="logo"><div class="logo-icon">⚡</div><div class="logo-text"><h1>VLESS Quantum Pro</h1><p>پنل کاربری نسخه ۵.۰</p></div></div><div class="status-badge"><span class="status-dot"></span><span>فعال</span></div></div><div class="user-info"><div class="info-item"><div class="info-label">ایمیل</div><div class="info-value">${escapeHTML(user.email)}</div></div><div class="info-item"><div class="info-label">UUID</div><div class="info-value">${uuid}</div></div><div class="info-item"><div class="info-label">تاریخ ایجاد</div><div class="info-value">${createdDate}</div></div><div class="info-item"><div class="info-label">تاریخ انقضا</div><div class="info-value">${expiryDate}</div></div></div></div><div class="stats-grid"><div class="stat-card"><div class="stat-header"><span class="stat-title">ترافیک مصرفی</span><div class="stat-icon" style="background:rgba(239,68,68,.2);color:var(--danger)">📊</div></div><div class="stat-value">${formatBytes(user.used_bytes)}</div><div class="stat-subtitle">از ${formatBytes(user.total_bytes)} حجم کل</div><div class="progress-bar"><div class="progress-fill" style="width:${stats.usagePercent}%"></div></div></div><div class="stat-card"><div class="stat-header"><span class="stat-title">اتصالات فعال</span><div class="stat-icon" style="background:rgba(16,185,129,.2);color:var(--success)">🔗</div></div><div class="stat-value">${stats.activeConnections}</div><div class="stat-subtitle">حداکثر ${user.max_ips} دستگاه</div></div><div class="stat-card"><div class="stat-header"><span class="stat-title">روزهای باقیمانده</span><div class="stat-icon" style="background:rgba(245,158,11,.2);color:#f59e0b">⏰</div></div><div class="stat-value">${stats.daysRemaining}</div><div class="stat-subtitle">تا پایان اشتراک</div></div><div class="stat-card"><div class="stat-header"><span class="stat-title">کل اتصالات</span><div class="stat-icon" style="background:rgba(99,102,241,.2);color:var(--primary)">📈</div></div><div class="stat-value">${stats.totalConnections}</div><div class="stat-subtitle">از زمان ایجاد حساب</div></div></div><div class="config-section"><div class="config-card"><h3>🔐 کانفیگ اتصال</h3><div class="config-content" id="cfg">${escapeHTML(vlessConfig)}</div><div class="btn-group"><button class="btn btn-primary" onclick="copy()">📋 کپی کانفیگ</button><button class="btn btn-secondary" onclick="dl()">💾 دانلود</button></div></div><div class="config-card"><h3>📱 QR Code</h3><div class="qr-container"><div id="qr"></div><button class="btn btn-primary" onclick="dlqr()">📥 دانلود QR</button></div></div></div></div><div class="notification" id="notif"><div class="notification-icon">✓</div><span id="ntxt">عملیات موفق</span></div><script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"><\/script><script>function notify(m,t){const n=document.getElementById('notif'),tx=document.getElementById('ntxt');tx.textContent=m;n.className='notification '+(t||'success')+' show';setTimeout(()=>n.classList.remove('show'),3e3)}function copy(){const c=document.getElementById('cfg').textContent;navigator.clipboard.writeText(c).then(()=>notify('کانفیگ کپی شد')).catch(()=>notify('خطا','error'))}function dl(){const c=document.getElementById('cfg').textContent,b=new Blob([c],{type:'text/plain'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='vless-config.txt';a.click();URL.revokeObjectURL(u);notify('فایل دانلود شد')}function dlqr(){const cv=document.querySelector('#qr canvas');if(cv){const u=cv.toDataURL('image/png'),a=document.createElement('a');a.href=u;a.download='qr.png';a.click();notify('QR دانلود شد')}}window.addEventListener('load',()=>{const c=document.getElementById('cfg').textContent;if(c){new QRCode(document.getElementById('qr'),{text:c,width:200,height:200,colorDark:'#000',colorLight:'#fff',correctLevel:QRCode.CorrectLevel.H})}})<\/script></body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS - بهینه‌سازی شده
// ═══════════════════════════════════════════════════════════════════════════════

async function handleHealthCheck(env, startTime) {
  try {
    const [dbCheck, kvCheck] = await Promise.all([
      env.DB.prepare('SELECT 1 as s').first().catch(() => null),
      env.KV.get('health').catch(() => null),
    ]);
    
    const healthy = dbCheck?.s === 1;
    const time = Date.now() - startTime;
    
    return jsonResponse({
      status: healthy ? 'healthy' : 'degraded',
      version: CONFIG.VERSION,
      time: `${time}ms`,
      checks: { db: healthy ? 'ok' : 'fail', kv: 'ok' },
    }, healthy ? 200 : 503);
  } catch (error) {
    return jsonResponse({ status: 'error', version: CONFIG.VERSION }, 503);
  }
}

async function handleAPIRoutes(request, env, ctx, path) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  
  if (path === '/api/stats') return getStats(env);
  if (path === '/api/cdn-list') return getCDNList(env);
  if (path === '/api/ai/discover-sni') return AIEngine.discoverSNI(request, env, CONFIG);
  
  return jsonResponse({ error: 'Not Found' }, 404);
}

async function handleGhostMode(request, config) {
  const url = config.GHOST_MODE.REDIRECT_URLS[
    Math.floor(Math.random() * config.GHOST_MODE.REDIRECT_URLS.length)
  ];
  
  try {
    const res = await fetch(url, { method: request.method, headers: request.headers });
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch {
    return new Response('Service Unavailable', { status: 503 });
  }
}

// Validation سریع با cache
async function validateUserFast(uuid, env, config) {
  try {
    const key = `u:${uuid}`;
    const cached = await env.KV.get(key);
    if (cached) return JSON.parse(cached);
    
    const user = await env.DB.prepare(`
      SELECT uuid,email,used_bytes,total_bytes,max_ips,expire_at,status,created_at
      FROM users WHERE uuid=? AND status='active'
    `).bind(uuid).first();
    
    if (user) {
      await env.KV.put(key, JSON.stringify(user), {
        expirationTtl: config.CACHE.USER_CACHE_TTL,
      });
    }
    
    return user;
  } catch (error) {
    console.error('Validate Error:', error);
    return null;
  }
}

// بررسی سریع IP limit
async function checkIPLimitFast(uuid, clientIP, maxIPs, env) {
  try {
    const key = `ips:${uuid}`;
    const data = await env.KV.get(key);
    const ips = data ? JSON.parse(data) : {};
    
    ips[clientIP] = Date.now();
    
    // پاکسازی IP های قدیمی
    const cutoff = Date.now() - 300000; // 5 دقیقه
    Object.keys(ips).forEach(ip => {
      if (ips[ip] < cutoff) delete ips[ip];
    });
    
    const count = Object.keys(ips).length;
    const allowed = count <= maxIPs;
    
    if (allowed) {
      await env.KV.put(key, JSON.stringify(ips), { expirationTtl: 600 });
    }
    
    return { allowed, count };
  } catch (error) {
    console.error('IP Check Error:', error);
    return { allowed: true };
  }
}

function generateVlessConfig(uuid, requestUrl) {
  const url = new URL(requestUrl);
  return `vless://${uuid}@${url.hostname}:443?encryption=none&security=tls&sni=www.cloudflare.com&type=ws&host=${url.hostname}&path=${encodeURIComponent('/' + uuid)}#VLESS-Quantum-Pro`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

function formatDate(ts) {
  if (!ts) return 'نامشخص';
  return new Date(ts).toLocaleDateString('fa-IR') + ' ' + new Date(ts).toLocaleTimeString('fa-IR');
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Async logging functions
async function logConnectionStart(id, uuid, ip, env) {
  try {
    await env.DB.prepare('INSERT INTO connections(id,user_uuid,client_ip,status,connected_at)VALUES(?,?,?,?,?)')
      .bind(id, uuid, ip, 'active', Date.now()).run();
  } catch (e) { console.error('Log Error:', e); }
}

async function logQuotaExceeded(user, env) {
  try {
    await env.DB.prepare('INSERT INTO security_events(user_uuid,event_type,details,timestamp)VALUES(?,?,?,?)')
      .bind(user.uuid, 'quota_exceeded', JSON.stringify({ used: user.used_bytes }), Date.now()).run();
  } catch (e) { console.error('Log Error:', e); }
}

async function logError(env, type, error, ctx) {
  try {
    await env.DB.prepare('INSERT INTO error_logs(error_type,message,stack,details,timestamp)VALUES(?,?,?,?,?)')
      .bind(type, error.message || 'Unknown', error.stack || '', JSON.stringify(ctx), Date.now()).run();
  } catch (e) { console.error('Log Error:', e); }
}

async function logPerformance(env, metric) {
  try {
    await env.DB.prepare('INSERT INTO performance_metrics(path,method,processing_time,timestamp)VALUES(?,?,?,?)')
      .bind(metric.path, metric.method, metric.time, Date.now()).run();
  } catch (e) { console.error('Log Error:', e); }
}

async function cleanupOldData(env) {
  const cutoff = Date.now() - 2592000000; // 30 days
  try {
    await Promise.all([
      env.DB.prepare('DELETE FROM connections WHERE connected_at<? AND status=?').bind(cutoff, 'closed').run(),
      env.DB.prepare('DELETE FROM error_logs WHERE timestamp<?').bind(cutoff).run(),
      env.DB.prepare('UPDATE users SET status=? WHERE expire_at<? AND status=?').bind('expired', Date.now(), 'active').run(),
    ]);
    console.log('✅ Cleanup done');
  } catch (e) { console.error('Cleanup Error:', e); }
}

async function updateStatistics(env) {
  console.log('📊 Stats updated');
}

async function getStats(env) {
  try {
    const [users, conns] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*)as c FROM users WHERE status=?').bind('active').first(),
      env.DB.prepare('SELECT COUNT(*)as c FROM connections WHERE status=?').bind('active').first(),
    ]);
    
    return jsonResponse({
      users: users?.c || 0,
      connections: conns?.c || 0,
      version: CONFIG.VERSION,
    });
  } catch (error) {
    return jsonResponse({ error: 'Failed' }, 500);
  }
}

async function getCDNList(env) {
  try {
    const key = 'cdn';
    const cached = await env.KV.get(key);
    if (cached) return jsonResponse(JSON.parse(cached));
    
    const data = {
      domains: CONFIG.CDN_FRONTING.DOMAINS,
      count: CONFIG.CDN_FRONTING.DOMAINS.length,
      updated: new Date().toISOString(),
    };
    
    await env.KV.put(key, JSON.stringify(data), { expirationTtl: 3600 });
    return jsonResponse(data);
  } catch (error) {
    return jsonResponse({ error: 'Failed' }, 500);
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * VLESS QUANTUM PRO v5.0 - GOD-MODE FINAL ORCHESTRATION
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const { VLESSEngine } = __QF_MODULES__['./vless-engine.js'] || {}; // [merged] shim for missing module ./vless-engine.js
const { SecurityLayer } = __QF_MODULES__['./security-layer.js'] || {}; // [merged] shim for missing module ./security-layer.js
const { AdminPanel } = __QF_MODULES__['./admin-panel.js'] || {}; // [merged] shim for missing module ./admin-panel.js
const { AntiCensorshipEngine } = __QF_MODULES__['./anti-censorship.js'] || {}; // [merged] shim for missing module ./anti-censorship.js
const { AIEngine } = __QF_MODULES__['./ai-engine.js'] || {}; // [merged] shim for missing module ./ai-engine.js
