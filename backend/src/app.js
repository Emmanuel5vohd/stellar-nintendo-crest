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

// Uniform error envelope: { success: false, error: { code, message, details } }
function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return res.status(status).json({ success: false, error });
}

// 404 handler: unmatched routes conform to the uniform envelope.
app.use((req, res) => {
  return sendError(res, 404, 'NOT_FOUND', 'Resource not found', { path: req.originalUrl });
});

// Centralized error handler mapping domain/validation/unknown errors to the envelope.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  // Body parser / validation errors carry a 4xx status and a type.
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    const status = err.status || err.statusCode || 400;
    const code = err.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON';
    return sendError(res, status, code, err.message || 'Invalid request body');
  }

  const status = err && (err.status || err.statusCode);
  if (status && status >= 400 && status < 500) {
    const code = (err && err.code) || 'BAD_REQUEST';
    const details = err && err.details;
    return sendError(res, status, code, (err && err.message) || 'Bad request', details);
  }

  // Unknown / server errors: log with a tracking ID for correlation.
  const trackingId = crypto.randomUUID();
  // eslint-disable-next-line no-console
  console.error(`[error] trackingId=${trackingId}`, err);
  return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'Internal server error', { trackingId });
});

module.exports = app;
