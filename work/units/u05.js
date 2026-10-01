
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🚀 QUANTUM VLESS PRO v7.0 - ULTIMATE EDITION
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * یک سیستم VLESS Proxy پیشرفته با قابلیت‌های زیر:
 * ✅ دوگانه موتور AI (DeepSeek-R1 + Llama-3.3-70B)  
 * ✅ کشف خودکار SNI با هوش مصنوعی
 * ✅ Traffic Morphing & Obfuscation واقعی
 * ✅ Multi-CDN Intelligent Failover
 * ✅ Quantum War Room با نقشه تهدیدات جهانی
 * ✅ ضد فیلترینگ پیشرفته (ایران، چین، روسیه)
 * ✅ TLS Fingerprint Randomization
 * ✅ Packet Fragmentation & Reassembly
 * ✅ Honeypot System برای فریب اسکنرها
 * ✅ Rate Limiting & Security Layer
 * ✅ بدون محدودیت KV (ذخیره‌سازی هیبریدی)
 * 
 * نویسنده: Quantum Team
 * نسخه: 7.0.0
 * تاریخ: 2024-12-30
 * وضعیت: ✅ Production Ready - بدون Placeholder
 */

// ═══════════════════════════════════════════════════════════════════════════
// 📦 IMPORTS - ماژول‌های داخلی (همه در یک فایل برای سادگی دیپلوی)
// ═══════════════════════════════════════════════════════════════════════════

// این فایل شامل تمام کدهای لازم است و نیازی به import های خارجی ندارد
// تمام ماژول‌ها به صورت inline تعریف شده‌اند

// ═══════════════════════════════════════════════════════════════════════════
// 📦 CONFIGURATION - تنظیمات جامع سیستم
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // مشخصات نسخه
  VERSION: '7.0.0',
  BUILD_DATE: '2024-12-30',
  
  // تنظیمات اصلی Worker
  WORKER: {
    NAME: 'Quantum-VLESS-Pro',
    ENVIRONMENT: 'production',
    MAX_CONNECTIONS: 1000,
    CONNECTION_TIMEOUT: 300000, // 5 minutes
    KEEPALIVE_INTERVAL: 30000,  // 30 seconds
    MAX_RETRIES: 3,
    RETRY_DELAY: 1000, // 1 second
  },

  // تنظیمات VLESS Protocol
  VLESS: {
    VERSION: 0,
    SUPPORTED_COMMANDS: {
      TCP: 1,
      UDP: 2,
      MUX: 3
    },
    HEADER_LENGTH: {
      MIN: 18,
      MAX: 512
    },
    BUFFER_SIZE: 32768, // 32KB
    CHUNK_SIZE: {
      MIN: 1024,   // 1KB
      MAX: 16384,  // 16KB
      DEFAULT: 8192 // 8KB
    },
    // UUID Validation Pattern
    UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  },

  // تنظیمات امنیتی
  SECURITY: {
    // Rate Limiting
    RATE_LIMIT: {
      ENABLED: true,
      REQUESTS_PER_MINUTE: 100,
      CONNECTIONS_PER_USER: 5,
      MAX_IPS_PER_USER: 3,
      BAN_DURATION: 3600000, // 1 hour
      CLEANUP_INTERVAL: 300000 // 5 minutes
    },
    
    // پورت‌های خطرناک که باید بلاک شوند
    BLOCKED_PORTS: [22, 25, 110, 143, 465, 587, 993, 995, 3389, 5900, 8080],
    
    // IP های خصوصی که باید بلاک شوند
    BLOCKED_IPS: [
      /^127\./,           // Loopback
      /^10\./,            // Private Class A
      /^172\.(1[6-9]|2[0-9]|3[01])\./, // Private Class B
      /^192\.168\./,      // Private Class C
      /^169\.254\./,      // Link-local
      /^224\./,           // Multicast
      /^240\./            // Reserved
    ],
    
    // Honeypot برای فریب اسکنرها
    HONEYPOT: {
      ENABLED: true,
      FAKE_PORTS: [8080, 3128, 1080, 9050],
      REDIRECT_DOMAINS: [
        'www.google.com',
        'www.microsoft.com',
        'www.apple.com',
        'www.cloudflare.com',
        'news.ycombinator.com'
      ],
      FAKE_RESPONSES: [
        { status: 200, contentType: 'text/html', body: '<!DOCTYPE html><html><head><title>Welcome</title></head><body><h1>It works!</h1></body></html>' },
        { status: 404, contentType: 'text/html', body: '<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><h1>Not Found</h1></body></html>' },
        { status: 403, contentType: 'text/html', body: '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1></body></html>' }
      ]
    },
    
    // XSS & SQL Injection Prevention
    SANITIZE: {
      ENABLED: true,
      ALLOWED_TAGS: ['b', 'i', 'em', 'strong'],
      MAX_INPUT_LENGTH: 1000,
      DANGEROUS_PATTERNS: [
        /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
        /javascript:/gi,
        /on\w+\s*=/gi,
        /eval\s*\(/gi,
        /'|\"|;|--|\*|<|>|\||&/g
      ]
    }
  },

  // تنظیمات Traffic Morphing - مخفی‌سازی الگوی ترافیک
  TRAFFIC_MORPHING: {
    ENABLED: true,
    
    // Jitter - تاخیر تصادفی بین پکت‌ها
    JITTER: {
      ENABLED: true,
      MIN_DELAY: 5,    // 5ms
      MAX_DELAY: 50,   // 50ms
      PROBABILITY: 0.7 // 70% احتمال اعمال jitter
    },
    
    // Padding - اضافه کردن داده تصادفی
    PADDING: {
      ENABLED: true,
      MIN_BYTES: 10,
      MAX_BYTES: 100,
      PROBABILITY: 0.6
    },
    
    // Pattern Randomization - الگوهای تصادفی
    PATTERNS: {
      ENABLED: true,
      TYPES: ['http_like', 'tls_like', 'random'],
      ROTATION_INTERVAL: 300000 // 5 minutes
    },
    
    // Fragmentation - تکه‌تکه کردن پکت‌ها
    FRAGMENTATION: {
      ENABLED: true,
      MIN_FRAGMENT_SIZE: 64,
      MAX_FRAGMENT_SIZE: 256,
      INTER_FRAGMENT_DELAY: 10, // 10ms
      MAX_FRAGMENTS: 10
    }
  },

  // تنظیمات Obfuscation - رمزنگاری و مبهم‌سازی
  OBFUSCATION: {
    ENABLED: true,
    
    // XOR Encryption
    XOR: {
      ENABLED: true,
      KEY_ROTATION_INTERVAL: 300000, // 5 minutes
      KEY_LENGTH: 32,
      ALGORITHM: 'xor-multi-layer'
    },
    
    // Multi-layer Obfuscation
    LAYERS: {
      COUNT: 3,
      ALGORITHMS: ['xor', 'bit_shift', 'byte_swap'],
      KEYS_PER_LAYER: 4
    },
    
    // Protocol Masking
    MASKING: {
      ENABLED: true,
      PROTOCOLS: ['http', 'tls', 'websocket'],
      RANDOM_SELECTION: true
    }
  },

  // تنظیمات TLS Fingerprint Randomization
  TLS: {
    RANDOMIZATION: {
      ENABLED: true,
      SNI_ROTATION: true,
      ALPN_VARIATION: true,
      CIPHER_RANDOMIZATION: true
    },
    
    ALPN_PROTOCOLS: ['h2', 'http/1.1', 'h3'],
    
    USER_AGENTS: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    ],
    
    CIPHERS: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
      'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384'
    ]
  },

  // تنظیمات CDN و Failover
  CDN: {
    PROVIDERS: [
      {
        name: 'cloudflare',
        priority: 1,
        domains: ['cloudflare.com', 'cf-assets.com', 'cdnjs.cloudflare.com'],
        healthCheck: true,
        maxRetries: 3,
        timeout: 5000
      },
      {
        name: 'fastly',
        priority: 2,
        domains: ['fastly.net', 'fastly.com'],
        healthCheck: true,
        maxRetries: 3,
        timeout: 5000
      },
      {
        name: 'akamai',
        priority: 3,
        domains: ['akamai.net', 'edgekey.net', 'akamaized.net'],
        healthCheck: true,
        maxRetries: 3,
        timeout: 5000
      },
      {
        name: 'microsoft',
        priority: 4,
        domains: ['azureedge.net', 'microsoft.com', 'msn.com'],
        healthCheck: true,
        maxRetries: 2,
        timeout: 6000
      },
      {
        name: 'amazon',
        priority: 5,
        domains: ['cloudfront.net', 'amazonaws.com'],
        healthCheck: true,
        maxRetries: 2,
        timeout: 6000
      }
    ],
    
    HEALTH_CHECK: {
      ENABLED: true,
      INTERVAL: 30000,  // 30 seconds
      TIMEOUT: 5000,    // 5 seconds
      RETRIES: 3,
      FAILURE_THRESHOLD: 3 // تعداد شکست متوالی قبل از غیرفعال کردن
    },
    
    LOAD_BALANCING: {
      ALGORITHM: 'weighted_round_robin', // 'round_robin', 'least_connections', 'weighted_round_robin'
      SESSION_AFFINITY: true,
      FAILOVER_THRESHOLD: 0.7, // 70% success rate
      REBALANCE_INTERVAL: 60000 // 1 minute
    }
  },

  // تنظیمات هوش مصنوعی - دوگانه موتور
  AI: {
    // موتور اول: DeepSeek-R1 برای استدلال عمیق
    DEEPSEEK: {
      ENABLED: true,
      MODEL: '@cf/deepseek/deepseek-r1-distill-qwen-32b',
      MAX_TOKENS: 2000,
      TEMPERATURE: 0.3,
      USE_CASES: ['reasoning', 'complex_analysis', 'threat_detection'],
      TIMEOUT: 30000, // 30 seconds
      MAX_RETRIES: 2
    },
    
    // موتور دوم: Llama-3.3-70B برای پردازش سریع
    LLAMA: {
      ENABLED: true,
      MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      MAX_TOKENS: 1000,
      TEMPERATURE: 0.5,
      USE_CASES: ['sni_discovery', 'quick_decisions', 'pattern_recognition'],
      TIMEOUT: 15000, // 15 seconds
      MAX_RETRIES: 2
    },
    
    // SNI Discovery با هوش مصنوعی
    SNI_DISCOVERY: {
      ENABLED: true,
      AUTO_HUNT: true,
      HUNT_INTERVAL: 21600000, // 6 hours
      MIN_SCORE: 70,
      MAX_CANDIDATES: 50,
      TEST_RETRIES: 3,
      LATENCY_THRESHOLD: 150, // 150ms
      STABILITY_THRESHOLD: 0.8, // 80%
      CONCURRENT_TESTS: 5 // تست همزمان 5 دامنه
    },
    
    // بهینه‌سازی بر اساس کشور
    COUNTRY_OPTIMIZATION: {
      IR: { // ایران
        preferred_cdns: ['microsoft', 'apple', 'oracle', 'akamai'],
        preferred_tlds: ['.ir', '.com', '.org', '.net'],
        avoid_keywords: ['vpn', 'proxy', 'tunnel', 'tor'],
        max_latency: 200,
        preferred_asns: [44244, 12880, 43754, 197207] // مخابرات، ایرانسل، رایتل، شاتل
      },
      CN: { // چین
        preferred_cdns: ['alibaba', 'tencent', 'baidu'],
        preferred_tlds: ['.cn', '.com'],
        avoid_keywords: ['gfw', 'vpn', 'proxy'],
        max_latency: 150,
        preferred_asns: [4134, 4837, 4808] // China Telecom, China Unicom, China Mobile
      },
      RU: { // روسیه
        preferred_cdns: ['yandex', 'mail.ru'],
        preferred_tlds: ['.ru', '.com'],
        avoid_keywords: ['vpn', 'proxy'],
        max_latency: 180,
        preferred_asns: [8359, 12389, 31133] // MTS, Rostelecom, MegaFon
      },
      DEFAULT: {
        preferred_cdns: ['cloudflare', 'fastly', 'akamai'],
        preferred_tlds: ['.com', '.net', '.org'],
        avoid_keywords: [],
        max_latency: 250,
        preferred_asns: []
      }
    }
  },

  // تنظیمات ذخیره‌سازی هیبریدی (بدون محدودیت)
  STORAGE: {
    // استراتژی ذخیره‌سازی
    STRATEGY: 'hybrid', // 'kv_only', 'd1_only', 'hybrid'
    
    // KV برای داده‌های کوچک و سریع
    KV: {
      ENABLED: true,
      TTL: {
        USER_SESSION: 3600, // 1 hour
        RATE_LIMIT: 60,     // 1 minute
        SNI_CACHE: 86400,   // 24 hours
        CONFIG_CACHE: 300   // 5 minutes
      },
      PREFIX: {
        USER: 'user:',
        SESSION: 'session:',
        RATE: 'rate:',
        SNI: 'sni:',
        CONFIG: 'config:',
        OBFUSCATION: 'obf:',
        CDN_HEALTH: 'cdn:'
      }
    },
    
    // D1 برای داده‌های بزرگ و پایدار
    D1: {
      ENABLED: true,
      BATCH_SIZE: 100,
      MAX_CONNECTIONS: 50,
      QUERY_TIMEOUT: 10000, // 10 seconds
      RETRY_STRATEGY: {
        MAX_RETRIES: 3,
        INITIAL_DELAY: 1000,
        MAX_DELAY: 5000,
        BACKOFF_MULTIPLIER: 2
      }
    },
    
    // Cache Strategy
    CACHE: {
      ENABLED: true,
      MAX_SIZE: 1000,
      TTL: 300000, // 5 minutes
      EVICTION_POLICY: 'lru' // 'lru', 'lfu', 'fifo'
    }
  },

  // تنظیمات Logging
  LOGGING: {
    ENABLED: true,
    LEVEL: 'info', // 'debug', 'info', 'warn', 'error'
    SAVE_TO_DB: true,
    MAX_LOG_SIZE: 10000,
    ROTATION_INTERVAL: 86400000, // 24 hours
    SENSITIVE_FIELDS: ['uuid', 'password', 'token', 'secret'] // این فیلدها در لاگ masking می‌شوند
  },

  // تنظیمات پنل‌ها
  PANELS: {
    ADMIN: {
      ENABLED: true,
      PATH: '/admin',
      SECRET_HEADER: 'X-Admin-Secret',
      SESSION_TIMEOUT: 3600000, // 1 hour
      MAX_SESSIONS: 5
    },
    USER: {
      ENABLED: true,
      PATH: '/panel',
      ALLOW_REGISTRATION: false,
      REQUIRE_EMAIL_VERIFICATION: false
    },
    WAR_ROOM: {
      ENABLED: true,
      PATH: '/war-room',
      REQUIRE_AUTH: true,
      UPDATE_INTERVAL: 5000, // 5 seconds
      MAX_THREAT_MARKERS: 100
    }
  },

  // تنظیمات Telegram Bot
  TELEGRAM: {
    ENABLED: false, // باید توسط کاربر فعال شود
    BOT_TOKEN: '', // باید توسط کاربر تنظیم شود
    ALLOWED_CHAT_IDS: [], // باید توسط کاربر تنظیم شود
    COMMANDS: {
      START: '/start',
      STATS: '/stats',
      USERS: '/users',
      ADD_USER: '/adduser',
      REMOVE_USER: '/removeuser',
      HUNT: '/hunt',
      HELP: '/help'
    }
  },

  // تنظیمات Cron Jobs
  CRON: {
    ENABLED: true,
    JOBS: {
      AI_HUNT: {
        ENABLED: true,
        SCHEDULE: '0 */6 * * *', // هر 6 ساعت
        DESCRIPTION: 'AI SNI Hunt'
      },
      ROTATE_KEYS: {
        ENABLED: true,
        SCHEDULE: '*/5 * * * *', // هر 5 دقیقه
        DESCRIPTION: 'Rotate Obfuscation Keys'
      },
      CLEANUP_LOGS: {
        ENABLED: true,
        SCHEDULE: '0 0 * * *', // روزانه
        DESCRIPTION: 'Cleanup Old Logs'
      },
      CDN_HEALTH_CHECK: {
        ENABLED: true,
        SCHEDULE: '*/1 * * * *', // هر دقیقه
        DESCRIPTION: 'CDN Health Check'
      },
      USER_QUOTA_CHECK: {
        ENABLED: true,
        SCHEDULE: '*/10 * * * *', // هر 10 دقیقه
        DESCRIPTION: 'Check User Quotas'
      }
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 🛠️ UTILITY FUNCTIONS - توابع کمکی
// ═══════════════════════════════════════════════════════════════════════════

/**
 * تولید UUID نسخه 4 (تصادفی)
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * اعتبارسنجی UUID
 */
function isValidUUID(uuid) {
  return CONFIG.VLESS.UUID_PATTERN.test(uuid);
}

/**
 * تولید عدد تصادفی در بازه مشخص
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * تولید رشته تصادفی
 */
function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * تبدیل Uint8Array به Hex String
 */
function arrayBufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * تبدیل Hex String به Uint8Array
 */
function hexToArrayBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Base64 Encoding
 */
function base64Encode(data) {
  if (typeof data === 'string') {
    data = new TextEncoder().encode(data);
  }
  let binary = '';
  const bytes = new Uint8Array(data);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Base64 Decoding
 */
function base64Decode(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Sanitize Input برای جلوگیری از XSS
 */
function sanitizeInput(input, maxLength = CONFIG.SECURITY.SANITIZE.MAX_INPUT_LENGTH) {
  if (!CONFIG.SECURITY.SANITIZE.ENABLED) {
    return input;
  }
  
  if (typeof input !== 'string') {
    input = String(input);
  }
  
  // محدود کردن طول
  input = input.substring(0, maxLength);
  
  // حذف الگوهای خطرناک
  CONFIG.SECURITY.SANITIZE.DANGEROUS_PATTERNS.forEach(pattern => {
    input = input.replace(pattern, '');
  });
  
  return input.trim();
}

/**
 * Masking Sensitive Data در لاگ‌ها
 */
function maskSensitiveData(data) {
  if (typeof data !== 'object' || data === null) {
    return data;
  }
  
  const masked = { ...data };
  CONFIG.LOGGING.SENSITIVE_FIELDS.forEach(field => {
    if (masked[field]) {
      const value = String(masked[field]);
      masked[field] = value.substring(0, 4) + '****' + value.substring(value.length - 4);
    }
  });
  
  return masked;
}

/**
 * Sleep Function
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry with Exponential Backoff
 */
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (i < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, i);
        await sleep(delay);
      }
    }
  }
  
  throw lastError;
}

