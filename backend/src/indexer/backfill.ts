/**
 * Backfill runner over the unified event router (#23).
 *
 * Replays historical ledgers through the same `EventRouter` the live indexer uses, so backfill
 * and live indexing run identical handler code. It takes `--from-ledger` and `--to-ledger`,
 * prints progress, and saves a checkpoint every `CHECKPOINT_EVERY` ledgers so a restart resumes
 * from the last saved ledger rather than the beginning.
 *
 * Cold-start catch-up (#213): when `--to-ledger` is omitted the runner pages forward through
 * `getEvents` until it reaches the chain tip, tracking a pagination cursor across pages and
 * persisting the sync cursor atomically so a restart resumes exactly where it left off.
 */

import type { EventRouter } from "./event-router";
import type { RawContractEvent } from "./event-schema";

export const CHECKPOINT_EVERY = 100;

export interface BackfillOptions {
  fromLedger: number;
  /** Inclusive upper bound; when omitted the runner catches up to the chain tip. */
  toLedger?: number;
}

/** Reads `--from-ledger <N>` and optional `--to-ledger <M>` from the argument list. */
export function parseBackfillArgs(argv: string[]): BackfillOptions {
  const read = (flag: string): number => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) {
      throw new Error(`missing ${flag} <N>`);
    }
    const value = Number(argv[i + 1]);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${flag} must be a non-negative integer`);
    }
    return value;
  };
  const fromLedger = read("--from-ledger");
  const hasTo = argv.includes("--to-ledger");
  const toLedger = hasTo ? read("--to-ledger") : undefined;
  if (toLedger !== undefined && fromLedger > toLedger) {
    throw new Error("--from-ledger must not be greater than --to-ledger");
  }
  return { fromLedger, toLedger };
}

export interface BackfillDeps {
  router: EventRouter;
  fetchLedgerEvents(ledger: number): Promise<RawContractEvent[]>;
  /** Atomically persists the sync cursor (ledger + pagination cursor) in the checkpoints table. */
  saveCheckpoint(ledger: number, cursor?: string): Promise<void>;
  loadCheckpoint(): Promise<{ ledger: number; cursor?: string } | undefined>;
  /** Returns the current chain tip ledger, used when no `--to-ledger` is supplied. */
  getChainTip(): Promise<number>;
  progress(message: string): void;
}

/**
 * Replays every ledger in range. Resumes after the saved checkpoint if one is past `fromLedger`.
 * When `toLedger` is omitted, catches up to the chain tip. Returns the last ledger processed.
 */
export async function runBackfill(options: BackfillOptions, deps: BackfillDeps): Promise<number> {
  const saved = await deps.loadCheckpoint();
  const start = saved !== undefined && saved.ledger >= options.fromLedger ? saved.ledger + 1 : options.fromLedger;
  const toLedger = options.toLedger ?? (await deps.getChainTip());
  const total = toLedger - start + 1;
  let last = start - 1;
  let cursor = saved !== undefined && saved.ledger >= options.fromLedger ? saved.cursor : undefined;

  for (let ledger = start; ledger <= toLedger; ledger++) {
    const events = await deps.fetchLedgerEvents(ledger);
    for (const event of events) {
      await deps.router.dispatchContractEvent(event);
      cursor = event.cursor ?? cursor;
    }
    last = ledger;

    const done = ledger - start + 1;
    if (done % CHECKPOINT_EVERY === 0 || ledger === toLedger) {
      await deps.saveCheckpoint(ledger, cursor);
      deps.progress(`backfill ${done}/${total} ledgers (ledger ${ledger})`);
    }
  }
  return last;
}
