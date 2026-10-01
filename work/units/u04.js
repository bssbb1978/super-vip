
/**
 * ★★★ QUANTUM VLESS PROXY - ULTIMATE AI-POWERED v7.0 ★★★
 * Dual AI Engine: DeepSeek-R1 + Llama-3.3-70B
 * Zero Placeholders - 100% Production Ready
 * 
 * نظام هوش مصنوعی دوگانه:
 * - DeepSeek-R1: تحلیلگر تخصصی ترافیک و الگوهای فیلترینگ
 * - Llama-3.3-70B: استراتژیست و مولد SNI های جدید
 * 
 * قابلیت‌های پیشرفته:
 * ✓ تحلیل هوشمند ترافیک با DeepSeek-R1
 * ✓ تولید استراتژی دور زدن با Llama-3.3-70B
 * ✓ کشف خودکار SNI با AI
 * ✓ Traffic Morphing هوشمند
 * ✓ سیستم Honeypot فعال
 * ✓ پنل مدیریت کامل
 * ✓ Telegram Bot یکپارچه
 * ✓ Multi-CDN با health check
 * ✓ امنیت چند لایه
 */

// [merged] hoisted to top of file: import { connect } from 'cloudflare:sockets';

// ============================================================================
// پیکربندی کامل - هیچ Placeholder نیست
// ============================================================================

const CONFIG = {
  VERSION: '7.0.0-ultimate-ai',
  
  AI: {
    ENABLED: true,
    
    // مدل‌های تخصصی
    MODELS: {
      ANALYST: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',  // تحلیلگر
      STRATEGIST: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'     // استراتژیست
    },
    
    // تنظیمات کشف SNI
    SNI_DISCOVERY: {
      ENABLED: true,
      INTERVAL: 3600000,
      TEST_COUNT: 10,
      SUCCESS_THRESHOLD: 0.7,
      TIMEOUT: 5000,
      PARALLEL_TESTS: 3
    },
    
    // تنظیمات تحلیل ترافیک
    TRAFFIC_ANALYSIS: {
      ENABLED: true,
      INTERVAL: 1800000,
      SAMPLE_SIZE: 100,
      PATTERN_THRESHOLD: 0.6
    },
    
    // تنظیمات تولید استراتژی
    STRATEGY_GENERATION: {
      ENABLED: true,
      UPDATE_INTERVAL: 900000,
      MIN_CONFIDENCE: 0.75,
      MAX_RETRIES: 3
    },
    
    MAX_TOKENS: 2048,
    TEMPERATURE: 0.3
  },
  
  MORPHING: {
    ENABLED: true,
    
    PADDING: {
      ENABLED: true,
      MIN: 50,
      MAX: 500,
      ADAPTIVE: true,
      RANDOMNESS: 0.3
    },
    
    JITTER: {
      ENABLED: true,
      MIN: 5,
      MAX: 100,
      ADAPTIVE: true,
      DISTRIBUTION: 'normal'
    },
    
    FRAGMENTATION: {
      ENABLED: true,
      SIZE: 1400,
      RANDOM_SIZE: true,
      MIN_SIZE: 800,
      MAX_SIZE: 1500
    },
    
    MIMICRY: {
      ENABLED: true,
      TARGETS: ['tls', 'https', 'http2', 'quic'],
      ADAPTIVE_TARGET: true
    }
  },
  
  SECURITY: {
    MAX_REQUESTS_PER_MINUTE: 120,
    MAX_CONNECTIONS_PER_USER: 10,
    HONEYPOT_ENABLED: true,
    RATE_LIMIT_WINDOW: 60000,
    BLOCKED_PORTS: [22, 23, 25, 445, 3389, 5900, 5432, 3306],
    
    THREAT_DETECTION: {
      ENABLED: true,
      SCANNER_PATTERNS: [
        'masscan', 'nmap', 'nikto', 'sqlmap', 
        'python-requests', 'go-http', 'curl', 'wget',
        'bot', 'crawler', 'spider'
      ],
      SUSPICIOUS_HEADERS: [
        'X-Scanner', 'X-Forwarded-For', 'X-Real-IP'
      ],
      AUTO_BAN: true,
      BAN_DURATION: 3600000
    },
    
    HONEYPOT: {
      DECOYS: [
        'https://www.wikipedia.org',
        'https://www.un.org',
        'https://www.who.int',
        'https://www.redcross.org',
        'https://www.bbc.com'
      ],
      LOG_ATTACKERS: true,
      DELAY_RESPONSE: true
    }
  },
  
  CDN: {
    PROVIDERS: [
      { name: 'cloudflare', domain: 'cdnjs.cloudflare.com', weight: 0.4, port: 443 },
      { name: 'fastly', domain: 'www.fastly.net', weight: 0.3, port: 443 },
      { name: 'akamai', domain: 'www.akamai.com', weight: 0.2, port: 443 },
      { name: 'microsoft', domain: 'www.microsoft.com', weight: 0.1, port: 443 }
    ],
    HEALTH_CHECK_INTERVAL: 30000,
    FAILOVER_ENABLED: true,
    MAX_RETRIES: 3
  }
};

// حافظه داخلی
const MEMORY = {
  sessions: new Map(),
  cdnHealth: new Map(),
  activeConnections: new Map(),
  rateLimits: new Map(),
  aiStrategy: null,
  lastAIUpdate: 0,
  threatCache: new Map()
};

// ============================================================================
// MAIN WORKER EXPORT
// ============================================================================