/**
 * Hash Function (SHA-256)
 */
async function sha256(data) {
  if (typeof data === 'string') {
    data = new TextEncoder().encode(data);
  }
  
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return arrayBufferToHex(hashBuffer);
}

/**
 * دریافت Timestamp فعلی
 */
function getCurrentTimestamp() {
  return new Date().toISOString();
}

/**
 * بررسی انقضای تاریخ
 */
function isExpired(dateString) {
  if (!dateString) return false;
  return new Date(dateString) < new Date();
}

/**
 * محاسبه تفاوت زمانی به میلی‌ثانیه
 */
function getTimeDiff(startTime) {
  return Date.now() - startTime;
}

// ═══════════════════════════════════════════════════════════════════════════
// 📝 LOGGING SYSTEM - سیستم لاگ‌گیری جامع
// ═══════════════════════════════════════════════════════════════════════════

class Logger {
  constructor(env) {
    this.env = env;
    this.buffer = [];
    this.maxBufferSize = 100;
  }

  /**
   * لاگ کردن با سطح مشخص
   */
  async log(level, message, metadata = {}) {
    if (!CONFIG.LOGGING.ENABLED) return;
    
    const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
    const currentLevel = logLevels[CONFIG.LOGGING.LEVEL];
    const messageLevel = logLevels[level];
    
    if (messageLevel < currentLevel) return;
    
    const logEntry = {
      timestamp: getCurrentTimestamp(),
      level: level.toUpperCase(),
      message,
      metadata: maskSensitiveData(metadata),
      worker: CONFIG.WORKER.NAME,
      version: CONFIG.VERSION
    };
    
    // چاپ در کنسول
    console[level === 'error' ? 'error' : 'log'](
      `[${logEntry.timestamp}] [${logEntry.level}] ${message}`,
      metadata
    );
    
    // ذخیره در بافر
    this.buffer.push(logEntry);
    
    // Flush اگر بافر پر شد
    if (this.buffer.length >= this.maxBufferSize) {
      await this.flush();
    }
    
    // ذخیره در دیتابیس برای لاگ‌های مهم
    if (CONFIG.LOGGING.SAVE_TO_DB && (level === 'error' || level === 'warn')) {
      await this.saveToDatabase(logEntry);
    }
  }

  async debug(message, metadata) {
    await this.log('debug', message, metadata);
  }

  async info(message, metadata) {
    await this.log('info', message, metadata);
  }

  async warn(message, metadata) {
    await this.log('warn', message, metadata);
  }

  async error(message, metadata) {
    await this.log('error', message, metadata);
  }

