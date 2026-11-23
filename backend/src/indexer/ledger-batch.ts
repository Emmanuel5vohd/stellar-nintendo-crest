import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';

/**
 * PostgreSQL connection pool for the indexer runner.
 *
 * Tuned for high event burst loads (hundreds of concurrent bet events):
 * - min 5 warm connections to absorb sudden bursts without handshake latency
 * - max 30 connections to bound server-side resource usage
 * - 5000ms statement timeout so runaway queries fail fast instead of
 *   holding a connection and starving the pool
 * - 10000ms idle timeout to reclaim connections after bursts subside
 */
export const pool = new Pool({
  min: 5,
  max: 30,
  idleTimeoutMillis: 10000,
  statement_timeout: 5000,
  query_timeout: 5000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', { error: err.message });
});

const MAX_POOL_RETRIES = 3;
const POOL_RETRY_BASE_DELAY_MS = 100;

function isPoolSaturationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('too many clients already') ||
    message.includes('remaining connection slots are reserved') ||
    message.includes('Connection terminated')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire a client from the pool, retrying with exponential backoff when the
 * pool is transiently saturated. Throws the last error if all retries fail.
 */
async function acquireClient(): Promise<PoolClient> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_POOL_RETRIES; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      lastError = err;
      if (!isPoolSaturationError(err) || attempt === MAX_POOL_RETRIES) {
        break;
      }
      const backoff = POOL_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn('PostgreSQL pool saturated, retrying connection', {
        attempt: attempt + 1,
        backoffMs: backoff,
      });
      await delay(backoff);
    }
  }
  throw lastError;
}
export interface BatchStoreTx {
  /** Multi-row `INSERT ... ON CONFLICT DO UPDATE` for one table. */
  upsertMany(table: string, rows: Record<string, unknown>[]): Promise<void>;
}

export interface LedgerBatchEntry {
  eventId: string;
  tokenAddress: string;
  amount: string;
  ledger: number;
  timestamp: Date;
}

/**
 * Tables that are declaratively partitioned by a timestamp column (#252). Writes to these tables
 * must target the parent table so PostgreSQL routes each row to its quarterly partition; the
 * application never names a partition directly.
 */
export const PARTITIONED_TABLES: Readonly<Record<string, string>> = {
  bets: 'placed_at',
};

/**
 * Tables whose rows are locked during a batch write. Concurrent transactions that touch the same
 * rows must acquire those locks in the same order, otherwise PostgreSQL aborts one of them with a
 * deadlock (#254). Rows of these tables are therefore sorted by their lock key before writing.
 */
export const LOCK_ORDER_COLUMNS: Readonly<Record<string, string>> = {
  leaderboard: 'user_address',
};

/**
 * Returns the quarterly partition name for a timestamp, e.g. `bets_2026_q1`. Mirrors the
 * `bets_<year>_q<quarter>` naming used by the partition management routine so the indexer and the
 * provisioning routine agree on boundaries.
 */
export function quarterlyPartitionName(table: string, at: Date): string {
  const year = at.getUTCFullYear();
  const quarter = Math.floor(at.getUTCMonth() / 3) + 1;
  return `${table}_${year}_q${quarter}`;
}

/**
 * Sorts rows of a lock-ordered table by their lock key (ascending) so every transaction locks the
 * shared rows in the same deterministic order. This is what prevents the deadlocks described in
 * #254 when concurrent bet settlements update overlapping leaderboard rows.
 */
function orderForLocking(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const column = LOCK_ORDER_COLUMNS[table];
  if (!column) return rows;
  return [...rows].sort((a, b) => {
    const left = String(a[column] ?? '');
    const right = String(b[column] ?? '');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Writes every event of one ledger in a single transaction. Rows are grouped per table, so each
 * table gets one multi-row statement instead of one statement per event.
 *
 * Partitioned tables are written through their parent table, so partitioning stays transparent to
 * callers and no query changes are required. Lock-ordered tables are sorted by their lock key so
 * concurrent transactions acquire row locks deterministically and cannot deadlock (#254).
 */
export async function persistLedgerBatch(entries: LedgerBatchEntry[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  await store.transaction(async (tx) => {
    for (const [table, rows] of byTable) {
      await tx.upsertMany(table, orderForLocking(table, rows));
    }
  });
}

/**
 * One itemized tax-reporting record (#247). Mirrors the columns required by the export:
 * date, tx hash, type, asset, amount, fee, and net payout, plus a USD historical estimate.
 */
export interface TaxLedgerRecord {
  date: string;
  txHash: string;
  type: string;
  asset: string;
  amount: string;
  fee: string;
  netPayout: string;
  usdValue: string;
}

const CSV_COLUMNS: (keyof TaxLedgerRecord)[] = [
  'date',
  'txHash',
  'type',
  'asset',
  'amount',
  'fee',
  'netPayout',
  'usdValue',
];

/** Escapes a single CSV field per RFC 4180 (quotes doubled, wrapped when needed). */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Streams itemized tax records as CSV or JSON without buffering the full history in memory.
 * Records are pulled lazily from `source` and written one at a time to `sink`, so arbitrarily
 * large histories can be exported with constant memory.
 */
export async function streamTaxExport(
  source: AsyncIterable<TaxLedgerRecord>,
  sink: { write(chunk: string): void | Promise<void> },
  format: 'csv' | 'json',
): Promise<void> {
  if (format === 'csv') {
    await sink.write(CSV_COLUMNS.join(',') + '\n');
    for await (const record of source) {
      const line = CSV_COLUMNS.map((col) => csvField(record[col])).join(',');
      await sink.write(line + '\n');
    }
    return;
  }

  await sink.write('[');
  let first = true;
  for await (const record of source) {
    await sink.write((first ? '' : ',') + JSON.stringify(record));
    first = false;
  }
  await sink.write(']');
}
