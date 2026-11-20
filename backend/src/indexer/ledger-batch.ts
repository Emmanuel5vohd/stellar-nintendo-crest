/**
 * Batched writes for one ledger (#31).
 *
 * Instead of committing each event alone, the events of a ledger are written together: one
 * multi-row upsert per table, inside one transaction. If any write fails, the whole ledger
 * rolls back, so a ledger is never half applied.
 *
 * The same transaction also advances the sync progress cursor (#213), so the checkpoint and the
 * ledger's rows commit atomically: a crash can never leave the cursor ahead of the data.
 */

export interface LedgerWrite {
  table: string;
  key: string;
  row: Record<string, unknown>;
}
export interface BatchStoreTx {
  /** Multi-row `INSERT ... ON CONFLICT DO UPDATE` for one table. */
  upsertMany(table: string, rows: Record<string, unknown>[]): Promise<void>;
  /** Atomically records the last fully applied ledger sequence in the checkpoints table. */
  saveCheckpoint(sequence: number): Promise<void>;
}

export interface BatchStore {
  transaction<T>(work: (tx: BatchStoreTx) => Promise<T>): Promise<T>;
}

/**
 * Writes every event of one ledger in a single transaction. Rows are grouped per table, so each
 * table gets one multi-row statement instead of one statement per event. When `sequence` is
 * given, the checkpoint cursor is advanced in the same transaction.
 */
export async function flushLedgerBatch(
  store: BatchStore,
  writes: LedgerWrite[],
  sequence?: number,
): Promise<void> {
  if (writes.length === 0 && sequence === undefined) return;

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
    if (sequence !== undefined) {
      await tx.saveCheckpoint(sequence);
    }
  });
}