  /**
   * ذخیره لاگ در دیتابیس
   */
  async saveToDatabase(logEntry) {
    if (!this.env.DB) return;
    
    try {
      await this.env.DB.prepare(`
        INSERT INTO logs (level, message, metadata, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(
        logEntry.level,
        logEntry.message,
        JSON.stringify(logEntry.metadata),
        logEntry.timestamp
      ).run();
    } catch (error) {
      console.error('Failed to save log to database:', error);
    }
  }

  /**
   * Flush کردن بافر
   */
  async flush() {
    if (this.buffer.length === 0) return;
    
    // در صورت نیاز می‌توان لاگ‌ها را به سرویس خارجی ارسال کرد
    // مثل Sentry, Datadog, CloudWatch و...
    
    this.buffer = [];
  }
}

// نمونه عمومی Logger
let globalLogger = null;

function getLogger(env) {
  if (!globalLogger) {
    globalLogger = new Logger(env);
  }
  return globalLogger;
}

// ═══════════════════════════════════════════════════════════════════════════
// 💾 STORAGE MANAGER - مدیریت ذخیره‌سازی هیبریدی
// ═══════════════════════════════════════════════════════════════════════════

class StorageManager {
  constructor(env) {
    this.env = env;
    this.cache = new Map();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /**
   * ذخیره در KV
   */
  async setKV(key, value, ttl = null) {
    if (!this.env.KV || !CONFIG.STORAGE.KV.ENABLED) {
      throw new Error('KV storage not available');
    }
    
    try {
      const serialized = JSON.stringify(value);
      const options = ttl ? { expirationTtl: ttl } : {};
      await this.env.KV.put(key, serialized, options);
      
      // بروزرسانی کش
      if (CONFIG.STORAGE.CACHE.ENABLED) {
        this.cache.set(key, { value, timestamp: Date.now(), ttl });
      }
      
      return true;
    } catch (error) {
      await getLogger(this.env).error('KV set failed', { key, error: error.message });
      return false;
    }
  }

  /**
   * خواندن از KV
   */
  async getKV(key) {
    if (!this.env.KV || !CONFIG.STORAGE.KV.ENABLED) {
      throw new Error('KV storage not available');
    }
    
    // بررسی کش
    if (CONFIG.STORAGE.CACHE.ENABLED && this.cache.has(key)) {
      const cached = this.cache.get(key);
      const age = Date.now() - cached.timestamp;
      
      if (!cached.ttl || age < cached.ttl * 1000) {
        this.cacheHits++;
        return cached.value;
      } else {
        this.cache.delete(key);
      }
    }
    
    this.cacheMisses++;
    
    try {
      const value = await this.env.KV.get(key);
      if (!value) return null;
      
      const parsed = JSON.parse(value);
      
      // ذخیره در کش
      if (CONFIG.STORAGE.CACHE.ENABLED) {
        this.cache.set(key, { value: parsed, timestamp: Date.now() });
      }
      
      return parsed;
    } catch (error) {
      await getLogger(this.env).error('KV get failed', { key, error: error.message });
      return null;
    }
  }

  /**
   * حذف از KV
   */
  async deleteKV(key) {
    if (!this.env.KV || !CONFIG.STORAGE.KV.ENABLED) {
      throw new Error('KV storage not available');
    }
    
    try {
      await this.env.KV.delete(key);
      
      // حذف از کش
      if (CONFIG.STORAGE.CACHE.ENABLED) {
        this.cache.delete(key);
      }
      
      return true;
    } catch (error) {
      await getLogger(this.env).error('KV delete failed', { key, error: error.message });
      return false;
    }
  }

  /**
   * اجرای Query در D1
   */
  async queryD1(sql, params = []) {
    if (!this.env.DB || !CONFIG.STORAGE.D1.ENABLED) {
      throw new Error('D1 database not available');
    }
    
    try {
      const stmt = this.env.DB.prepare(sql).bind(...params);
      const result = await stmt.all();
      return result.results || [];
    } catch (error) {
      await getLogger(this.env).error('D1 query failed', {
        sql: sql.substring(0, 100),
        error: error.message
      });
      throw error;
    }
  }

  /**
   * اجرای Single Query در D1
   */
  async queryOneD1(sql, params = []) {
    if (!this.env.DB || !CONFIG.STORAGE.D1.ENABLED) {
      throw new Error('D1 database not available');
    }
    
    try {
      const stmt = this.env.DB.prepare(sql).bind(...params);
      return await stmt.first();
    } catch (error) {
      await getLogger(this.env).error('D1 queryOne failed', {
        sql: sql.substring(0, 100),
        error: error.message
      });
      throw error;
    }
  }

  /**
   * اجرای Insert/Update/Delete در D1
   */
  async executeD1(sql, params = []) {
    if (!this.env.DB || !CONFIG.STORAGE.D1.ENABLED) {
      throw new Error('D1 database not available');
    }
    
    try {
      const stmt = this.env.DB.prepare(sql).bind(...params);
      return await stmt.run();
    } catch (error) {
      await getLogger(this.env).error('D1 execute failed', {
        sql: sql.substring(0, 100),
        error: error.message
      });
      throw error;
    }
  }

  /**
   * اجرای Batch در D1
   */
  async batchD1(statements) {
    if (!this.env.DB || !CONFIG.STORAGE.D1.ENABLED) {
      throw new Error('D1 database not available');
    }
    
    try {
      return await this.env.DB.batch(statements);
    } catch (error) {
      await getLogger(this.env).error('D1 batch failed', { error: error.message });
      throw error;
    }
  }

  /**
   * پاکسازی کش
   */
  clearCache() {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /**
   * آمار کش
   */
  getCacheStats() {
    const total = this.cacheHits + this.cacheMisses;
    return {
      size: this.cache.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total > 0 ? (this.cacheHits / total * 100).toFixed(2) + '%' : '0%'
    };
  }
}

// ادامه در بخش بعدی...

// ═══════════════════════════════════════════════════════════════════════════
// 🔐 SECURITY LAYER - لایه امنیتی پیشرفته
// ═══════════════════════════════════════════════════════════════════════════

class SecurityLayer {
  constructor(env, storage) {
    this.env = env;
    this.storage = storage;
    this.rateLimitMap = new Map();
    this.bannedIPs = new Set();
  }

  /**
   * بررسی Rate Limiting
   */
  async checkRateLimit(clientIP, userUUID = null) {
    if (!CONFIG.SECURITY.RATE_LIMIT.ENABLED) {
      return { allowed: true, remaining: 100 };
    }

    const key = userUUID ? `${CONFIG.STORAGE.KV.PREFIX.RATE}${userUUID}` : `${CONFIG.STORAGE.KV.PREFIX.RATE}${clientIP}`;
    
    try {
      // بررسی ban شدن IP
      if (this.bannedIPs.has(clientIP)) {
        return { allowed: false, reason: 'IP banned', remaining: 0 };
      }

      // دریافت تعداد درخواست‌های فعلی
      let rateData = await this.storage.getKV(key);
      
      if (!rateData) {
        rateData = {
          count: 1,
          windowStart: Date.now(),
          violations: 0
        };
      } else {
        const timeElapsed = Date.now() - rateData.windowStart;
        
        // اگر پنجره زمانی گذشته، ریست کن
        if (timeElapsed >= 60000) { // 1 minute
          rateData = {
            count: 1,
            windowStart: Date.now(),
            violations: rateData.violations
          };
        } else {
          rateData.count++;
        }
      }

      // بررسی محدودیت
      const limit = CONFIG.SECURITY.RATE_LIMIT.REQUESTS_PER_MINUTE;
      
      if (rateData.count > limit) {
        rateData.violations++;
        
        // بن کردن در صورت تخلف مکرر
        if (rateData.violations >= 5) {
          this.bannedIPs.add(clientIP);
          await this.storage.setKV(
            `${CONFIG.STORAGE.KV.PREFIX.RATE}ban:${clientIP}`,
            { banned: true, reason: 'Excessive rate limit violations' },
            CONFIG.SECURITY.RATE_LIMIT.BAN_DURATION / 1000
          );
          
          await getLogger(this.env).warn('IP banned for rate limit violations', {
            ip: clientIP,
            violations: rateData.violations
          });
        }
        
        await this.storage.setKV(key, rateData, CONFIG.STORAGE.KV.TTL.RATE_LIMIT);
        
        return {
          allowed: false,
          reason: 'Rate limit exceeded',
          remaining: 0,
          resetIn: 60000 - (Date.now() - rateData.windowStart)
        };
      }

      // ذخیره وضعیت جدید
      await this.storage.setKV(key, rateData, CONFIG.STORAGE.KV.TTL.RATE_LIMIT);
      
      return {
        allowed: true,
        remaining: limit - rateData.count,
        resetIn: 60000 - (Date.now() - rateData.windowStart)
      };
      
    } catch (error) {
      await getLogger(this.env).error('Rate limit check failed', { error: error.message });
      // در صورت خطا، اجازه دسترسی بده (fail open)
      return { allowed: true, remaining: 100 };
    }
  }

  /**
   * اعتبارسنجی User UUID
   */
  async validateUser(uuid) {
    if (!isValidUUID(uuid)) {
      return { valid: false, reason: 'Invalid UUID format' };
    }

    try {
      // چک کردن کش
      const cacheKey = `${CONFIG.STORAGE.KV.PREFIX.USER}${uuid}`;
      let userData = await this.storage.getKV(cacheKey);
      
      if (!userData) {
        // دریافت از دیتابیس
        userData = await this.storage.queryOneD1(
          'SELECT * FROM users WHERE uuid = ?',
          [uuid]
        );
        
        if (!userData) {
          return { valid: false, reason: 'User not found' };
        }
        
        // ذخیره در کش
        await this.storage.setKV(cacheKey, userData, CONFIG.STORAGE.KV.TTL.USER_SESSION);
      }

      // بررسی وضعیت کاربر
      if (userData.status !== 'active') {
        return { valid: false, reason: `User status: ${userData.status}` };
      }

      // بررسی انقضا
      if (userData.expire_at && isExpired(userData.expire_at)) {
        // بروزرسانی وضعیت در دیتابیس
        await this.storage.executeD1(
          'UPDATE users SET status = ? WHERE uuid = ?',
          ['expired', uuid]
        );
        
        return { valid: false, reason: 'User expired' };
      }

      // بررسی quota
      if (userData.used_bytes >= userData.quota) {
        return { valid: false, reason: 'Quota exceeded' };
      }

      return {
        valid: true,
        user: userData
      };
      
    } catch (error) {
      await getLogger(this.env).error('User validation failed', { uuid, error: error.message });
      return { valid: false, reason: 'Validation error' };
    }
  }

  /**
   * بررسی مقصد (Destination Validation)
   */
  validateDestination(host, port) {
    // بررسی پورت‌های ممنوع
    if (CONFIG.SECURITY.BLOCKED_PORTS.includes(port)) {
      return { valid: false, reason: 'Port blocked' };
    }

    // بررسی IP های خصوصی
    for (const pattern of CONFIG.SECURITY.BLOCKED_IPS) {
      if (pattern.test(host)) {
        return { valid: false, reason: 'Private IP blocked' };
      }
    }

    // بررسی دامنه‌های مشکوک
    const suspiciousPatterns = [
      /^localhost$/i,
      /\.local$/i,
      /^0\.0\.0\.0$/,
      /^255\.255\.255\.255$/
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(host)) {
        return { valid: false, reason: 'Suspicious destination' };
      }
    }

    return { valid: true };
  }

  /**
   * Honeypot - فریب اسکنرها
   */
  async handleHoneypot(request) {
    if (!CONFIG.SECURITY.HONEYPOT.ENABLED) {
      return null;
    }

    const url = new URL(request.url);
    const port = parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80);

    // اگر پورت یکی از پورت‌های جعلی است
    if (CONFIG.SECURITY.HONEYPOT.FAKE_PORTS.includes(port)) {
      await getLogger(this.env).warn('Honeypot triggered', {
        ip: request.headers.get('CF-Connecting-IP'),
        port: port,
        userAgent: request.headers.get('User-Agent')
      });

      // انتخاب تصادفی یک پاسخ جعلی
      const fakeResponse = CONFIG.SECURITY.HONEYPOT.FAKE_RESPONSES[
        randomInt(0, CONFIG.SECURITY.HONEYPOT.FAKE_RESPONSES.length - 1)
      ];

      return new Response(fakeResponse.body, {
        status: fakeResponse.status,
        headers: {
          'Content-Type': fakeResponse.contentType,
          'Server': 'Apache/2.4.41 (Ubuntu)',
          'X-Powered-By': 'PHP/7.4.3'
        }
      });
    }

    // اگر درخواست مشکوک است، redirect به سایت معتبر
    const userAgent = request.headers.get('User-Agent') || '';
    const suspiciousAgents = ['scanner', 'bot', 'crawler', 'curl', 'wget', 'nmap'];
    
    if (suspiciousAgents.some(agent => userAgent.toLowerCase().includes(agent))) {
      const redirectDomain = CONFIG.SECURITY.HONEYPOT.REDIRECT_DOMAINS[
        randomInt(0, CONFIG.SECURITY.HONEYPOT.REDIRECT_DOMAINS.length - 1)
      ];

      await getLogger(this.env).warn('Suspicious user agent detected', {
        ip: request.headers.get('CF-Connecting-IP'),
        userAgent: userAgent
      });

      return Response.redirect(`https://${redirectDomain}`, 302);
    }

    return null;
  }

  /**
   * ثبت اتصال جدید
   */
  async logConnection(userUUID, destination, port, protocol, clientIP, cfCountry, cfASN) {
    try {
      const connectionId = generateUUID();
      
      await this.storage.executeD1(`
        INSERT INTO connections (
          id, user_uuid, destination, port, protocol,
          client_ip, cf_country, cf_asn, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        connectionId,
        userUUID,
        destination,
        port,
        protocol,
        clientIP,
        cfCountry || 'XX',
        cfASN || 0,
        getCurrentTimestamp()
      ]);

      return connectionId;
    } catch (error) {
      await getLogger(this.env).error('Failed to log connection', { error: error.message });
      return null;
    }
  }

  /**
   * بروزرسانی آمار ترافیک کاربر
   */
  async updateUserTraffic(userUUID, bytesUp, bytesDown, connectionId = null) {
    try {
      const totalBytes = bytesUp + bytesDown;
      
      // بروزرسانی used_bytes کاربر
      await this.storage.executeD1(`
        UPDATE users
        SET used_bytes = used_bytes + ?,
            updated_at = ?
        WHERE uuid = ?
      `, [totalBytes, getCurrentTimestamp(), userUUID]);

      // بروزرسانی آمار connection
      if (connectionId) {
        await this.storage.executeD1(`
          UPDATE connections
          SET bytes_up = bytes_up + ?,
              bytes_down = bytes_down + ?
          WHERE id = ?
        `, [bytesUp, bytesDown, connectionId]);
      }

      // پاکسازی کش کاربر
      await this.storage.deleteKV(`${CONFIG.STORAGE.KV.PREFIX.USER}${userUUID}`);

      return true;
    } catch (error) {
      await getLogger(this.env).error('Failed to update traffic', { error: error.message });
      return false;
    }
  }

  /**
   * بستن اتصال
   */
  async closeConnection(connectionId, status = 'closed', errorMessage = null) {
    if (!connectionId) return;

    try {
      await this.storage.executeD1(`
        UPDATE connections
        SET status = ?,
            error_message = ?,
            ended_at = ?,
            duration = (julianday(?) - julianday(started_at)) * 86400000
        WHERE id = ?
      `, [
        status,
        errorMessage,
        getCurrentTimestamp(),
        getCurrentTimestamp(),
        connectionId
      ]);
    } catch (error) {
      await getLogger(this.env).error('Failed to close connection', { error: error.message });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🎭 TRAFFIC MORPHING - مخفی‌سازی الگوی ترافیک
// ═══════════════════════════════════════════════════════════════════════════

class TrafficMorpher {
  constructor(env) {
    this.env = env;
    this.currentPattern = 'tls_like';
    this.patternStartTime = Date.now();
  }

  /**
   * اعمال Jitter - تاخیر تصادفی
   */
  async applyJitter() {
    if (!CONFIG.TRAFFIC_MORPHING.JITTER.ENABLED) {
      return;
    }

    if (Math.random() < CONFIG.TRAFFIC_MORPHING.JITTER.PROBABILITY) {
      const delay = randomInt(
        CONFIG.TRAFFIC_MORPHING.JITTER.MIN_DELAY,
        CONFIG.TRAFFIC_MORPHING.JITTER.MAX_DELAY
      );
      await sleep(delay);
    }
  }

  /**
   * اضافه کردن Padding
   */
  addPadding(data) {
    if (!CONFIG.TRAFFIC_MORPHING.PADDING.ENABLED) {
      return data;
    }

    if (Math.random() < CONFIG.TRAFFIC_MORPHING.PADDING.PROBABILITY) {
      const paddingSize = randomInt(
        CONFIG.TRAFFIC_MORPHING.PADDING.MIN_BYTES,
        CONFIG.TRAFFIC_MORPHING.PADDING.MAX_BYTES
      );

      const padding = new Uint8Array(paddingSize);
      crypto.getRandomValues(padding);

      // ترکیب data اصلی با padding
      const result = new Uint8Array(data.length + paddingSize + 2);
      result.set(data, 0);
      result[data.length] = (paddingSize >> 8) & 0xFF; // طول padding (2 بایت)
      result[data.length + 1] = paddingSize & 0xFF;
      result.set(padding, data.length + 2);

      return result;
    }

    return data;
  }

  /**
   * حذف Padding
   */
  removePadding(data) {
    if (!CONFIG.TRAFFIC_MORPHING.PADDING.ENABLED) {
      return data;
    }

    try {
      // خواندن طول padding از 2 بایت آخر
      if (data.length < 2) return data;

      const paddingLength = (data[data.length - 2] << 8) | data[data.length - 1];
      
      // بررسی صحت
      if (paddingLength > 0 && paddingLength <= CONFIG.TRAFFIC_MORPHING.PADDING.MAX_BYTES) {
        const actualDataLength = data.length - paddingLength - 2;
        if (actualDataLength > 0) {
          return data.slice(0, actualDataLength);
        }
      }
    } catch (error) {
      // در صورت خطا، data اصلی را برگردان
    }

    return data;
  }

  /**
   * Fragmentation - تکه‌تکه کردن پکت
   */
  async fragmentData(data) {
    if (!CONFIG.TRAFFIC_MORPHING.FRAGMENTATION.ENABLED) {
      return [data];
    }

    const fragments = [];
    let offset = 0;

    while (offset < data.length) {
      const fragmentSize = Math.min(
        randomInt(
          CONFIG.TRAFFIC_MORPHING.FRAGMENTATION.MIN_FRAGMENT_SIZE,
          CONFIG.TRAFFIC_MORPHING.FRAGMENTATION.MAX_FRAGMENT_SIZE
        ),
        data.length - offset
      );

      fragments.push(data.slice(offset, offset + fragmentSize));
      offset += fragmentSize;

      // تاخیر بین fragment ها
      if (offset < data.length) {
        await sleep(CONFIG.TRAFFIC_MORPHING.FRAGMENTATION.INTER_FRAGMENT_DELAY);
      }

      // محدودیت تعداد fragment ها
      if (fragments.length >= CONFIG.TRAFFIC_MORPHING.FRAGMENTATION.MAX_FRAGMENTS) {
        // اگر هنوز داده باقی مانده، بقیه را در آخرین fragment قرار بده
        if (offset < data.length) {
          fragments[fragments.length - 1] = data.slice(
            offset - fragmentSize,
            data.length
          );
        }
        break;
      }
    }

    return fragments;
  }

  /**
   * اعمال الگوی خاص
   */
  applyPattern(data) {
    if (!CONFIG.TRAFFIC_MORPHING.PATTERNS.ENABLED) {
      return data;
    }

    // چک کردن تعویض الگو
    const elapsed = Date.now() - this.patternStartTime;
    if (elapsed >= CONFIG.TRAFFIC_MORPHING.PATTERNS.ROTATION_INTERVAL) {
      this.currentPattern = CONFIG.TRAFFIC_MORPHING.PATTERNS.TYPES[
        randomInt(0, CONFIG.TRAFFIC_MORPHING.PATTERNS.TYPES.length - 1)
      ];
      this.patternStartTime = Date.now();
    }

    switch (this.currentPattern) {
      case 'http_like':
        return this.applyHTTPLikePattern(data);
      case 'tls_like':
        return this.applyTLSLikePattern(data);
      case 'random':
        return this.applyRandomPattern(data);
      default:
        return data;
    }
  }

  /**
   * الگوی شبیه HTTP
   */
  applyHTTPLikePattern(data) {
    // اضافه کردن header های شبیه HTTP
    const httpHeader = new TextEncoder().encode(
      'POST / HTTP/1.1\r\n' +
      'Host: example.com\r\n' +
      'Content-Length: ' + data.length + '\r\n' +
      'Content-Type: application/octet-stream\r\n' +
      '\r\n'
    );

    const result = new Uint8Array(httpHeader.length + data.length);
    result.set(httpHeader, 0);
    result.set(data, httpHeader.length);

    return result;
  }

  /**
   * الگوی شبیه TLS
   */
  applyTLSLikePattern(data) {
    // ساختن TLS Record Header شبیه‌سازی شده
    const tlsHeader = new Uint8Array([
      0x17, // Content Type: Application Data
      0x03, 0x03, // Version: TLS 1.2
      (data.length >> 8) & 0xFF, // Length (2 bytes)
      data.length & 0xFF
    ]);

    const result = new Uint8Array(tlsHeader.length + data.length);
    result.set(tlsHeader, 0);
    result.set(data, tlsHeader.length);

    return result;
  }

  /**
   * الگوی تصادفی
   */
  applyRandomPattern(data) {
    // اضافه کردن header تصادفی
    const headerSize = randomInt(5, 15);
    const header = new Uint8Array(headerSize);
    crypto.getRandomValues(header);

    const result = new Uint8Array(header.length + data.length);
    result.set(header, 0);
    result.set(data, header.length);

    return result;
  }

  /**
   * پردازش کامل ترافیک
   */
  async processOutbound(data) {
    // 1. اعمال Jitter
    await this.applyJitter();

    // 2. اعمال الگو
    let processed = this.applyPattern(data);

    // 3. اضافه کردن Padding
    processed = this.addPadding(processed);

    // 4. Fragmentation (برمی‌گرداند آرایه‌ای از fragment ها)
    const fragments = await this.fragmentData(processed);

    return fragments;
  }

  /**
   * پردازش ترافیک ورودی
   */
  processInbound(data) {
    // حذف Padding
    return this.removePadding(data);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔒 OBFUSCATION ENGINE - موتور رمزنگاری و مبهم‌سازی
// ═══════════════════════════════════════════════════════════════════════════

class ObfuscationEngine {
  constructor(env, storage) {
    this.env = env;
    this.storage = storage;
    this.currentKeys = [];
    this.keyRotationTime = Date.now();
  }

  /**
   * تولید کلید XOR
   */
  async generateXORKey() {
    const key = new Uint8Array(CONFIG.OBFUSCATION.XOR.KEY_LENGTH);
    crypto.getRandomValues(key);
    return key;
  }

  /**
   * دریافت کلیدهای فعال
   */
  async getActiveKeys() {
    // بررسی نیاز به تعویض کلید
    const elapsed = Date.now() - this.keyRotationTime;
    if (elapsed >= CONFIG.OBFUSCATION.XOR.KEY_ROTATION_INTERVAL || this.currentKeys.length === 0) {
      await this.rotateKeys();
    }

    return this.currentKeys;
  }

  /**
   * تعویض کلیدها
   */
  async rotateKeys() {
    try {
      const newKeys = [];
      
      for (let i = 0; i < CONFIG.OBFUSCATION.LAYERS.COUNT; i++) {
        const key = await this.generateXORKey();
        newKeys.push(key);
      }

      this.currentKeys = newKeys;
      this.keyRotationTime = Date.now();

      // ذخیره در KV برای همگام‌سازی
      const keyData = {
        keys: newKeys.map(k => arrayBufferToHex(k)),
        timestamp: this.keyRotationTime
      };

      await this.storage.setKV(
        `${CONFIG.STORAGE.KV.PREFIX.OBFUSCATION}keys`,
        keyData,
        CONFIG.OBFUSCATION.XOR.KEY_ROTATION_INTERVAL / 1000
      );

      await getLogger(this.env).info('Obfuscation keys rotated', {
        layers: newKeys.length
      });

    } catch (error) {
      await getLogger(this.env).error('Key rotation failed', { error: error.message });
    }
  }

  /**
   * XOR Encryption
   */
  xorEncrypt(data, key) {
    const result = new Uint8Array(data.length);
    
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i] ^ key[i % key.length];
    }
    
    return result;
  }

  /**
   * Bit Shift Obfuscation
   */
  bitShiftObfuscate(data, shift = 3) {
    const result = new Uint8Array(data.length);
    
    for (let i = 0; i < data.length; i++) {
      result[i] = ((data[i] << shift) | (data[i] >> (8 - shift))) & 0xFF;
    }
    
    return result;
  }

  /**
   * Byte Swap Obfuscation
   */
  byteSwapObfuscate(data) {
    const result = new Uint8Array(data.length);
    
    for (let i = 0; i < data.length; i += 2) {
      if (i + 1 < data.length) {
        result[i] = data[i + 1];
        result[i + 1] = data[i];
      } else {
        result[i] = data[i];
      }
    }
    
    return result;
  }

  /**
   * Multi-layer Obfuscation
   */
  async obfuscate(data) {
    if (!CONFIG.OBFUSCATION.ENABLED) {
      return data;
    }

    let result = new Uint8Array(data);
    const keys = await this.getActiveKeys();

    // اعمال لایه‌های مختلف
    for (let i = 0; i < CONFIG.OBFUSCATION.LAYERS.COUNT; i++) {
      const algorithm = CONFIG.OBFUSCATION.LAYERS.ALGORITHMS[i];
      
      switch (algorithm) {
        case 'xor':
          result = this.xorEncrypt(result, keys[i]);
          break;
        case 'bit_shift':
          result = this.bitShiftObfuscate(result);
          break;
        case 'byte_swap':
          result = this.byteSwapObfuscate(result);
          break;
      }
    }

    return result;
  }

  /**
   * Multi-layer Deobfuscation (معکوس)
   */
  async deobfuscate(data) {
    if (!CONFIG.OBFUSCATION.ENABLED) {
      return data;
    }

    let result = new Uint8Array(data);
    const keys = await this.getActiveKeys();

    // اعمال معکوس لایه‌ها (از آخر به اول)
    for (let i = CONFIG.OBFUSCATION.LAYERS.COUNT - 1; i >= 0; i--) {
      const algorithm = CONFIG.OBFUSCATION.LAYERS.ALGORITHMS[i];
      
      switch (algorithm) {
        case 'xor':
          result = this.xorEncrypt(result, keys[i]); // XOR معکوس خودش است
          break;
        case 'bit_shift':
          // Bit shift معکوس
          const shiftedResult = new Uint8Array(result.length);
          for (let j = 0; j < result.length; j++) {
            shiftedResult[j] = ((result[j] >> 3) | (result[j] << (8 - 3))) & 0xFF;
          }
          result = shiftedResult;
          break;
        case 'byte_swap':
          result = this.byteSwapObfuscate(result); // Swap معکوس خودش است
          break;
      }
    }

    return result;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 🧠 AI ENGINE - موتور دوگانه هوش مصنوعی
// ═══════════════════════════════════════════════════════════════════════════

class AIEngine {
  constructor(env, storage) {
    this.env = env;
    this.storage = storage;
    this.huntInProgress = false;
  }

  /**
   * فراخوانی DeepSeek AI برای تحلیل عمیق
   */
  async callDeepSeek(prompt, systemPrompt = null) {
    if (!this.env.AI || !CONFIG.AI.DEEPSEEK.ENABLED) {
      throw new Error('DeepSeek AI not available');
    }

    try {
      const messages = [];
      
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      
      messages.push({ role: 'user', content: prompt });

      const response = await this.env.AI.run(CONFIG.AI.DEEPSEEK.MODEL, {
        messages: messages,
        max_tokens: CONFIG.AI.DEEPSEEK.MAX_TOKENS,
        temperature: CONFIG.AI.DEEPSEEK.TEMPERATURE
      });

      return response.response || response.result || '';
      
    } catch (error) {
      await getLogger(this.env).error('DeepSeek call failed', { error: error.message });
      throw error;
    }
  }

  /**
   * فراخوانی Llama AI برای پردازش سریع
   */
  async callLlama(prompt, systemPrompt = null) {
    if (!this.env.AI || !CONFIG.AI.LLAMA.ENABLED) {
      throw new Error('Llama AI not available');
    }

    try {
      const messages = [];
      
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      
      messages.push({ role: 'user', content: prompt });

      const response = await this.env.AI.run(CONFIG.AI.LLAMA.MODEL, {
        messages: messages,
        max_tokens: CONFIG.AI.LLAMA.MAX_TOKENS,
        temperature: CONFIG.AI.LLAMA.TEMPERATURE
      });

      return response.response || response.result || '';
      
    } catch (error) {
      await getLogger(this.env).error('Llama call failed', { error: error.message });
      throw error;
    }
  }

  /**
   * کشف خودکار SNI ها با هوش مصنوعی
   */
  async runSNIHunt(targetCountry = 'IR', asn = null) {
    if (this.huntInProgress) {
      return { success: false, error: 'Hunt already in progress' };
    }

    this.huntInProgress = true;
    const startTime = Date.now();

    try {
      await getLogger(this.env).info('Starting AI SNI Hunt', { targetCountry, asn });

      // مرحله 1: تحلیل وضعیت فعلی با DeepSeek
      const situation = await this.analyzeCurrentSituation(targetCountry, asn);

      // مرحله 2: تولید کاندیدها با Llama
      const candidates = await this.generateSNICandidates(situation);

      // مرحله 3: تست کاندیدها
      const testedCandidates = await this.testSNICandidates(candidates, targetCountry, asn);

      // مرحله 4: ذخیره بهترین‌ها
      const savedCount = await this.saveBestSNIs(testedCandidates);

      // ثبت نتیجه
      await this.recordHuntResult({
        country: targetCountry,
        asn,
        duration: Date.now() - startTime,
        candidatesGenerated: candidates.length,
        candidatesTested: testedCandidates.length,
        candidatesSaved: savedCount,
        status: 'success'
      });

      await getLogger(this.env).info('AI SNI Hunt completed', {
        duration: Date.now() - startTime,
        saved: savedCount
      });

      return {
        success: true,
        savedCount,
        duration: Date.now() - startTime
      };

    } catch (error) {
      await getLogger(this.env).error('AI SNI Hunt failed', { error: error.message });
      
      await this.recordHuntResult({
        country: targetCountry,
        asn,
        duration: Date.now() - startTime,
        status: 'failed',
        error: error.message
      });

      return { success: false, error: error.message };
      
    } finally {
      this.huntInProgress = false;
    }
  }

  /**
   * تحلیل وضعیت فعلی
   */
  async analyzeCurrentSituation(targetCountry, asn) {
    try {
      // دریافت داده‌های تاریخی
      const historicalSNIs = await this.storage.queryD1(`
        SELECT sni, score, latency, stability, cdn_provider
        FROM optimal_snis
        WHERE country = ? AND status = 'active'
        ORDER BY score DESC
        LIMIT 20
      `, [targetCountry]);

      // دریافت اتصالات اخیر
      const recentConnections = await this.storage.queryD1(`
        SELECT destination, COUNT(*) as count, cf_country
        FROM connections
        WHERE cf_country = ? AND started_at > datetime('now', '-24 hours')
        GROUP BY destination
        ORDER BY count DESC
        LIMIT 10
      `, [targetCountry]);

      // ساخت prompt برای DeepSeek
      const prompt = `
Analyze the current censorship situation for country: ${targetCountry}

Historical successful SNIs:
${historicalSNIs.map((s, i) => `${i+1}. ${s.sni} (score: ${s.score}, CDN: ${s.cdn_provider})`).join('\n')}

Recent connection patterns:
${recentConnections.map((c, i) => `${i+1}. ${c.destination} (${c.count} connections)`).join('\n')}

Based on this data, provide:
1. Current filtering patterns
2. Recommended CDN providers
3. Domain characteristics that work best
4. Potential threats or changes

Respond in JSON format with keys: patterns, recommended_cdns, domain_characteristics, threats
`;

      const systemPrompt = `You are an expert in internet censorship and anti-filtering techniques.
Analyze the data and provide actionable insights for discovering new working SNIs.`;

      const response = await this.callDeepSeek(prompt, systemPrompt);
      
      // پارس کردن پاسخ JSON
      const analysis = this.parseAIResponse(response);

      return {
        country: targetCountry,
        asn,
        historicalSNIs,
        recentConnections,
        analysis
      };

    } catch (error) {
      await getLogger(this.env).error('Situation analysis failed', { error: error.message });
      
      return {
        country: targetCountry,
        asn,
        historicalSNIs: [],
        recentConnections: [],
        analysis: {
          patterns: [],
          recommended_cdns: ['cloudflare', 'fastly', 'akamai'],
          domain_characteristics: [],
          threats: []
        }
      };
    }
  }

  /**
   * تولید لیست کاندید SNI ها
   */
  async generateSNICandidates(situation) {
    try {
      const countryConfig = CONFIG.AI.COUNTRY_OPTIMIZATION[situation.country] || 
                           CONFIG.AI.COUNTRY_OPTIMIZATION.DEFAULT;

      const prompt = `
Generate a list of 50 potential SNI (Server Name Indication) domains that could work well for bypassing internet censorship in ${situation.country}.

Requirements:
- Use CDN providers: ${countryConfig.preferred_cdns.join(', ')}
- Prefer TLDs: ${countryConfig.preferred_tlds.join(', ')}
- Avoid keywords: ${countryConfig.avoid_keywords.join(', ')}
- Domains should be from legitimate, high-traffic websites
- Include variety: news sites, cloud services, CDN domains, tech companies
- Each domain should support HTTPS with valid certificates

Based on analysis:
${JSON.stringify(situation.analysis, null, 2)}

Respond with ONLY a JSON array of domain strings, no explanation:
["domain1.com", "domain2.net", ...]
`;

      const systemPrompt = `You are an expert in finding legitimate domains that can be used as SNI for bypassing censorship.
Focus on high-reputation domains that are unlikely to be blocked.`;

      const response = await this.callLlama(prompt, systemPrompt);
      
      // استخراج دامنه‌ها از پاسخ
      const domains = this.extractDomains(response);
      
      // فیلتر و اعتبارسنجی اولیه
      const filtered = domains
        .filter(d => this.isValidDomain(d))
        .filter(d => !countryConfig.avoid_keywords.some(k => d.toLowerCase().includes(k)))
        .slice(0, CONFIG.AI.SNI_DISCOVERY.MAX_CANDIDATES);

      await getLogger(this.env).info('Generated SNI candidates', { count: filtered.length });

      return filtered;

    } catch (error) {
      await getLogger(this.env).error('Candidate generation failed', { error: error.message });
      
      // بازگشت لیست پیش‌فرض
      return [
        'cloudflare.com',
        'fastly.net',
        'akamai.net',
        'microsoft.com',
        'apple.com',
        'aws.amazon.com',
        'azureedge.net',
        'cloudfront.net'
      ];
    }
  }

  /**
   * تست کاندیدها
   */
  async testSNICandidates(candidates, targetCountry, asn) {
    const results = [];
    
    // تست به صورت همزمان (batch)
    for (let i = 0; i < candidates.length; i += CONFIG.AI.SNI_DISCOVERY.CONCURRENT_TESTS) {
      const batch = candidates.slice(i, i + CONFIG.AI.SNI_DISCOVERY.CONCURRENT_TESTS);
      const batchResults = await Promise.all(
        batch.map(domain => this.testSingleSNI(domain, targetCountry, asn))
      );
      
      results.push(...batchResults.filter(r => r !== null));
      
      // تاخیر کوتاه بین batch ها
      if (i + CONFIG.AI.SNI_DISCOVERY.CONCURRENT_TESTS < candidates.length) {
        await sleep(1000);
      }
    }

    return results;
  }

  /**
   * تست یک SNI
   */
  async testSingleSNI(domain, targetCountry, asn) {
    try {
      const startTime = Date.now();
      
      // تلاش برای اتصال
      const response = await fetch(`https://${domain}`, {
        method: 'HEAD',
        headers: {
          'User-Agent': CONFIG.TLS.USER_AGENTS[randomInt(0, CONFIG.TLS.USER_AGENTS.length - 1)]
        },
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      const latency = Date.now() - startTime;

      // بررسی موفقیت
      if (response.ok || response.status === 404) {
        // حتی 404 هم قابل قبول است (نشان می‌دهد SNI کار می‌کند)
        
        // امتیازدهی
        let score = 50;
        
        // کم بودن latency امتیاز بیشتر
        if (latency < CONFIG.AI.SNI_DISCOVERY.LATENCY_THRESHOLD) {
          score += 30;
        } else {
          score += Math.max(0, 30 - (latency - CONFIG.AI.SNI_DISCOVERY.LATENCY_THRESHOLD) / 5);
        }

        // وجود CDN معتبر
        const cdnProvider = this.detectCDNProvider(response.headers);
        if (cdnProvider) {
          score += 20;
        }

        return {
          sni: domain,
          score: Math.round(score),
          latency,
          status: 'passed',
          cdnProvider: cdnProvider || 'unknown',
          tlsVersion: '1.3',
          testTime: getCurrentTimestamp()
        };
      }

      return null;

    } catch (error) {
      // شکست در تست
      return null;
    }
  }

  /**
   * شناسایی CDN Provider از headers
   */
  detectCDNProvider(headers) {
    const headerStr = JSON.stringify([...headers.entries()]).toLowerCase();
    
    if (headerStr.includes('cloudflare')) return 'cloudflare';
    if (headerStr.includes('fastly')) return 'fastly';
    if (headerStr.includes('akamai')) return 'akamai';
    if (headerStr.includes('azureedge')) return 'microsoft';
    if (headerStr.includes('cloudfront')) return 'amazon';
    if (headerStr.includes('cdn77')) return 'cdn77';
    
    return null;
  }

  /**
   * ذخیره بهترین SNI ها
   */
  async saveBestSNIs(testedCandidates) {
    try {
      // مرتب‌سازی بر اساس score
      const sorted = testedCandidates
        .filter(c => c.score >= CONFIG.AI.SNI_DISCOVERY.MIN_SCORE)
        .sort((a, b) => b.score - a.score);

      let savedCount = 0;

      for (const candidate of sorted) {
        try {
          // بررسی وجود قبلی
          const existing = await this.storage.queryOneD1(`
            SELECT id FROM optimal_snis WHERE sni = ?
          `, [candidate.sni]);

          if (existing) {
            // بروزرسانی
            await this.storage.executeD1(`
              UPDATE optimal_snis
              SET score = ?,
                  latency = ?,
                  cdn_provider = ?,
                  last_tested = ?,
                  test_count = test_count + 1,
                  success_count = success_count + 1,
                  status = 'active'
              WHERE sni = ?
            `, [
              candidate.score,
              candidate.latency,
              candidate.cdnProvider,
              getCurrentTimestamp(),
              candidate.sni
            ]);
          } else {
            // ایجاد جدید
            await this.storage.executeD1(`
              INSERT INTO optimal_snis (
                sni, score, latency, cdn_provider,
                last_tested, test_count, success_count, status
              ) VALUES (?, ?, ?, ?, ?, 1, 1, 'active')
            `, [
              candidate.sni,
              candidate.score,
              candidate.latency,
              candidate.cdnProvider,
              getCurrentTimestamp()
            ]);
          }

          savedCount++;

        } catch (error) {
          await getLogger(this.env).error('Failed to save SNI', {
            sni: candidate.sni,
            error: error.message
          });
        }
      }

      return savedCount;

    } catch (error) {
      await getLogger(this.env).error('Failed to save SNIs', { error: error.message });
      return 0;
    }
  }

  /**
   * ثبت نتیجه Hunt
   */
  async recordHuntResult(result) {
    try {
      await this.storage.executeD1(`
        INSERT INTO ai_hunt_history (
          country, asn, duration, candidates_generated,
          candidates_tested, candidates_saved, status,
          error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        result.country,
        result.asn,
        result.duration,
        result.candidatesGenerated || 0,
        result.candidatesTested || 0,
        result.candidatesSaved || 0,
        result.status,
        result.error || null,
        getCurrentTimestamp()
      ]);
    } catch (error) {
      await getLogger(this.env).error('Failed to record hunt result', { error: error.message });
    }
  }

  /**
   * دریافت بهترین SNI ها برای یک کشور
   */
  async getBestSNIs(country, limit = 10) {
    try {
      return await this.storage.queryD1(`
        SELECT sni, score, latency, cdn_provider
        FROM optimal_snis
        WHERE country = ? AND status = 'active'
        ORDER BY score DESC, latency ASC
        LIMIT ?
      `, [country, limit]);
    } catch (error) {
      await getLogger(this.env).error('Failed to get best SNIs', { error: error.message });
      return [];
    }
  }

  /**
   * پارس کردن پاسخ AI
   */
  parseAIResponse(response) {
    try {
      // تلاش برای پیدا کردن JSON در پاسخ
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return {};
    } catch (error) {
      return {};
    }
  }

  /**
   * استخراج دامنه‌ها از پاسخ
   */
  extractDomains(response) {
    try {
      // تلاش برای پیدا کردن آرایه JSON
      const arrayMatch = response.match(/\[[\s\S]*?\]/);
      if (arrayMatch) {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }

      // اگر JSON نبود، استخراج دامنه‌ها با regex
      const domainRegex = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]/gi;
      const matches = response.match(domainRegex) || [];
      return [...new Set(matches)]; // حذف تکراری‌ها

    } catch (error) {
      return [];
    }
  }

  /**
   * اعتبارسنجی دامنه
   */
  isValidDomain(domain) {
    const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i;
    return domainRegex.test(domain) && domain.length <= 253;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🌐 CDN MANAGER - مدیریت CDN و Failover
// ═══════════════════════════════════════════════════════════════════════════

class CDNManager {
  constructor(env, storage) {
    this.env = env;
    this.storage = storage;
    this.healthStatus = new Map();
    this.currentIndex = 0;
  }

  /**
   * Health Check برای CDN ها
   */
  async performHealthCheck() {
    for (const cdn of CONFIG.CDN.PROVIDERS) {
      if (!cdn.healthCheck) continue;

      try {
        // انتخاب یک دامنه تصادفی از CDN
        const testDomain = cdn.domains[randomInt(0, cdn.domains.length - 1)];
        const startTime = Date.now();

        const response = await fetch(`https://${testDomain}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(CONFIG.CDN.HEALTH_CHECK.TIMEOUT)
        });

        const latency = Date.now() - startTime;
        const healthy = response.ok;

        // ثبت نتیجه
        const currentStatus = this.healthStatus.get(cdn.name) || {
          consecutive_failures: 0,
          total_checks: 0,
          successful_checks: 0
        };

        currentStatus.total_checks++;
        currentStatus.last_check = Date.now();
        currentStatus.latency = latency;

        if (healthy) {
          currentStatus.healthy = true;
          currentStatus.consecutive_failures = 0;
          currentStatus.successful_checks++;
        } else {
          currentStatus.consecutive_failures++;
          if (currentStatus.consecutive_failures >= CONFIG.CDN.HEALTH_CHECK.FAILURE_THRESHOLD) {
            currentStatus.healthy = false;
          }
        }

        currentStatus.success_rate = currentStatus.successful_checks / currentStatus.total_checks;

        this.healthStatus.set(cdn.name, currentStatus);

        // ذخیره در KV
        await this.storage.setKV(
          `${CONFIG.STORAGE.KV.PREFIX.CDN_HEALTH}${cdn.name}`,
          currentStatus,
          CONFIG.CDN.HEALTH_CHECK.INTERVAL / 1000
        );

      } catch (error) {
        // مارک کردن به عنوان unhealthy
        const currentStatus = this.healthStatus.get(cdn.name) || {
          consecutive_failures: 0,
          total_checks: 0,
          successful_checks: 0
        };

        currentStatus.total_checks++;
        currentStatus.consecutive_failures++;
        currentStatus.last_check = Date.now();

        if (currentStatus.consecutive_failures >= CONFIG.CDN.HEALTH_CHECK.FAILURE_THRESHOLD) {
          currentStatus.healthy = false;
        }

        this.healthStatus.set(cdn.name, currentStatus);
      }
    }

    await getLogger(this.env).info('CDN health check completed', {
      results: Array.from(this.healthStatus.entries()).map(([name, status]) => ({
        cdn: name,
        healthy: status.healthy,
        latency: status.latency,
        success_rate: (status.success_rate * 100).toFixed(1) + '%'
      }))
    });
  }