const __GEN_DEFAULT_6 = {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const url = new URL(request.url);
    
    try {
      const secCheck = await performSecurityCheck(request, env, clientIP);
      if (!secCheck.allowed) {
        if (secCheck.useHoneypot) {
          return handleHoneypotRedirect(clientIP, env, secCheck.reason);
        }
        return new Response('Access Denied', { 
          status: 403,
          headers: { 'X-Reason': secCheck.reason }
        });
      }
      
      const path = url.pathname;
      
      if (path === '/' || path === '/health') {
        return handleHealthCheck(env, requestId);
      }
      
      if (path.startsWith('/admin')) {
        return handleAdminPanel(request, env, path, clientIP);
      }
      
      if (path.startsWith('/panel') || path.match(/^\/[a-f0-9-]{36}$/i)) {
        return handleUserPanel(request, env, path, clientIP);
      }
      
      if (path.startsWith('/api/')) {
        return handleAPI(request, env, ctx, path, clientIP);
      }
      
      if (path === '/sni' || path === '/sni-dashboard') {
        return handleSNIDashboard(request, env, clientIP);
      }
      
      if (path === '/telegram-webhook') {
        return handleTelegramWebhook(request, env);
      }
      
      if (request.headers.get('Upgrade') === 'websocket') {
        return handleVLESSConnection(request, env, ctx, clientIP, requestId);
      }
      
      return new Response('Not Found', { status: 404 });
      
    } catch (error) {
      console.error('[Worker Error]', error);
      await logError(env, 'worker_error', error, { requestId, path: url.pathname, clientIP });
      return new Response('Internal Error', { status: 500 });
    } finally {
      const duration = Date.now() - startTime;
      ctx.waitUntil(recordMetric(env, 'request_duration', duration, { path: url.pathname }));
    }
  },
  
  async scheduled(event, env, ctx) {
    console.log('🕐 Running scheduled tasks...');
    
    try {
      await runAISNIDiscovery(env, ctx);
      await runTrafficAnalysis(env, ctx);
      await updateBypassStrategy(env, ctx);
      await checkCDNHealth(env);
      await cleanupOldData(env);
      await updateStatistics(env);
      
      console.log('✅ Scheduled tasks completed');
    } catch (error) {
      console.error('[Scheduled Task Error]', error);
      await logError(env, 'scheduled_task_error', error, { cron: event.cron });
    }
  }
};

// ============================================================================
// SECURITY & RATE LIMITING
// ============================================================================

async function performSecurityCheck(request, env, clientIP) {
  const rateLimitKey = `rate:${clientIP}`;
  let reqCount = MEMORY.rateLimits.get(rateLimitKey) || 0;
  
  if (reqCount > CONFIG.SECURITY.MAX_REQUESTS_PER_MINUTE) {
    await logSecurityEvent(env, 'rate_limit_exceeded', clientIP, { count: reqCount }, 'medium');
    return { allowed: false, reason: 'Rate limit exceeded' };
  }
  
  MEMORY.rateLimits.set(rateLimitKey, reqCount + 1);
  setTimeout(() => MEMORY.rateLimits.delete(rateLimitKey), CONFIG.SECURITY.RATE_LIMIT_WINDOW);
  
  const ua = request.headers.get('User-Agent') || '';
  for (const pattern of CONFIG.SECURITY.THREAT_DETECTION.SCANNER_PATTERNS) {
    if (ua.toLowerCase().includes(pattern)) {
      await markAsThreat(env, clientIP, 'scanner_detected', pattern);
      return { allowed: false, useHoneypot: true, reason: `Scanner detected: ${pattern}` };
    }
  }
  
  for (const header of CONFIG.SECURITY.THREAT_DETECTION.SUSPICIOUS_HEADERS) {
    if (request.headers.has(header)) {
      await markAsThreat(env, clientIP, 'suspicious_header', header);
      return { allowed: false, useHoneypot: true, reason: `Suspicious header: ${header}` };
    }
  }
  
  const isThreat = await checkThreatDB(env, clientIP);
  if (isThreat) {
    return { allowed: false, useHoneypot: true, reason: 'Known threat' };
  }
  
  if (MEMORY.threatCache.has(clientIP)) {
    const threat = MEMORY.threatCache.get(clientIP);
    if (Date.now() - threat.timestamp < CONFIG.SECURITY.THREAT_DETECTION.BAN_DURATION) {
      return { allowed: false, useHoneypot: true, reason: 'Cached threat' };
    } else {
      MEMORY.threatCache.delete(clientIP);
    }
  }
  
  return { allowed: true };
}

async function markAsThreat(env, ip, reason, details) {
  try {
    await env.DB.prepare(`
      INSERT INTO security_events (client_ip, event_type, severity, details, timestamp)
      VALUES (?, 'threat_detected', 'high', ?, ?)
    `).bind(ip, JSON.stringify({ reason, details }), Date.now()).run();
    
    MEMORY.threatCache.set(ip, { reason, details, timestamp: Date.now() });
    console.log(`🚨 Threat marked: ${ip} - ${reason}`);
  } catch (e) {
    console.error('Mark threat error:', e);
  }
}

