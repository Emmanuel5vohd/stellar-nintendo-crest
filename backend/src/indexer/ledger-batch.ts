/**
 * Batched writes for one ledger (#31).
 *
 * Instead of committing each event alone, the events of a ledger are written together: one
 * multi-row upsert per table, inside one transaction. If any write fails, the whole ledger
 * rolls back, so a ledger is never half applied.
 *
 * The same transaction also advances the sync progress cursor (#213), so the checkpoint and the
 * ledger's rows commit atomically: a crash can never leave the cursor ahead of the data.
 *
 * Prometheus metrics (#214): the latest applied ledger and the lag against the chain tip are
 * exposed as gauges, and the time spent applying a ledger is recorded as a histogram.
 */

import { Counter, Gauge, Histogram, Registry } from 'prom-client';

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

/** Dedicated registry so the indexer's metrics can be scraped from `/metrics` (#214). */
export const indexerMetrics = new Registry();

const latestLedger = new Gauge({
  name: 'stellar_indexer_latest_ledger',
  help: 'Sequence number of the latest ledger fully applied by the indexer.',
  registers: [indexerMetrics],
});

const chainTipLedger = new Gauge({
  name: 'stellar_indexer_chain_tip_ledger',
  help: 'Sequence number of the latest ledger known on the Stellar chain tip.',
  registers: [indexerMetrics],
});

const lagLedgers = new Gauge({
  name: 'stellar_indexer_lag_ledgers',
  help: 'Number of ledgers the indexer is behind the chain tip.',
  registers: [indexerMetrics],
});

const ledgerApplyDuration = new Histogram({
  name: 'stellar_indexer_ledger_apply_seconds',
  help: 'Time spent applying one ledger batch, in seconds.',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [indexerMetrics],
});

const eventIngestDuration = new Histogram({
  name: 'stellar_indexer_event_ingest_seconds',
  help: 'Time spent ingesting a contract event, in seconds, per event type.',
  labelNames: ['event_type'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [indexerMetrics],
});

const eventsIngested = new Counter({
  name: 'stellar_indexer_events_ingested_total',
  help: 'Total number of contract events ingested, per event type.',
  labelNames: ['event_type'] as const,
  registers: [indexerMetrics],
});

/** Records the chain tip so lag can be computed against the latest applied ledger. */
export function observeChainTip(sequence: number): void {
  chainTipLedger.set(sequence);
  const latest = latestLedger.hashMap['']?.value ?? 0;
  lagLedgers.set(Math.max(0, sequence - latest));
}

/** Records the latest fully applied ledger and refreshes the lag gauge. */
export function observeLatestLedger(sequence: number): void {
  latestLedger.set(sequence);
  const tip = chainTipLedger.hashMap['']?.value ?? 0;
  lagLedgers.set(Math.max(0, tip - sequence));
}

/** Times the ingestion of a single contract event, labelled by its event type. */
export async function timeEventIngest<T>(eventType: string, work: () => Promise<T>): Promise<T> {
  const end = eventIngestDuration.startTimer({ event_type: eventType });
  try {
    const result = await work();
    eventsIngested.inc({ event_type: eventType });
    return result;
  } finally {
    end();
  }
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

  const end = ledgerApplyDuration.startTimer();
  try {
    await store.transaction(async (tx) => {
      for (const [table, rows] of byTable) {
        await tx.upsertMany(table, rows);
      }
      if (sequence !== undefined) {
        await tx.saveCheckpoint(sequence);
      }
    });
  } finally {
    end();
  }

  if (sequence !== undefined) {
    observeLatestLedger(sequence);
  }
}