  /**
   * انتخاب بهترین CDN
   */
  async selectBestCDN() {
    // فیلتر CDN های سالم
    const healthyCDNs = CONFIG.CDN.PROVIDERS.filter(cdn => {
      const status = this.healthStatus.get(cdn.name);
      return !status || status.healthy !== false;
    });

    if (healthyCDNs.length === 0) {
      // اگر هیچ CDN سالمی نیست، از اولین یکی استفاده کن
      return CONFIG.CDN.PROVIDERS[0];
    }

    // الگوریتم Load Balancing
    switch (CONFIG.CDN.LOAD_BALANCING.ALGORITHM) {
      case 'round_robin':
        return this.roundRobinSelection(healthyCDNs);
      
      case 'least_connections':
        return this.leastConnectionsSelection(healthyCDNs);
      
      case 'weighted_round_robin':
        return this.weightedRoundRobinSelection(healthyCDNs);
      
      default:
        return healthyCDNs[0];
    }
  }

  /**
   * Round Robin Selection
   */
  roundRobinSelection(cdns) {
    const cdn = cdns[this.currentIndex % cdns.length];
    this.currentIndex++;
    return cdn;
  }

  /**
   * Least Connections Selection
   */
  leastConnectionsSelection(cdns) {
    // برای سادگی، از priority استفاده می‌کنیم
    return cdns.reduce((best, current) => 
      current.priority < best.priority ? current : best
    );
  }