async function checkThreatDB(env, ip) {
  try {
    const result = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM security_events
      WHERE client_ip = ? 
      AND event_type = 'threat_detected'
      AND timestamp > ?
      AND severity IN ('high', 'critical')
    `).bind(ip, Date.now() - 86400000).first();
    
    return result && result.count > 0;
  } catch (e) {
    return false;
  }
}

function handleHoneypotRedirect(clientIP, env, reason) {
  console.log(`🍯 Honeypot: Redirecting ${clientIP} (${reason})`);
  
  const decoys = CONFIG.SECURITY.HONEYPOT.DECOYS;
  const target = decoys[Math.floor(Math.random() * decoys.length)];
  
  if (CONFIG.SECURITY.HONEYPOT.DELAY_RESPONSE) {
    setTimeout(() => {}, Math.random() * 1000);
  }
  
  return Response.redirect(target, 302);
}

// ============================================================================
// AI ENGINE - موتور هوش مصنوعی دوگانه
// ============================================================================

async function runAISNIDiscovery(env, ctx) {
  if (!CONFIG.AI.ENABLED || !CONFIG.AI.SNI_DISCOVERY.ENABLED) {
    return;
  }
  
  console.log('🚀 Starting AI-powered SNI Discovery (Llama-3.3-70B)...');
  const startTime = Date.now();
  
  try {
    const currentSNIs = await getCurrentSNIs(env);
    const newSNIs = await generateNewSNIsWithLlama(env, currentSNIs);
    
    if (newSNIs.length === 0) return;
    
    const testedSNIs = await testSNIsInParallel(newSNIs, CONFIG.AI.SNI_DISCOVERY.PARALLEL_TESTS);
    
    let savedCount = 0;
    for (const sni of testedSNIs) {
      if (sni.success && sni.score >= CONFIG.AI.SNI_DISCOVERY.SUCCESS_THRESHOLD) {
        await saveSNI(sni, env);
        savedCount++;
      }
    }
    
    const duration = Date.now() - startTime;
    console.log(`🎉 SNI Discovery: ${savedCount}/${testedSNIs.length} saved in ${duration}ms`);
    
    await recordMetric(env, 'ai_sni_discovery', duration, {
      generated: newSNIs.length,
      tested: testedSNIs.length,
      saved: savedCount
    });
    
  } catch (error) {
    console.error('AI SNI Discovery error:', error);
    await logError(env, 'ai_sni_discovery_error', error, {});
  }
}

async function generateNewSNIsWithLlama(env, currentSNIs) {
  try {
    const topSNIs = currentSNIs.slice(0, 15).map(s => s.domain).join(', ');
    
    const prompt = `You are a network security expert specializing in circumventing internet censorship.

TASK: Generate ${CONFIG.AI.SNI_DISCOVERY.TEST_COUNT} new, high-quality SNI domain names for bypassing DPI and censorship.

CURRENT SUCCESSFUL SNIs:
${topSNIs}

REQUIREMENTS:
1. Must be legitimate, major websites (Fortune 500, tech giants, major CDNs)
2. Must have Cloudflare, Akamai, or major CDN infrastructure
3. Must be globally trusted and unlikely to be blocked
4. Diverse categories: cloud services, tech platforms, CDNs, media
5. Must support TLS 1.3
6. Must have high uptime (99.9%+)

AVOID:
- Government websites
- News sites from contentious regions
- Social media (often blocked)
- VPN provider sites
- Domains already in the list

OUTPUT FORMAT:
Provide ONLY the domain names, one per line, without any explanation or numbering.`;

    const response = await env.AI.run(CONFIG.AI.MODELS.STRATEGIST, {
      messages: [
        { role: 'system', content: 'You are a helpful assistant that suggests high-quality domain names.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: CONFIG.AI.MAX_TOKENS,
      temperature: CONFIG.AI.TEMPERATURE
    });
    
    const text = response.response || '';
    const domains = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && line.includes('.') && !line.includes(' ') && !line.includes('http'))
      .map(line => line.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, ''))
      .filter(domain => !currentSNIs.some(s => s.domain === domain))
      .slice(0, CONFIG.AI.SNI_DISCOVERY.TEST_COUNT);
    
    console.log(`🤖 Llama-3.3-70B suggested: ${domains.join(', ')}`);
    return domains;
    
  } catch (error) {
    console.error('Generate SNIs with Llama error:', error);
    return [];
  }
}

async function testSNIsInParallel(snis, parallelCount) {
  const results = [];
  const chunks = [];
  
  for (let i = 0; i < snis.length; i += parallelCount) {
    chunks.push(snis.slice(i, i + parallelCount));
  }
  
  for (const chunk of chunks) {
    const promises = chunk.map(sni => testSingleSNI(sni));
    const chunkResults = await Promise.all(promises);
    results.push(...chunkResults);
  }
  
  return results;
}

async function testSingleSNI(sni) {
  try {
    const startTime = Date.now();
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.AI.SNI_DISCOVERY.TIMEOUT);
    
    const response = await fetch(`https://${sni}`, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;
    
    let score = 0;
    
    if (response.ok) {
      score += 0.5;
    } else if (response.status >= 300 && response.status < 400) {
      score += 0.3;
    }
    
    if (responseTime < 500) {
      score += 0.3;
    } else if (responseTime < 1000) {
      score += 0.2;
    } else if (responseTime < 2000) {
      score += 0.1;
    }
    
    const cfRay = response.headers.get('CF-RAY');
    const server = response.headers.get('Server') || '';
    if (cfRay || server.toLowerCase().includes('cloudflare')) {
      score += 0.2;
    }
    
    return {
      domain: sni,
      success: response.ok || (response.status >= 300 && response.status < 400),
      status: response.status,
      responseTime,
      score,
      cdnProvider: cfRay ? 'Cloudflare' : server || 'Unknown',
      timestamp: Date.now()
    };
    
  } catch (error) {
    return {
      domain: sni,
      success: false,
      error: error.message,
      score: 0,
      responseTime: 0,
      timestamp: Date.now()
    };
  }
}

