const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');

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

// ---------------------------------------------------------------------------
// Webhook notification service (issue #240)
// ---------------------------------------------------------------------------

const WEBHOOK_MAX_ATTEMPTS = 5;
const WEBHOOK_BASE_BACKOFF_MS = 1000;
const WEBHOOK_MAX_BACKOFF_MS = 60000;
const WEBHOOK_TIMEOUT_MS = 10000;

// In-memory registry keyed by user id. Replace with persistent storage in
// production; the delivery/signing logic below is storage-agnostic.
const webhookRegistry = new Map();

function isValidWebhookUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (err) {
    return false;
  }
}

function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function signWebhookPayload(secret, timestamp, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

function computeBackoffMs(attempt) {
  const delay = WEBHOOK_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  return Math.min(delay, WEBHOOK_MAX_BACKOFF_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverWebhookOnce(registration, event) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(event);
  const signature = signWebhookPayload(registration.secret, timestamp, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(registration.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': String(timestamp),
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Event': event.type,
      },
      body,
      signal: controller.signal,
    });
    return response.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverWebhookWithRetry(registration, event) {
  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await deliverWebhookOnce(registration, event);
    if (ok) return true;
    if (attempt < WEBHOOK_MAX_ATTEMPTS) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(computeBackoffMs(attempt));
    }
  }
  return false;
}

function enqueueNotification(userId, event) {
  const registration = webhookRegistry.get(userId);
  if (!registration || !registration.enabled) return;
  // Fire-and-forget worker; retries handled internally with backoff.
  deliverWebhookWithRetry(registration, event).catch(() => {});
}

function notifyBetOutcome(userId, payload) {
  enqueueNotification(userId, {
    type: 'bet.outcome',
    createdAt: new Date().toISOString(),
    data: payload,
  });
}

function notifyReferralEarning(userId, payload) {
  enqueueNotification(userId, {
    type: 'referral.earning',
    createdAt: new Date().toISOString(),
    data: payload,
  });
}

// Registration endpoints in user settings.
app.get('/api/users/:userId/webhook', (req, res) => {
  const registration = webhookRegistry.get(req.params.userId);
  if (!registration) {
    return res.status(404).json({ error: 'No webhook registered' });
  }
  return res.json({
    url: registration.url,
    enabled: registration.enabled,
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
  });
});

app.put('/api/users/:userId/webhook', (req, res) => {
  const { url, enabled } = req.body || {};
  if (!isValidWebhookUrl(url)) {
    return res.status(400).json({ error: 'A valid http(s) webhook URL is required' });
  }

  const existing = webhookRegistry.get(req.params.userId);
  const now = new Date().toISOString();
  const registration = {
    url: url.trim(),
    secret: existing ? existing.secret : generateWebhookSecret(),
    enabled: enabled === undefined ? true : Boolean(enabled),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  webhookRegistry.set(req.params.userId, registration);

  return res.json({
    url: registration.url,
    enabled: registration.enabled,
    // Secret is returned so the user can verify signatures; only on write.
    secret: registration.secret,
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
  });
});

app.delete('/api/users/:userId/webhook', (req, res) => {
  const removed = webhookRegistry.delete(req.params.userId);
  if (!removed) {
    return res.status(404).json({ error: 'No webhook registered' });
  }
  return res.status(204).end();
});

app.notifications = {
  notifyBetOutcome,
  notifyReferralEarning,
  signWebhookPayload,
  computeBackoffMs,
  WEBHOOK_MAX_ATTEMPTS,
};

module.exports = app;
