const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { createClient } = require('redis');

const app = express();

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://app.example.com,https://www.example.com')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://trusted-cdn.example.com'],
        connectSrc: ["'self'", 'https://api.example.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
  })
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400,
  })
);

app.use(express.json());

// --- Tiered rate limiting (issue #235) ---
// Shared Redis-backed store so limits are enforced across all instances.
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});
redisClient.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[rate-limit] redis error', err.message);
});
redisClient.connect().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[rate-limit] redis connect failed', err.message);
});

const PUBLIC_LIMIT = Number(process.env.RATE_LIMIT_PUBLIC || 60);
const AUTH_LIMIT = Number(process.env.RATE_LIMIT_AUTH || 300);
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);

const whitelistedIps = (process.env.RATE_LIMIT_WHITELIST_IPS || '')
  .split(',')
  .map((ip) => ip.trim())
  .filter(Boolean);

const trustedIndexerTokens = (process.env.RATE_LIMIT_INDEXER_TOKENS || '')
  .split(',')
  .map((token) => token.trim())
  .filter(Boolean);

function getClientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isWhitelisted(req) {
  if (whitelistedIps.includes(getClientIp(req))) {
    return true;
  }
  const indexerToken = req.get('x-indexer-token');
  if (indexerToken && trustedIndexerTokens.includes(indexerToken)) {
    return true;
  }
  return false;
}

function getWalletAddress(req) {
  // Authenticated requests are keyed by wallet address when available.
  return req.user && (req.user.walletAddress || req.user.wallet) ? req.user.walletAddress || req.user.wallet : null;
}

function buildLimiter(max) {
  return rateLimit({
    windowMs: WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const wallet = getWalletAddress(req);
      return wallet ? `wallet:${wallet}` : `ip:${getClientIp(req)}`;
    },
    skip: (req) => isWhitelisted(req),
    store: new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix: 'rl:',
    }),
    handler: (req, res) => {
      const resetTime = req.rateLimit && req.rateLimit.resetTime;
      const retryAfter = resetTime
        ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(WINDOW_MS / 1000);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please retry later.',
        retryAfter,
      });
    },
  });
}

const publicLimiter = buildLimiter(PUBLIC_LIMIT);
const authLimiter = buildLimiter(AUTH_LIMIT);

app.use((req, res, next) => {
  const limiter = getWalletAddress(req) ? authLimiter : publicLimiter;
  return limiter(req, res, next);
});

module.exports = app;