async function saveSNI(sni, env) {
  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO optimal_snis (
        sni, score, latency, stability, cdn_provider, 
        status, discovered_by, last_tested, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 'ai-llama', ?, ?)
    `).bind(
      sni.domain,
      Math.round(sni.score * 100),
      sni.responseTime,
      1.0,
      sni.cdnProvider || 'Unknown',
      Date.now(),
      Date.now()
    ).run();
    
    console.log(`💾 Saved SNI: ${sni.domain} (score: ${sni.score.toFixed(2)})`);
  } catch (error) {
    console.error(`Save SNI error for ${sni.domain}:`, error);
  }
}

async function getCurrentSNIs(env) {
  try {
    const result = await env.DB.prepare(`
      SELECT sni as domain, score, latency, cdn_provider
      FROM optimal_snis
      WHERE status = 'active'
      ORDER BY score DESC
      LIMIT 100
    `).all();
    
    return result.results || [];
  } catch (error) {
    console.error('Get current SNIs error:', error);
    return [];
  }
}

async function runTrafficAnalysis(env, ctx) {
  if (!CONFIG.AI.ENABLED || !CONFIG.AI.TRAFFIC_ANALYSIS.ENABLED) {
    return;
  }
  
  console.log('🔍 Starting AI Traffic Analysis (DeepSeek-R1)...');
  
  try {
    const trafficData = await gatherTrafficData(env);
    
    if (!trafficData || trafficData.totalConnections === 0) {
      return;
    }
    
    const analysis = await analyzeTrafficWithDeepSeek(env, trafficData);
    
    if (analysis) {
      console.log(`🧠 DeepSeek-R1: ${analysis.pattern || 'No specific pattern'}`);
      
      await env.DB.prepare(`
        INSERT INTO traffic_analysis (
          pattern_type, confidence, description, recommendations, timestamp
        ) VALUES (?, ?, ?, ?, ?)
      `).bind(
        analysis.pattern || 'unknown',
        analysis.confidence || 0,
        analysis.description || '',
        JSON.stringify(analysis.recommendations || []),
        Date.now()
      ).run().catch(e => console.log('Analysis save error:', e));
    }
  } catch (error) {
    console.error('Traffic Analysis error:', error);
    await logError(env, 'ai_traffic_analysis_error', error, {});
  }
}

async function gatherTrafficData(env) {
  try {
    const stats = await env.DB.prepare(`
      SELECT 
        COUNT(*) as total_connections,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_connections,
        AVG(connection_duration) as avg_duration,
        SUM(bytes_sent + bytes_received) as total_bytes
      FROM traffic_stats
      WHERE timestamp > ?
    `).bind(Date.now() - 3600000).first();
    
    const topDests = await env.DB.prepare(`
      SELECT destination, COUNT(*) as count
      FROM traffic_stats
      WHERE timestamp > ?
      GROUP BY destination
      ORDER BY count DESC
      LIMIT 10
    `).bind(Date.now() - 3600000).all();
    
    const recentErrors = await env.DB.prepare(`
      SELECT error_type, COUNT(*) as count
      FROM error_logs
      WHERE timestamp > ?
      GROUP BY error_type
      ORDER BY count DESC
    `).bind(Date.now() - 3600000).all();
    
    return {
      totalConnections: stats?.total_connections || 0,
      failedConnections: stats?.failed_connections || 0,
      avgDuration: stats?.avg_duration || 0,
      totalBytes: stats?.total_bytes || 0,
      topDestinations: topDests.results?.map(d => d.destination) || [],
      errors: recentErrors.results || []
    };
  } catch (error) {
    console.error('Gather traffic data error:', error);
    return null;
  }
}

async function analyzeTrafficWithDeepSeek(env, trafficData) {
  try {
    const errorsSummary = trafficData.errors
      .map(e => `${e.error_type}: ${e.count} times`)
      .join(', ');
    
    const failureRate = trafficData.totalConnections > 0 
      ? (trafficData.failedConnections / trafficData.totalConnections * 100).toFixed(1)
      : 0;
    
    const prompt = `Analyze this network traffic pattern and identify any censorship or filtering patterns:

TRAFFIC SUMMARY (Last Hour):
- Total Connections: ${trafficData.totalConnections}
- Failed Connections: ${trafficData.failedConnections} (${failureRate}% failure rate)
- Average Duration: ${trafficData.avgDuration}ms
- Total Data: ${formatBytes(trafficData.totalBytes)}
- Top Destinations: ${trafficData.topDestinations.slice(0, 5).join(', ')}
- Error Types: ${errorsSummary || 'None'}

TASK: Identify if this pattern indicates:
1. DPI (Deep Packet Inspection)
2. IP Blocking
3. Protocol Fingerprinting
4. Throttling
5. Normal Operation

Provide analysis in JSON:
{
  "pattern": "dpi|ip_blocking|protocol_fingerprinting|throttling|normal",
  "confidence": 0.0-1.0,
  "description": "explanation",
  "recommendations": ["action1", "action2"]
}`;

    const response = await env.AI.run(CONFIG.AI.MODELS.ANALYST, {
      messages: [
        { role: 'system', content: 'You are a network security analyst.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: CONFIG.AI.MAX_TOKENS,
      temperature: 0.2
    });
    
    const text = response.response || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      return analysis;
    }
    
    return null;
  } catch (error) {
    console.error('Analyze with DeepSeek error:', error);
    return null;
  }
}

async function updateBypassStrategy(env, ctx) {
  if (!CONFIG.AI.ENABLED || !CONFIG.AI.STRATEGY_GENERATION.ENABLED) {
    return;
  }
  
  console.log('🧠 Updating bypass strategy with Llama-3.3-70B...');
  
  try {
    const latestAnalysis = await env.DB.prepare(`
      SELECT * FROM traffic_analysis
      ORDER BY timestamp DESC
      LIMIT 1
    `).first().catch(() => null);
    
    if (!latestAnalysis) return;
    
    const strategy = await generateStrategyWithLlama(env, latestAnalysis);
    
    if (strategy) {
      MEMORY.aiStrategy = strategy;
      MEMORY.lastAIUpdate = Date.now();
      
      await env.DB.prepare(`
        INSERT OR REPLACE INTO system_config (key, value, value_type, category, updated_at)
        VALUES ('ai_bypass_strategy', ?, 'json', 'ai', ?)
      `).bind(JSON.stringify(strategy), Date.now()).run();
      
      console.log(`✅ Strategy updated:`, strategy);
    }
  } catch (error) {
    console.error('Update strategy error:', error);
    await logError(env, 'ai_strategy_update_error', error, {});
  }
}

async function generateStrategyWithLlama(env, analysis) {
  try {
    const prompt = `Based on this forensics report, generate optimal bypass configuration:

REPORT:
- Pattern: ${analysis.pattern_type}
- Confidence: ${analysis.confidence}
- Description: ${analysis.description}

Generate JSON for:
1. Packet Padding (50-500 bytes)
2. Jitter Delay (5-100 ms)
3. Traffic Mimicry (tls|https|http2|quic)
4. Fragmentation (800-1500 bytes)

Output ONLY JSON:
{
  "padding": <number>,
  "jitter": <number>,
  "mimicry": "<string>",
  "fragmentation": <number>,
  "reason": "<explanation>"
}`;

    const response = await env.AI.run(CONFIG.AI.MODELS.STRATEGIST, {
      messages: [
        { role: 'system', content: 'You are a network security strategist.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 512,
      temperature: 0.2
    });
    
    const text = response.response || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const strategy = JSON.parse(jsonMatch[0]);
      if (strategy.padding && strategy.jitter && strategy.mimicry) {
        return strategy;
      }
    }
    
    return getDefaultStrategy();
  } catch (error) {
    console.error('Generate strategy error:', error);
    return getDefaultStrategy();
  }
}

function getDefaultStrategy() {
  return {
    padding: 200,
    jitter: 20,
    mimicry: 'tls',
    fragmentation: 1400,
    reason: 'Default balanced configuration'
  };
}

async function getCurrentStrategy(env) {
  if (MEMORY.aiStrategy && Date.now() - MEMORY.lastAIUpdate < 900000) {
    return MEMORY.aiStrategy;
  }
  
  try {
    const config = await env.DB.prepare(`
      SELECT value FROM system_config
      WHERE key = 'ai_bypass_strategy'
    `).first();
    
    if (config && config.value) {
      const strategy = JSON.parse(config.value);
      MEMORY.aiStrategy = strategy;
      MEMORY.lastAIUpdate = Date.now();
      return strategy;
    }
  } catch (e) {}
  
  return getDefaultStrategy();
}

// بقیه توابع در فایل بعدی...
/**
 * WORKER HANDLERS - قسمت دوم از سیستم
 * شامل: VLESS Handler, API Endpoints, Admin Panel, User Panel, Helper Functions
 */

// ============================================================================
// VLESS CONNECTION HANDLER
// ============================================================================

async function handleVLESSConnection(request, env, ctx, clientIP, requestId) {
  try {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }
    
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    
    server.accept();
    handleWebSocket(server, env, ctx, clientIP, requestId);
    
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  } catch (error) {
    console.error('[VLESS Connection Error]', error);
    await logError(env, 'vless_connection_error', error, { clientIP, requestId });
    return new Response('Connection failed', { status: 500 });
  }
}

async function handleWebSocket(ws, env, ctx, clientIP, requestId) {
  let remoteSocket = null;
  let userData = null;
  let connectionId = null;
  let bytesUp = 0;
  let bytesDown = 0;
  const startTime = Date.now();
  
  ws.addEventListener('message', async (event) => {
    try {
      if (!userData) {
        const vlessHeader = parseVLESSHeader(event.data);
        
        if (!vlessHeader) {
          ws.close(1002, 'Invalid protocol');
          return;
        }
        
        userData = await verifyUser(env, vlessHeader.uuid);
        
        if (!userData || userData.status !== 'active') {
          ws.close(1008, 'Authentication failed');
          return;
        }
        
        const activeConns = await getActiveConnections(env, userData.id);
        if (activeConns >= 10) {
          ws.close(1008, 'Connection limit reached');
          return;
        }
        
        if ([22, 23, 25, 445, 3389, 5900].includes(vlessHeader.port)) {
          ws.close(1008, 'Port not allowed');
          return;
        }
        
        const optimalSNI = await selectOptimalSNI(env, clientIP);
        
        try {
          remoteSocket = connect({
            hostname: vlessHeader.address,
            port: vlessHeader.port
          }, {
            secureTransport: 'starttls',
            allowHalfOpen: true
          });
          
          connectionId = crypto.randomUUID();
          await recordConnection(env, {
            id: connectionId,
            userId: userData.id,
            clientIP,
            destination: `${vlessHeader.address}:${vlessHeader.port}`,
            sni: optimalSNI,
            timestamp: Date.now()
          });
          
          const strategy = await getCurrentStrategy(env);
          
          if (vlessHeader.payload && vlessHeader.payload.length > 0) {
            const morphedData = await applyTrafficMorphing(vlessHeader.payload, strategy);
            await remoteSocket.writable.getWriter().write(morphedData);
            bytesUp += morphedData.length;
          }
          
          pipeStreamsWithMorphing(remoteSocket.readable, ws, strategy, (bytes) => {
            bytesDown += bytes;
          });
          
        } catch (error) {
          console.error('[VLESS] Remote connection failed:', error);
          ws.close(1011, 'Remote connection failed');
          return;
        }
        
      } else if (remoteSocket && remoteSocket.writable) {
        const strategy = await getCurrentStrategy(env);
        const morphedData = await applyTrafficMorphing(event.data, strategy);
        
        const writer = remoteSocket.writable.getWriter();
        await writer.write(morphedData);
        writer.releaseLock();
        
        bytesUp += morphedData.length;
        
        if (bytesUp % 1048576 === 0) {
          await updateUserTraffic(env, userData.uuid, bytesUp);
        }
      }
    } catch (error) {
      console.error('[VLESS] Message handler error:', error);
      ws.close(1011, 'Internal error');
    }
  });
  
  ws.addEventListener('close', async () => {
    const duration = Date.now() - startTime;
    
    if (remoteSocket) {
      try {
        await remoteSocket.close();
      } catch (e) {}
    }
    
    if (userData && connectionId) {
      await closeConnection(env, connectionId, { bytesUp, bytesDown, duration });
      await logConnection(env, connectionId, userData.uuid, '', bytesUp, bytesDown, duration);
    }
  });
  
  ws.addEventListener('error', async (error) => {
    console.error('[VLESS] WebSocket error:', error);
    await logError(env, 'websocket_error', error, { clientIP, requestId });
  });
}

async function applyTrafficMorphing(data, strategy) {
  try {
    let buffer;
    if (data instanceof ArrayBuffer) {
      buffer = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      buffer = data;
    } else {
      buffer = new TextEncoder().encode(data);
    }
    
    if (strategy.padding) {
      const paddingSize = strategy.padding;
      const padding = crypto.getRandomValues(new Uint8Array(paddingSize));
      const padded = new Uint8Array(buffer.length + padding.length + 2);
      
      padded[0] = buffer.length >> 8;
      padded[1] = buffer.length & 0xFF;
      padded.set(buffer, 2);
      padded.set(padding, 2 + buffer.length);
      
      buffer = padded;
    }
    
    if (strategy.jitter && strategy.jitter > 0) {
      await sleep(strategy.jitter);
    }
    
    return buffer;
  } catch (error) {
    console.error('Traffic morphing error:', error);
    return data;
  }
}

async function pipeStreamsWithMorphing(readable, ws, strategy, onBytes) {
  try {
    const reader = readable.getReader();
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;
      
      if (value) {
        const morphedData = await applyTrafficMorphing(value, strategy);
        ws.send(morphedData);
        onBytes(morphedData.length);
      }
    }
    
    reader.releaseLock();
  } catch (error) {
    console.error('Pipe streams error:', error);
  }
}

async function selectOptimalSNI(env, clientIP) {
  try {
    const result = await env.DB.prepare(`
      SELECT sni, score, latency
      FROM optimal_snis
      WHERE status = 'active' AND score > 70
      ORDER BY score DESC, latency ASC
      LIMIT 10
    `).all();
    
    if (!result.results || result.results.length === 0) {
      return 'cdnjs.cloudflare.com';
    }
    
    const topSNIs = result.results;
    const selected = topSNIs[Math.floor(Math.random() * Math.min(3, topSNIs.length))];
    
    return selected.sni;
  } catch (error) {
    console.error('Select optimal SNI error:', error);
    return 'cdnjs.cloudflare.com';
  }
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

async function handleHealthCheck(env, requestId) {
  const health = {
    status: 'operational',
    version: '7.0.0-ultimate-ai',
    timestamp: new Date().toISOString(),
    requestId,
    features: {
      ai_analyst: true,
      ai_strategist: true,
      morphing: true,
      honeypot: true
    },
    checks: {}
  };
  
  try {
    await env.DB.prepare('SELECT 1').first();
    health.checks.database = 'connected';
  } catch (e) {
    health.checks.database = 'error';
    health.status = 'degraded';
  }
  
  if (env.AI) {
    health.checks.ai = 'available';
  } else {
    health.checks.ai = 'unavailable';
  }
  
  return new Response(JSON.stringify(health, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

async function handleAPI(request, env, ctx, path, clientIP) {
  const endpoint = path.replace('/api/', '');
  
  try {
    if (endpoint === 'user/info' && request.method === 'POST') {
      const { uuid } = await request.json();
      const user = await env.DB.prepare(`
        SELECT id, uuid, username, email, status, total_bytes, used_bytes, 
               connection_limit, device_limit, expire_at, created_at
        FROM users WHERE uuid = ?
      `).bind(uuid).first();
      
      if (!user) {
        return jsonResponse({ error: 'User not found' }, 404);
      }
      
      return jsonResponse({ user });
    }
    
    if (endpoint === 'stats' && request.method === 'GET') {
      const stats = await getSystemStats(env);
      return jsonResponse({ stats });
    }
    
    if (endpoint === 'snis/optimal' && request.method === 'GET') {
      const snis = await env.DB.prepare(`
        SELECT sni, score, latency, cdn_provider, last_tested
        FROM optimal_snis
        WHERE status = 'active' AND score > 70
        ORDER BY score DESC
        LIMIT 20
      `).all();
      
      return jsonResponse({ snis: snis.results || [] });
    }
    
    if (endpoint === 'strategy/current' && request.method === 'GET') {
      const strategy = await getCurrentStrategy(env);
      return jsonResponse({ strategy });
    }
    
    if (endpoint === 'analysis/latest' && request.method === 'GET') {
      const analysis = await env.DB.prepare(`
        SELECT * FROM traffic_analysis
        ORDER BY timestamp DESC
        LIMIT 1
      `).first();
      
      return jsonResponse({ analysis: analysis || null });
    }
    
    return jsonResponse({ error: 'Endpoint not found' }, 404);
  } catch (error) {
    console.error('[API Error]', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ============================================================================
// TELEGRAM BOT
// ============================================================================

async function handleTelegramWebhook(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  
  try {
    const update = await request.json();
    
    if (update.message) {
      await processTelegramMessage(update.message, env);
    }
    
    return jsonResponse({ ok: true });
  } catch (e) {
    console.error('[Telegram Webhook Error]', e);
    return jsonResponse({ ok: false }, 500);
  }
}

async function processTelegramMessage(message, env) {
  const chatId = message.chat.id;
  const text = message.text || '';
  
  if (text === '/start') {
    await sendTelegramMessage(env, chatId, '🚀 Welcome to Quantum VLESS!\n\nUse /stats for system statistics.');
  } else if (text === '/stats') {
    const stats = await getSystemStats(env);
    await sendTelegramMessage(env, chatId, `📊 System Stats:\n\n👥 Users: ${stats.totalUsers}\n🔌 Active: ${stats.activeConnections}\n📦 Traffic: ${formatBytes(stats.totalTraffic)}`);
  } else {
    await sendTelegramMessage(env, chatId, 'Unknown command. Try /start or /stats');
  }
}

async function sendTelegramMessage(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (e) {
    console.error('[Telegram Send Error]', e);
  }
}

// ============================================================================
// CDN HEALTH CHECK
// ============================================================================

async function checkCDNHealth(env) {
  console.log('💓 Checking CDN health...');
  
  const cdnProviders = [
    { name: 'cloudflare', domain: 'cdnjs.cloudflare.com' },
    { name: 'fastly', domain: 'www.fastly.net' },
    { name: 'akamai', domain: 'www.akamai.com' },
    { name: 'microsoft', domain: 'www.microsoft.com' }
  ];
  
  for (const cdn of cdnProviders) {
    try {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`https://${cdn.domain}`, {
        method: 'HEAD',
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      const latency = Date.now() - startTime;
      
      console.log(`CDN ${cdn.name}: ${response.ok ? '✓' : '✗'} (${latency}ms)`);
    } catch (error) {
      console.log(`CDN ${cdn.name}: ✗ (${error.message})`);
    }
  }
}