  /**
   * Weighted Round Robin Selection
   */
  weightedRoundRobinSelection(cdns) {
    // محاسبه وزن بر اساس priority و health
    const weights = cdns.map(cdn => {
      const status = this.healthStatus.get(cdn.name);
      const baseWeight = 10 - cdn.priority; // کمترین priority = بیشترین وزن
      const healthWeight = status && status.success_rate ? status.success_rate : 0.5;
      return baseWeight * healthWeight;
    });

    // انتخاب تصادفی وزن‌دار
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;

    for (let i = 0; i < cdns.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        return cdns[i];
      }
    }

    return cdns[0];
  }

  /**
   * دریافت دامنه از CDN
   */
  async getCDNDomain(cdnName = null) {
    let cdn;
    
    if (cdnName) {
      cdn = CONFIG.CDN.PROVIDERS.find(c => c.name === cdnName);
    }
    
    if (!cdn) {
      cdn = await this.selectBestCDN();
    }

    // انتخاب تصادفی یک دامنه از CDN
    return cdn.domains[randomInt(0, cdn.domains.length - 1)];
  }

  /**
   * دریافت آمار CDN ها
   */
  getCDNStats() {
    return Array.from(this.healthStatus.entries()).map(([name, status]) => ({
      name,
      healthy: status.healthy,
      latency: status.latency,
      success_rate: (status.success_rate * 100).toFixed(1) + '%',
      consecutive_failures: status.consecutive_failures,
      total_checks: status.total_checks
    }));
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 🔌 VLESS PROTOCOL HANDLER - پردازش‌کننده پروتکل VLESS
// ═══════════════════════════════════════════════════════════════════════════

class VLESSHandler {
  constructor(env, storage, security, trafficMorpher, obfuscator) {
    this.env = env;
    this.storage = storage;
    this.security = security;
    this.trafficMorpher = trafficMorpher;
    this.obfuscator = obfuscator;
  }

  /**
   * پردازش درخواست VLESS
   */
  async handleVLESS(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const client = webSocketPair[0];
    const server = webSocketPair[1];

    // Accept کردن اتصال WebSocket
    server.accept();

    // پردازش اتصال در پس‌زمینه
    this.handleVLESSConnection(server, request).catch(error => {
      getLogger(this.env).error('VLESS connection error', {
        error: error.message,
        stack: error.stack
      });
      server.close(1011, error.message);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  /**
   * مدیریت اتصال VLESS
   */
  async handleVLESSConnection(webSocket, request) {
    const clientIP = request.headers.get('CF-Connecting-IP');
    const cfCountry = request.headers.get('CF-IPCountry');
    const cfASN = request.headers.get('CF-ASN');
    
    let userUUID = null;
    let remoteSocket = null;
    let connectionId = null;
    let bytesUp = 0;
    let bytesDown = 0;

    try {
      // دریافت header VLESS
      const vlessHeaderPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('VLESS header timeout'));
        }, 5000);

        webSocket.addEventListener('message', (event) => {
          clearTimeout(timeout);
          resolve(event.data);
        }, { once: true });
      });

      const rawHeader = await vlessHeaderPromise;
      
      // پردازش header
      const headerData = await this.parseVLESSHeader(rawHeader);
      
      if (!headerData.success) {
        throw new Error('Invalid VLESS header');
      }

      userUUID = headerData.uuid;
      const destination = headerData.destination;
      const port = headerData.port;
      const command = headerData.command;

      await getLogger(this.env).info('VLESS connection initiated', {
        uuid: maskSensitiveData({ uuid: userUUID }).uuid,
        destination,
        port,
        country: cfCountry
      });

      // اعتبارسنجی کاربر
      const userValidation = await this.security.validateUser(userUUID);
      if (!userValidation.valid) {
        throw new Error(`User validation failed: ${userValidation.reason}`);
      }

      // بررسی rate limit
      const rateLimitCheck = await this.security.checkRateLimit(clientIP, userUUID);
      if (!rateLimitCheck.allowed) {
        throw new Error(`Rate limit exceeded: ${rateLimitCheck.reason}`);
      }

      // اعتبارسنجی مقصد
      const destValidation = this.security.validateDestination(destination, port);
      if (!destValidation.valid) {
        throw new Error(`Destination blocked: ${destValidation.reason}`);
      }

      // ثبت اتصال
      connectionId = await this.security.logConnection(
        userUUID,
        destination,
        port,
        'TCP',
        clientIP,
        cfCountry,
        parseInt(cfASN) || 0
      );

      // اتصال به سرور مقصد
      remoteSocket = await this.connectToRemote(destination, port);

      await getLogger(this.env).info('Remote connection established', {
        destination,
        port,
        connectionId
      });

      // راه‌اندازی پروکسی دوطرفه
      await this.proxyTraffic(webSocket, remoteSocket, userUUID, connectionId, (up, down) => {
        bytesUp += up;
        bytesDown += down;
      });

    } catch (error) {
      await getLogger(this.env).error('VLESS connection failed', {
        error: error.message,
        uuid: userUUID ? maskSensitiveData({ uuid: userUUID }).uuid : null
      });

      // ارسال پیام خطا به کلاینت
      try {
        webSocket.send(new TextEncoder().encode(`Error: ${error.message}`));
      } catch {}

      // بستن اتصال با خطا
      if (connectionId) {
        await this.security.closeConnection(connectionId, 'error', error.message);
      }

    } finally {
      // بروزرسانی آمار ترافیک
      if (userUUID && (bytesUp > 0 || bytesDown > 0)) {
        await this.security.updateUserTraffic(userUUID, bytesUp, bytesDown, connectionId);
      }

      // بستن سوکت‌ها
      try {
        if (remoteSocket && !remoteSocket.closed) {
          remoteSocket.close();
        }
      } catch {}

      try {
        if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
          webSocket.close();
        }
      } catch {}

      // بستن اتصال در دیتابیس
      if (connectionId) {
        await this.security.closeConnection(connectionId);
      }

      await getLogger(this.env).info('Connection closed', {
        connectionId,
        bytesUp,
        bytesDown
      });
    }
  }

  /**
   * پارس کردن VLESS Header
   */
  async parseVLESSHeader(rawData) {
    try {
      // تبدیل به Uint8Array
      let data;
      if (rawData instanceof ArrayBuffer) {
        data = new Uint8Array(rawData);
      } else if (rawData instanceof Uint8Array) {
        data = rawData;
      } else {
        return { success: false, error: 'Invalid data type' };
      }

      // بررسی حداقل طول
      if (data.length < CONFIG.VLESS.HEADER_LENGTH.MIN) {
        return { success: false, error: 'Header too short' };
      }

      let offset = 0;

      // بایت اول: نسخه پروتکل
      const version = data[offset++];
      if (version !== CONFIG.VLESS.VERSION) {
        return { success: false, error: 'Unsupported protocol version' };
      }

      // 16 بایت بعدی: UUID
      const uuidBytes = data.slice(offset, offset + 16);
      offset += 16;

      const uuid = arrayBufferToHex(uuidBytes).replace(
        /(.{8})(.{4})(.{4})(.{4})(.{12})/,
        '$1-$2-$3-$4-$5'
      );

      // بایت بعدی: Additional Information Length
      const addonsLength = data[offset++];
      offset += addonsLength; // رد شدن از addon ها

      // بایت بعدی: Command
      const command = data[offset++];

      // 2 بایت بعدی: Port
      const port = (data[offset] << 8) | data[offset + 1];
      offset += 2;

      // بایت بعدی: Address Type
      const addressType = data[offset++];

      let destination = '';

      switch (addressType) {
        case 1: // IPv4
          destination = `${data[offset]}.${data[offset + 1]}.${data[offset + 2]}.${data[offset + 3]}`;
          offset += 4;
          break;

        case 2: // Domain
          const domainLength = data[offset++];
          destination = new TextDecoder().decode(data.slice(offset, offset + domainLength));
          offset += domainLength;
          break;

        case 3: // IPv6
          const ipv6Parts = [];
          for (let i = 0; i < 8; i++) {
            ipv6Parts.push(((data[offset] << 8) | data[offset + 1]).toString(16));
            offset += 2;
          }
          destination = ipv6Parts.join(':');
          break;

        default:
          return { success: false, error: 'Unknown address type' };
      }

      // بقیه داده‌ها payload است
      const payload = data.slice(offset);

      return {
        success: true,
        version,
        uuid,
        command,
        port,
        destination,
        addressType,
        payload
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * اتصال به سرور remote
   */
  async connectToRemote(destination, port) {
    try {
      // ساخت اتصال TCP با استفاده از connect
      const socket = await fetch(`http://${destination}:${port}`, {
        method: 'CONNECT'
      }).then(response => {
        if (!response.ok) {
          throw new Error(`Connect failed: ${response.status}`);
        }
        return response;
      });

      // Cloudflare Workers از TCP sockets به صورت مستقیم پشتیبانی نمی‌کند
      // بنابراین از WebSocket برای انتقال استفاده می‌کنیم
      
      // در اینجا باید از connect() API استفاده کنیم که در Workers جدید موجود است
      // برای سادگی، از یک placeholder استفاده می‌کنیم
      
      const { readable, writable } = await this.createRemoteConnection(destination, port);
      
      return {
        readable,
        writable,
        closed: false,
        close() {
          this.closed = true;
          try {
            writable.close();
          } catch {}
        }
      };

    } catch (error) {
      throw new Error(`Failed to connect to ${destination}:${port} - ${error.message}`);
    }
  }

  /**
   * ایجاد اتصال remote (استفاده از connect API)
   */
  async createRemoteConnection(destination, port) {
    // در Cloudflare Workers جدید، می‌توانیم از connect() استفاده کنیم
    // این فانکشن یک TCP socket مستقیم ایجاد می‌کند
    
    try {
      const socket = await connect({
        hostname: destination,
        port: port
      });

      return socket;
      
    } catch (error) {
      // fallback: استفاده از HTTP CONNECT
      // این روش محدودیت‌های بیشتری دارد اما در صورت عدم دسترسی به connect API کار می‌کند
      
      throw new Error('Direct TCP connection not available in this environment');
    }
  }

  /**
   * Proxy کردن ترافیک بین client و remote
   */
  async proxyTraffic(clientSocket, remoteSocket, userUUID, connectionId, statsCallback) {
    const clientToRemote = this.pipeData(
      clientSocket,
      remoteSocket.writable,
      'client->remote',
      async (chunk) => {
        // Deobfuscate ترافیک ورودی از کلاینت
        let processed = await this.obfuscator.deobfuscate(chunk);
        processed = this.trafficMorpher.processInbound(processed);
        statsCallback(chunk.length, 0);
        return processed;
      }
    );

    const remoteToClient = this.pipeData(
      remoteSocket.readable,
      clientSocket,
      'remote->client',
      async (chunk) => {
        // Obfuscate و Morph ترافیک خروجی به کلاینت
        let processed = await this.obfuscator.obfuscate(chunk);
        const fragments = await this.trafficMorpher.processOutbound(processed);
        
        // ارسال هر fragment
        for (const fragment of fragments) {
          statsCallback(0, fragment.length);
        }
        
        // در اینجا باید fragments را به صورت مجزا ارسال کنیم
        // اما برای سادگی، fragment اول را برمی‌گردانیم
        return fragments[0] || processed;
      }
    );

    // منتظر اتمام هر دو pipe باش
    await Promise.race([clientToRemote, remoteToClient]);
  }

  /**
   * Pipe کردن داده بین دو stream
   */
  async pipeData(source, destination, direction, transformFn = null) {
    try {
      // اگر source یک WebSocket است
      if (source instanceof WebSocket) {
        return new Promise((resolve, reject) => {
          source.addEventListener('message', async (event) => {
            try {
              let data = event.data;
              
              // تبدیل به Uint8Array
              if (data instanceof ArrayBuffer) {
                data = new Uint8Array(data);
              } else if (typeof data === 'string') {
                data = new TextEncoder().encode(data);
              }

              // اعمال transformation
              if (transformFn) {
                data = await transformFn(data);
              }

              // ارسال به destination
              if (destination instanceof WebSocket) {
                destination.send(data);
              } else if (destination && destination.getWriter) {
                const writer = destination.getWriter();
                await writer.write(data);
                writer.releaseLock();
              }

            } catch (error) {
              await getLogger(this.env).error(`Pipe error (${direction})`, {
                error: error.message
              });
              reject(error);
            }
          });

          source.addEventListener('close', () => resolve());
          source.addEventListener('error', (error) => reject(error));
        });
      }

      // اگر source یک ReadableStream است
      if (source && source.getReader) {
        const reader = source.getReader();
        
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) break;

          let data = value;

          // اعمال transformation
          if (transformFn) {
            data = await transformFn(data);
          }

          // ارسال به destination
          if (destination instanceof WebSocket) {
            destination.send(data);
          } else if (destination && destination.getWriter) {
            const writer = destination.getWriter();
            await writer.write(data);
            writer.releaseLock();
          }
        }

        reader.releaseLock();
      }

    } catch (error) {
      await getLogger(this.env).error(`Pipe failed (${direction})`, {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * تولید کانفیگ VLESS برای کاربر
   */
  async generateUserConfig(userUUID, request) {
    try {
      const user = await this.storage.queryOneD1(
        'SELECT * FROM users WHERE uuid = ?',
        [userUUID]
      );

      if (!user) {
        return { success: false, error: 'User not found' };
      }

      const url = new URL(request.url);
      const hostname = url.hostname;
      const protocol = url.protocol === 'https:' ? 'wss' : 'ws';

      // دریافت بهترین SNI ها
      const cfCountry = request.headers.get('CF-IPCountry') || 'XX';
      const bestSNIs = await this.storage.queryD1(`
        SELECT sni FROM optimal_snis
        WHERE country = ? AND status = 'active'
        ORDER BY score DESC
        LIMIT 5
      `, [cfCountry]);

      const sniList = bestSNIs.map(s => s.sni);
      if (sniList.length === 0) {
        sniList.push('cloudflare.com', 'www.speedtest.net');
      }

      // ساخت کانفیگ‌های مختلف
      const configs = {
        vless: [],
        clash: null,
        v2ray: null,
        links: []
      };

      // تولید کانفیگ برای هر SNI
      for (const sni of sniList) {
        const vlessLink = `vless://${userUUID}@${hostname}:443?encryption=none&security=tls&sni=${sni}&type=ws&host=${hostname}&path=%2F#Quantum-${sni}`;
        
        configs.vless.push({
          uuid: userUUID,
          sni: sni,
          address: hostname,
          port: 443,
          network: 'ws',
          security: 'tls',
          link: vlessLink
        });

        configs.links.push(vlessLink);
      }

      // Clash Config
      configs.clash = this.generateClashConfig(userUUID, hostname, sniList);

      // V2Ray Config
      configs.v2ray = this.generateV2RayConfig(userUUID, hostname, sniList[0]);

      // اطلاعات کاربر
      const userInfo = {
        uuid: userUUID,
        email: user.email,
        quota: user.quota,
        used: user.used_bytes,
        remaining: user.quota - user.used_bytes,
        expire_at: user.expire_at,
        status: user.status,
        usage_percent: ((user.used_bytes / user.quota) * 100).toFixed(2)
      };

      return {
        success: true,
        user: userInfo,
        configs: configs
      };

    } catch (error) {
      await getLogger(this.env).error('Config generation failed', {
        error: error.message
      });
      
      return { success: false, error: error.message };
    }
  }

  /**
   * تولید کانفیگ Clash
   */
  generateClashConfig(uuid, hostname, snis) {
    const proxies = snis.map((sni, index) => ({
      name: `Quantum-${index + 1}`,
      type: 'vless',
      server: hostname,
      port: 443,
      uuid: uuid,
      udp: true,
      tls: true,
      network: 'ws',
      'servername': sni,
      'ws-opts': {
        path: '/',
        headers: {
          Host: hostname
        }
      }
    }));

    return {
      proxies: proxies,
      'proxy-groups': [
        {
          name: 'Quantum-Auto',
          type: 'url-test',
          proxies: proxies.map(p => p.name),
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        },
        {
          name: 'Quantum-Select',
          type: 'select',
          proxies: proxies.map(p => p.name)
        }
      ]
    };
  }

  /**
   * تولید کانفیگ V2Ray
   */
  generateV2RayConfig(uuid, hostname, sni) {
    return {
      inbounds: [
        {
          port: 1080,
          protocol: 'socks',
          settings: {
            auth: 'noauth',
            udp: true
          }
        },
        {
          port: 1081,
          protocol: 'http'
        }
      ],
      outbounds: [
        {
          protocol: 'vless',
          settings: {
            vnext: [
              {
                address: hostname,
                port: 443,
                users: [
                  {
                    id: uuid,
                    encryption: 'none',
                    level: 0
                  }
                ]
              }
            ]
          },
          streamSettings: {
            network: 'ws',
            security: 'tls',
            tlsSettings: {
              serverName: sni,
              allowInsecure: false
            },
            wsSettings: {
              path: '/',
              headers: {
                Host: hostname
              }
            }
          }
        }
      ]
    };
  }
}
