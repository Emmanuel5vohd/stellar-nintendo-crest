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
        connectSrc: ["'self'", ...allowedOrigins],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
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
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json());

function sendError(res, statusCode, code, message, details) {
  const error = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return res.status(statusCode).json({ success: false, error });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 404 handler: any unmatched route returns the uniform error envelope.
app.use((req, res) => {
  sendError(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`);
});

// Centralized error handler: maps domain/validation/unknown errors to the
// uniform envelope `{ success: false, error: { code, message, details } }`.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const statusCode = Number(err && (err.statusCode || err.status)) || 500;

  if (statusCode >= 400 && statusCode < 500) {
    const code = (err && err.code) || 'BAD_REQUEST';
    const message = (err && err.message) || 'Request could not be processed';
    const details = err && err.details;
    return sendError(res, statusCode, code, message, details);
  }

  const trackingId = crypto.randomUUID();
  // eslint-disable-next-line no-console
  console.error(`[error] trackingId=${trackingId}`, err);
  return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred', {
    trackingId,
  });
});

module.exports = app;