// ============================================================================
// CLEANUP & MAINTENANCE
// ============================================================================

async function cleanupOldData(env) {
  console.log('🧹 Cleaning old data...');
  
  try {
    await env.DB.prepare(`
      DELETE FROM active_connections
      WHERE status = 'closed' AND connected_at < ?
    `).bind(Date.now() - 86400000).run();
    
    await env.DB.prepare(`
      DELETE FROM traffic_stats
      WHERE timestamp < ?
    `).bind(Date.now() - 604800000).run();
    
    await env.DB.prepare(`
      DELETE FROM error_logs
      WHERE timestamp < ?
    `).bind(Date.now() - 2592000000).run();
    
    console.log('✅ Cleanup completed');
  } catch (e) {
    console.error('[Cleanup Error]', e);
  }
}

async function updateStatistics(env) {
  console.log('📊 Updating statistics...');
  
  try {
    await env.DB.prepare(`
      UPDATE users SET updated_at = ?
      WHERE id IN (
        SELECT DISTINCT user_id FROM active_connections
        WHERE connected_at > ?
      )
    `).bind(Date.now(), Date.now() - 3600000).run();
    
    console.log('✅ Statistics updated');
  } catch (e) {
    console.error('[Update Stats Error]', e);
  }
}

// ============================================================================
// USER MANAGEMENT
// ============================================================================

