const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

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

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function encodeCursor(createdAt, id) {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (!parsed || parsed.createdAt === undefined || parsed.id === undefined) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch (err) {
    return null;
  }
}

function parseLimit(rawLimit) {
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

function parseOffset(rawOffset) {
  const parsed = Number.parseInt(rawOffset, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

// Keyset pagination: fetch limit + 1 rows to determine has_more without a count query.
function paginate(rows, limit) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
  return { data, next_cursor: nextCursor, has_more: hasMore };
}

// In-memory stores stand in for the database tables; the query helpers below
// mirror the keyset WHERE clauses that would be issued against Postgres.
const markets = [];
const bets = [];

function queryMarkets({ cursor, limit, offset }) {
  let rows = markets.slice().sort((a, b) => {
    if (a.created_at === b.created_at) return b.id - a.id;
    return a.created_at < b.created_at ? 1 : -1;
  });
  if (cursor) {
    rows = rows.filter(
      (row) => row.created_at < cursor.createdAt || (row.created_at === cursor.createdAt && row.id < cursor.id)
    );
  } else if (offset > 0) {
    rows = rows.slice(offset);
  }
  return rows.slice(0, limit + 1);
}

function queryBets({ cursor, limit, offset }) {
  let rows = bets.slice().sort((a, b) => {
    if (a.created_at === b.created_at) return b.id - a.id;
    return a.created_at < b.created_at ? 1 : -1;
  });
  if (cursor) {
    rows = rows.filter(
      (row) => row.created_at < cursor.createdAt || (row.created_at === cursor.createdAt && row.id < cursor.id)
    );
  } else if (offset > 0) {
    rows = rows.slice(offset);
  }
  return rows.slice(0, limit + 1);
}

function listHandler(queryFn) {
  return (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);
    const offset = cursor ? 0 : parseOffset(req.query.offset);
    const rows = queryFn({ cursor, limit, offset });
    res.json(paginate(rows, limit));
  };
}

app.get('/api/markets', listHandler(queryMarkets));
app.get('/api/bets', listHandler(queryBets));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = app;
