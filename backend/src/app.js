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

// ---------------------------------------------------------------------------
// Admin RBAC + audit log (issue #244)
// ---------------------------------------------------------------------------

const ADMIN_ROLES = Object.freeze({
  SUPER_ADMIN: 'SuperAdmin',
  MARKET_CREATOR: 'MarketCreator',
  COUNCIL_MEMBER: 'CouncilMember',
});

// Role assignments are configured out-of-band via env, e.g.
// ADMIN_ROLE_MAP='{"GABC...":"SuperAdmin","GDEF...":"MarketCreator"}'
function loadRoleMap() {
  const raw = process.env.ADMIN_ROLE_MAP;
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[admin] Failed to parse ADMIN_ROLE_MAP', err);
    return {};
  }
}

const adminRoleMap = loadRoleMap();

// In-memory audit log. Each entry records the administrative action, the
// caller identity, and a timestamp. Persist to durable storage in production.
const adminAuditLog = [];

function recordAudit({ action, caller, role, target, outcome, details }) {
  const entry = {
    id: crypto.randomUUID(),
    action,
    caller: caller || null,
    role: role || null,
    target: target || null,
    outcome: outcome || 'success',
    details: details || null,
    timestamp: new Date().toISOString(),
  };
  adminAuditLog.push(entry);
  return entry;
}

// Verify the admin wallet signature. The caller supplies the wallet address in
// `x-admin-wallet` and a signature over the canonical request payload in
// `x-admin-signature`. Signature verification is delegated to a pluggable
// verifier so the concrete crypto scheme can be wired in without changing the
// middleware contract.
function verifyAdminSignature(req) {
  const wallet = req.get('x-admin-wallet');
  const signature = req.get('x-admin-signature');
  if (!wallet || !signature) {
    return { ok: false, code: 'MISSING_ADMIN_CREDENTIALS' };
  }

  const verifier = app.get('adminSignatureVerifier');
  if (typeof verifier !== 'function') {
    return { ok: false, code: 'ADMIN_VERIFIER_UNAVAILABLE' };
  }

  const message = `${req.method} ${req.originalUrl}`;
  let valid = false;
  try {
    valid = verifier({ wallet, signature, message }) === true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[admin] Signature verifier threw', err);
    valid = false;
  }

  if (!valid) {
    return { ok: false, code: 'INVALID_ADMIN_SIGNATURE' };
  }
  return { ok: true, wallet };
}

// RBAC middleware factory: authenticates the wallet signature, resolves the
// caller's role, and enforces that the role is in the allowed set.
function requireAdminRole(allowedRoles) {
  return function adminRbac(req, res, next) {
    const auth = verifyAdminSignature(req);
    if (!auth.ok) {
      recordAudit({
        action: `${req.method} ${req.originalUrl}`,
        caller: req.get('x-admin-wallet') || null,
        outcome: 'denied',
        details: { reason: auth.code },
      });
      return sendError(res, 401, auth.code, 'Admin authentication failed');
    }

    const role = adminRoleMap[auth.wallet];
    if (!role) {
      recordAudit({
        action: `${req.method} ${req.originalUrl}`,
        caller: auth.wallet,
        outcome: 'denied',
        details: { reason: 'NO_ROLE_ASSIGNED' },
      });
      return sendError(res, 403, 'FORBIDDEN', 'Caller has no administrative role');
    }

    if (!allowedRoles.includes(role)) {
      recordAudit({
        action: `${req.method} ${req.originalUrl}`,
        caller: auth.wallet,
        role,
        outcome: 'denied',
        details: { reason: 'INSUFFICIENT_ROLE', allowedRoles },
      });
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient role for this action', {
        required: allowedRoles,
      });
    }

    req.admin = { wallet: auth.wallet, role };
    return next();
  };
}

// Manual market seeding (MarketCreator / SuperAdmin).
app.post(
  '/api/admin/markets/seed',
  requireAdminRole([ADMIN_ROLES.SUPER_ADMIN, ADMIN_ROLES.MARKET_CREATOR]),
  (req, res) => {
    const { marketId, question, resolutionTime } = req.body || {};
    if (!marketId || !question) {
      recordAudit({
        action: 'market.seed',
        caller: req.admin.wallet,
        role: req.admin.role,
        target: marketId || null,
        outcome: 'rejected',
        details: { reason: 'VALIDATION_FAILED' },
      });
      return sendError(res, 400, 'VALIDATION_FAILED', 'marketId and question are required');
    }

    const entry = recordAudit({
      action: 'market.seed',
      caller: req.admin.wallet,
      role: req.admin.role,
      target: marketId,
      details: { question, resolutionTime: resolutionTime || null },
    });

    return res.status(201).json({
      success: true,
      data: { marketId, seededBy: req.admin.wallet, auditId: entry.id },
    });
  }
);

// Resolution override (SuperAdmin / CouncilMember).
app.post(
  '/api/admin/markets/:marketId/resolve',
  requireAdminRole([ADMIN_ROLES.SUPER_ADMIN, ADMIN_ROLES.COUNCIL_MEMBER]),
  (req, res) => {
    const { marketId } = req.params;
    const { outcome, reason } = req.body || {};
    if (!outcome) {
      recordAudit({
        action: 'market.resolve.override',
        caller: req.admin.wallet,
        role: req.admin.role,
        target: marketId,
        outcome: 'rejected',
        details: { reason: 'VALIDATION_FAILED' },
      });
      return sendError(res, 400, 'VALIDATION_FAILED', 'outcome is required');
    }

    const entry = recordAudit({
      action: 'market.resolve.override',
      caller: req.admin.wallet,
      role: req.admin.role,
      target: marketId,
      details: { outcome, reason: reason || null },
    });

    return res.status(200).json({
      success: true,
      data: { marketId, outcome, overriddenBy: req.admin.wallet, auditId: entry.id },
    });
  }
);

// Audit log inspection (SuperAdmin only).
app.get(
  '/api/admin/audit-log',
  requireAdminRole([ADMIN_ROLES.SUPER_ADMIN]),
  (req, res) => {
    return res.status(200).json({ success: true, data: adminAuditLog });
  }
);

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