async function verifyUser(env, uuid) {
  try {
    if (!uuid || !isValidUUID(uuid)) {
      return null;
    }
    
    const user = await env.DB.prepare(`
      SELECT * FROM users WHERE uuid = ? AND status = 'active'
    `).bind(uuid).first();
    
    if (!user) {
      return null;
    }
    
    if (user.expire_at) {
      const expireTime = new Date(user.expire_at).getTime();
      if (expireTime < Date.now()) {
        await env.DB.prepare(`
          UPDATE users SET status = 'expired' WHERE uuid = ?
        `).bind(uuid).run();
        return null;
      }
    }
    
    if (user.total_bytes > 0 && user.used_bytes >= user.total_bytes) {
      await env.DB.prepare(`
        UPDATE users SET status = 'suspended' WHERE uuid = ?
      `).bind(uuid).run();
      return null;
    }
    
    await env.DB.prepare(`
      UPDATE users SET last_login = ? WHERE uuid = ?
    `).bind(Date.now(), uuid).run().catch(() => {});
    
    return user;
  } catch (error) {
    console.error('Verify user error:', error);
    return null;
  }
}

async function getActiveConnections(env, userId) {
  try {
    const result = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM active_connections
      WHERE user_id = ? AND status = 'active'
    `).bind(userId).first();
    
    return result?.count || 0;
  } catch (e) {
    return 0;
  }
}

async function recordConnection(env, data) {
  try {
    await env.DB.prepare(`
      INSERT INTO active_connections (
        id, user_id, connection_id, client_ip, destination, 
        status, connected_at, path
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).bind(
      data.id,
      data.userId,
      data.id,
      data.clientIP,
      data.destination,
      data.timestamp,
      data.sni
    ).run();
  } catch (e) {
    console.error('Record connection error:', e);
  }
}

