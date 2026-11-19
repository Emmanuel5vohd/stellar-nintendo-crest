/**
 * Batched writes for one ledger (#31).
 *
 * Instead of committing each event alone, the events of a ledger are written together: one
 * multi-row upsert per table, inside one transaction. If any write fails, the whole ledger
 * rolls back, so a ledger is never half applied.
 */

export interface LedgerWrite {
  table: string;
  key: string;
  row: Record<string, unknown>;
}

export interface BatchStoreTx {
  /** Multi-row `INSERT ... ON CONFLICT DO UPDATE` for one table. */
  upsertMany(table: string, rows: Record<string, unknown>[]): Promise<void>;
}

export interface BatchStore {
  transaction<T>(work: (tx: BatchStoreTx) => Promise<T>): Promise<T>;
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
 * Writes every event of one ledger in a single transaction. Rows are grouped per table, so each
 * table gets one multi-row statement instead of one statement per event.
 *
 * Partitioned tables are written through their parent table, so partitioning stays transparent to
 * callers and no query changes are required.
 */
export async function flushLedgerBatch(store: BatchStore, writes: LedgerWrite[]): Promise<void> {
  if (writes.length === 0) return;

  const byTable = new Map<string, Record<string, unknown>[]>();
  for (const w of writes) {
    const rows = byTable.get(w.table) ?? [];
    rows.push(w.row);
    byTable.set(w.table, rows);
  }

  await store.transaction(async (tx) => {
    for (const [table, rows] of byTable) {
      await tx.upsertMany(table, rows);
    }
  });
}
