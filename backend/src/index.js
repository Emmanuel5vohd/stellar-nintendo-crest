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

// ---------------------------------------------------------------------------
// Admin RBAC + audit log
// ---------------------------------------------------------------------------

const ADMIN_ROLES = Object.freeze({
  SUPER_ADMIN: 'SuperAdmin',
  MARKET_CREATOR: 'MarketCreator',
  COUNCIL_MEMBER: 'CouncilMember',
});

// Role assignments are sourced from configuration (comma-separated
// `role:wallet` pairs) so operators can manage admins without code changes.
function loadRoleAssignments() {
  const assignments = new Map();
  const raw = process.env.ADMIN_ROLE_ASSIGNMENTS || '';
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const [role, wallet] = entry.split(':').map((part) => (part || '').trim());
      if (!role || !wallet || !Object.values(ADMIN_ROLES).includes(role)) {
        return;
      }
      const normalized = wallet.toLowerCase();
      const roles = assignments.get(normalized) || new Set();
      roles.add(role);
      assignments.set(normalized, roles);
    });
  return assignments;
}

const roleAssignments = loadRoleAssignments();

// In-memory audit log. Each entry records the administrative action, the
// caller identity, and a timestamp. Swap for a persistent table when a DB
// layer is available; the shape is intentionally table-friendly.
const auditLog = [];

function recordAudit({ action, caller, roles, target, outcome, details }) {
  const entry = {
    id: crypto.randomUUID(),
    action,
    caller: caller || null,
    roles: roles || [],
    target: target || null,
    outcome: outcome || 'success',
    details: details || null,
    timestamp: new Date().toISOString(),
  };
  auditLog.push(entry);
  return entry;
}

function getRolesForWallet(wallet) {
  if (!wallet) {
    return [];
  }
  const roles = roleAssignments.get(String(wallet).toLowerCase());
  return roles ? Array.from(roles) : [];
}

// Verifies the admin wallet signature. The caller supplies `x-admin-wallet`,
// `x-admin-timestamp`, and `x-admin-signature` (hex HMAC-SHA256 over
// `${timestamp}.${method}.${path}` keyed by ADMIN_SIGNATURE_SECRET). This
// mirrors the oracle-auth signature pattern used elsewhere in the backend.
function verifyAdminSignature(req) {
  const wallet = req.get('x-admin-wallet');
  const timestamp = req.get('x-admin-timestamp');
  const signature = req.get('x-admin-signature');
  const secret = process.env.ADMIN_SIGNATURE_SECRET;

  if (!wallet || !timestamp || !signature) {
    return { ok: false, code: 'ADMIN_AUTH_MISSING', message: 'Admin authentication headers are required' };
  }
  if (!secret) {
    return { ok: false, code: 'ADMIN_AUTH_UNCONFIGURED', message: 'Admin signature verification is not configured' };
  }

  const ts = Number(timestamp);
  const maxSkewMs = Number(process.env.ADMIN_SIGNATURE_MAX_SKEW_MS) || 5 * 60 * 1000;
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > maxSkewMs) {
    return { ok: false, code: 'ADMIN_AUTH_EXPIRED', message: 'Admin signature timestamp is invalid or expired' };
  }

  const payload = `${timestamp}.${req.method}.${req.baseUrl}${req.path}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const provided = String(signature).toLowerCase();
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');

  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  ) {
    return { ok: false, code: 'ADMIN_AUTH_INVALID', message: 'Admin signature verification failed' };
  }

  return { ok: true, wallet: String(wallet).toLowerCase() };
}

// RBAC middleware factory: authenticates the admin wallet, resolves its roles,
// and enforces that at least one of the allowed roles is present.
function requireAdminRole(allowedRoles) {
  return function adminRbac(req, res, next) {
    const auth = verifyAdminSignature(req);
    if (!auth.ok) {
      recordAudit({
        action: `${req.method} ${req.baseUrl}${req.path}`,
        caller: req.get('x-admin-wallet') || null,
        outcome: 'denied',
        details: { reason: auth.code },
      });
      return sendError(res, 401, auth.code, auth.message);
    }

    const roles = getRolesForWallet(auth.wallet);
    if (roles.length === 0) {
      recordAudit({
        action: `${req.method} ${req.baseUrl}${req.path}`,
        caller: auth.wallet,
        outcome: 'denied',
        details: { reason: 'ADMIN_ROLE_MISSING' },
      });
      return sendError(res, 403, 'ADMIN_ROLE_MISSING', 'Caller has no administrative role');
    }

    const permitted = roles.some((role) => allowedRoles.includes(role));
    if (!permitted) {
      recordAudit({
        action: `${req.method} ${req.baseUrl}${req.path}`,
        caller: auth.wallet,
        roles,
        outcome: 'denied',
        details: { reason: 'ADMIN_ROLE_FORBIDDEN', allowedRoles },
      });
      return sendError(res, 403, 'ADMIN_ROLE_FORBIDDEN', 'Caller role is not permitted for this action', {
        allowedRoles,
      });
    }

    req.admin = { wallet: auth.wallet, roles };
    return next();
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Admin: manual market seeding (MarketCreator or SuperAdmin).
app.post(
  '/api/admin/markets/seed',
  requireAdminRole([ADMIN_ROLES.SUPER_ADMIN, ADMIN_ROLES.MARKET_CREATOR]),
  (req, res) => {
    const { marketId, question, resolutionDate } = req.body || {};
    if (!marketId || !question) {
      recordAudit({
        action: 'market.seed',
        caller: req.admin.wallet,
        roles: req.admin.roles,
        outcome: 'rejected',
        details: { reason: 'VALIDATION_FAILED' },
      });
      return sendError(res, 400, 'VALIDATION_FAILED', 'marketId and question are required');
    }

    const entry = recordAudit({
      action: 'market.seed',
      caller: req.admin.wallet,
      roles: req.admin.roles,
      target: marketId,
      details: { question, resolutionDate: resolutionDate || null },
    });

    return res.status(201).json({
      success: true,
      data: { marketId, question, resolutionDate: resolutionDate || null, auditId: entry.id },
    });
  }
);

// Admin: resolution override (SuperAdmin or CouncilMember).
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
        roles: req.admin.roles,
        target: marketId,
        outcome: 'rejected',
        details: { reason: 'VALIDATION_FAILED' },
      });
      return sendError(res, 400, 'VALIDATION_FAILED', 'outcome is required');
    }

    const entry = recordAudit({
      action: 'market.resolve.override',
      caller: req.admin.wallet,
      roles: req.admin.roles,
      target: marketId,
      details: { outcome, reason: reason || null },
    });

    return res.json({
      success: true,
      data: { marketId, outcome, reason: reason || null, auditId: entry.id },
    });
  }
);

// Admin: inspect the audit log (SuperAdmin only).
app.get(
  '/api/admin/audit-log',
  requireAdminRole([ADMIN_ROLES.SUPER_ADMIN]),
  (req, res) => {
    recordAudit({
      action: 'audit.read',
      caller: req.admin.wallet,
      roles: req.admin.roles,
    });
    return res.json({ success: true, data: { entries: auditLog.slice() } });
  }
);

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