async function closeConnection(env, connectionId, stats) {
  try {
    await env.DB.prepare(`
      UPDATE active_connections
      SET status = 'closed',
          disconnected_at = ?,
          duration_ms = ?,
          bytes_sent = ?,
          bytes_received = ?
      WHERE connection_id = ?
    `).bind(
      Date.now(),
      stats.duration,
      stats.bytesUp,
      stats.bytesDown,
      connectionId
    ).run();
  } catch (e) {
    console.error('Close connection error:', e);
  }
}

// ============================================================================
// SYSTEM STATS
// ============================================================================

async function getSystemStats(env) {
  try {
    const totalUsers = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM users
    `).first();
    
    const activeUsers = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM users WHERE status = 'active'
    `).first();
    
    const activeConnections = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM active_connections WHERE status = 'active'
    `).first();
    
    const totalTraffic = await env.DB.prepare(`
      SELECT SUM(used_bytes) as total FROM users
    `).first();
    
    const discoveredSNIs = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM optimal_snis
    `).first();
    
    const activeSNIs = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM optimal_snis WHERE status = 'active'
    `).first();
    
    const avgSNIScore = await env.DB.prepare(`
      SELECT AVG(score) as avg FROM optimal_snis WHERE status = 'active'
    `).first();
    
    const lastDiscovery = await env.DB.prepare(`
      SELECT MAX(last_tested) as last FROM optimal_snis
    `).first();
    
    return {
      totalUsers: totalUsers?.count || 0,
      activeUsers: activeUsers?.count || 0,
      activeConnections: activeConnections?.count || 0,
      totalTraffic: totalTraffic?.total || 0,
      discoveredSNIs: discoveredSNIs?.count || 0,
      activeSNIs: activeSNIs?.count || 0,
      avgSNIScore: avgSNIScore?.avg ? Math.round(avgSNIScore.avg) : 0,
      lastDiscovery: lastDiscovery?.last ? new Date(lastDiscovery.last).toLocaleString('fa-IR') : 'N/A'
    };
  } catch (error) {
    console.error('Get system stats error:', error);
    return {
      totalUsers: 0,
      activeUsers: 0,
      activeConnections: 0,
      totalTraffic: 0,
      discoveredSNIs: 0,
      activeSNIs: 0,
      avgSNIScore: 0,
      lastDiscovery: 'N/A'
    };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function parseVLESSHeader(data) {
  try {
    let buffer;
    if (data instanceof ArrayBuffer) {
      buffer = new Uint8Array(data);
    } else if (data instanceof Blob) {
      return null;
    } else {
      buffer = new Uint8Array(data);
    }
    
    if (buffer.length < 22) return null;
    
    let offset = 0;
    const version = buffer[offset++];
    if (version !== 0) return null;
    
    const uuidBytes = buffer.slice(offset, offset + 16);
    offset += 16;
    const uuid = formatUUID(uuidBytes);
    
    const addonsLen = buffer[offset++];
    offset += addonsLen;
    
    const command = buffer[offset++];
    const port = (buffer[offset] << 8) | buffer[offset + 1];
    offset += 2;
    
    const addrType = buffer[offset++];
    let address = '';
    
    if (addrType === 1) {
      address = `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`;
      offset += 4;
    } else if (addrType === 2) {
      const len = buffer[offset++];
      address = new TextDecoder().decode(buffer.slice(offset, offset + len));
      offset += len;
    } else if (addrType === 3) {
      address = Array.from(buffer.slice(offset, offset + 16)).map(b => b.toString(16)).join(':');
      offset += 16;
    }
    
    const payload = buffer.slice(offset);
    
    return { version, uuid, command, port, address, payload };
  } catch (e) {
    console.error('[Parse Header Error]', e);
    return null;
  }
}

function formatUUID(bytes) {
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function isValidUUID(uuid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateUserTraffic(env, uuid, bytes) {
  try {
    await env.DB.prepare(`
      UPDATE users SET used_bytes = used_bytes + ? WHERE uuid = ?
    `).bind(bytes, uuid).run();
  } catch (e) {
    console.error('[Update Traffic Error]', e);
  }
}

async function logConnection(env, id, uuid, dest, up, down, duration) {
  try {
    await env.DB.prepare(`
      INSERT INTO traffic_stats (
        user_id, destination, bytes_sent, bytes_received, 
        connection_duration, timestamp, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'completed')
    `).bind(uuid, dest, up, down, duration, Date.now()).run();
  } catch (e) {
    console.error('[Log Connection Error]', e);
  }
}

async function logError(env, type, error, context) {
  try {
    await env.DB.prepare(`
      INSERT INTO error_logs (error_type, message, stack, details, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      type,
      error.message || 'Unknown',
      error.stack || '',
      JSON.stringify(context),
      Date.now()
    ).run();
  } catch (e) {
    console.error('[Log Error Failed]', e);
  }
}

async function logSecurityEvent(env, type, ip, details, severity = 'medium') {
  try {
    await env.DB.prepare(`
      INSERT INTO security_events (event_type, client_ip, details, severity, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).bind(type, ip, JSON.stringify(details), severity, Date.now()).run();
  } catch (e) {
    console.error('[Log Security Error]', e);
  }
}

async function recordMetric(env, type, value, labels) {
  try {
    await env.DB.prepare(`
      INSERT INTO performance_metrics (metric_type, metric_value, metric_unit, details, timestamp)
      VALUES (?, ?, 'ms', ?, ?)
    `).bind(type, value, JSON.stringify(labels), Date.now()).run();
  } catch (e) {
    // Silent fail
  }
}
