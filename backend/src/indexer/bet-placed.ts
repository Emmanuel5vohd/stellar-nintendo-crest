/**
 * BetPlaced handler (#20).
 *
 * Turns a `BetPlaced` contract event into one bet row and the matching market totals, in a
 * single transaction, and is idempotent on `(tx_hash, event_index)` so a replayed event is
 * applied once. The store is an interface so the handler runs against PostgreSQL in the indexer
 * and against an in-memory store in tests.
 *
 * Market stats (odds, implied probabilities, total pool sizes) are cached in a Redis hash per
 * market (#241). The cache is updated incrementally after the transaction commits and is
 * invalidated so the next read repopulates it from the database.
 */

export interface BetPlacedEvent {
  txHash: string;
  eventIndex: number;
  marketId: number;
  bettor: string;
  isYes: boolean;
  grossAmount: bigint;
  netAmount: bigint;
  timestamp: Date;
}

export interface BetRow {
  txHash: string;
  eventIndex: number;
  marketId: number;
  bettor: string;
  isYes: boolean;
  grossAmount: bigint;
  netAmount: bigint;
  timestamp: Date;
}

export interface MarketTotals {
  marketId: number;
  totalYes: bigint;
  totalNo: bigint;
  betCount: number;
}

export interface BetStore {
  /** Runs `work` in one transaction; every write in it commits or none does. */
  transaction<T>(work: (tx: BetStoreTx) => Promise<T>): Promise<T>;
}

export interface BetStoreTx {
  findBet(txHash: string, eventIndex: number): Promise<BetRow | undefined>;
  insertBet(row: BetRow): Promise<void>;
  getMarketTotals(marketId: number): Promise<MarketTotals | undefined>;
  setMarketTotals(totals: MarketTotals): Promise<void>;
}

/**
 * Minimal Redis surface used to cache market stats. Kept as an interface so the handler can run
 * against ioredis in production and an in-memory fake in tests.
 */
export interface MarketStatsCache {
  /** Returns the cached hash for a market, or `undefined` when the cache is cold. */
  getMarketStats(marketId: number): Promise<MarketTotals | undefined>;
  /** Writes the full stats hash for a market. */
  setMarketStats(totals: MarketTotals): Promise<void>;
  /** Drops the cached stats for a market so the next read falls back to the database. */
  invalidateMarketStats(marketId: number): Promise<void>;
}

/**
 * Applies one BetPlaced event. Returns `false` when the event was already recorded.
 *
 * When a `cache` is supplied, the market's cached stats are invalidated after the transaction
 * commits so the next odds query repopulates from the database instead of serving stale odds.
 */
export async function handleBetPlaced(
  store: BetStore,
  event: BetPlacedEvent,
  cache?: MarketStatsCache,
): Promise<boolean> {
  const applied = await store.transaction(async (tx) => {
    const existing = await tx.findBet(event.txHash, event.eventIndex);
    if (existing) {
      return false;
    }

    await tx.insertBet({
      txHash: event.txHash,
      eventIndex: event.eventIndex,
      marketId: event.marketId,
      bettor: event.bettor,
      isYes: event.isYes,
      grossAmount: event.grossAmount,
      netAmount: event.netAmount,
      timestamp: event.timestamp,
    });

    const current = (await tx.getMarketTotals(event.marketId)) ?? {
      marketId: event.marketId,
      totalYes: 0n,
      totalNo: 0n,
      betCount: 0,
    };
    await tx.setMarketTotals({
      marketId: event.marketId,
      totalYes: current.totalYes + (event.isYes ? event.netAmount : 0n),
      totalNo: current.totalNo + (event.isYes ? 0n : event.netAmount),
      betCount: current.betCount + 1,
    });

    return true;
  });

  if (applied && cache) {
    await cache.invalidateMarketStats(event.marketId);
  }

  return applied;
}

/**
 * Reads market stats from the cache, falling back to the database when the cache is cold and
 * repopulating it so subsequent odds queries are served from Redis.
 */
export async function getMarketStats(
  store: BetStore,
  cache: MarketStatsCache,
  marketId: number,
): Promise<MarketTotals | undefined> {
  const cached = await cache.getMarketStats(marketId);
  if (cached) {
    return cached;
  }

  const totals = await store.transaction((tx) => tx.getMarketTotals(marketId));
  if (totals) {
    await cache.setMarketStats(totals);
  }
  return totals;
}
