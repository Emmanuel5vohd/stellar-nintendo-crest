/**
 * BetPlaced handler (#20).
 *
 * Turns a `BetPlaced` contract event into one bet row and the matching market totals, in a
 * single transaction, and is idempotent on `(tx_hash, event_index)` so a replayed event is
 * applied once. The store is an interface so the handler runs against PostgreSQL in the indexer
 * and against an in-memory store in tests.
 *
 * Referential integrity (#249): `bets.market_id` is enforced by a foreign key to `markets.id`
 * with `ON DELETE RESTRICT`, so a bet can never reference a missing market. The handler checks
 * the market exists before inserting and surfaces a typed error instead of letting the insert
 * fail on the constraint, keeping historical/orphan events from creating orphan rows.
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
  /** Contract method invoked by the transaction (e.g. `place_bet`). */
  contractMethod?: string;
  /** Resource telemetry parsed from the transaction envelope result (#219). */
  telemetry?: TxTelemetry;
}

/**
 * Per-transaction gas/resource telemetry (#219). Parsed from the transaction envelope result
 * and stored alongside the bet/market records so protocol developers can track gas trends.
 */
export interface TxTelemetry {
  cpuInstructions: bigint;
  ramBytes: bigint;
  feeStroops: bigint;
}

export interface TxTelemetryRow extends TxTelemetry {
  txHash: string;
  eventIndex: number;
  contractMethod: string;
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

/** One leaderboard point delta for a user address. */
export interface LeaderboardPointDelta {
  userAddress: string;
  points: bigint;
}

export interface BetStore {
  /** Runs `work` in one transaction; every write in it commits or none does. */
  transaction<T>(work: (tx: BetStoreTx) => Promise<T>): Promise<T>;
}

export interface BetStoreTx {
  findBet(txHash: string, eventIndex: number): Promise<BetRow | undefined>;
  insertBet(row: BetRow): Promise<void>;
  /** Returns whether the referenced market exists; guards the `bets.market_id` FK. */
  marketExists(marketId: number): Promise<boolean>;
  getMarketTotals(marketId: number): Promise<MarketTotals | undefined>;
  setMarketTotals(totals: MarketTotals): Promise<void>;
  /**
   * Atomically adds `points` to `userAddress`'s leaderboard score
   * (`UPDATE ... SET points = points + $1`), inserting the row when absent (UPSERT).
   */
  incrementLeaderboardPoints(userAddress: string, points: bigint): Promise<void>;
}

/**
 * Calendar-quarter partition descriptor for the `bets` table (#252).
 *
 * `name` is the child partition table name (e.g. `bets_2026_q1`) and `[start, end)` is the
 * half-open `placed_at` range it covers, matching PostgreSQL RANGE partition bounds.
 */
export interface BetPartition {
  name: string;
  start: Date;
  end: Date;
}

/**
 * Returns the calendar-quarter partition that covers `date`.
 *
 * Quarters are calendar-aligned: Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec. The
 * returned range is half-open (`start` inclusive, `end` exclusive) so adjacent partitions never
 * overlap, which is required for PostgreSQL RANGE partitioning.
 */
export function betPartitionFor(date: Date): BetPartition {
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, startMonth + 3, 1, 0, 0, 0, 0));
  return { name: `bets_${year}_q${quarter}`, start, end };
}

/**
 * Returns the next `count` calendar-quarter partitions starting at the quarter containing
 * `from`. Used by the partition-management routine to pre-provision upcoming quarters so inserts
 * never fail on a missing partition.
 */
export function upcomingBetPartitions(from: Date, count: number): BetPartition[] {
  const partitions: BetPartition[] = [];
  let cursor = betPartitionFor(from).start;
  for (let i = 0; i < count; i += 1) {
    const partition = betPartitionFor(cursor);
    partitions.push(partition);
    cursor = partition.end;
  }
  return partitions;
}

/**
 * Applies leaderboard point deltas inside an open transaction (#254).
 *
 * Deltas are sorted by `userAddress ASC` before any row is locked/updated so every concurrent
 * transaction acquires row locks in the same global order, which eliminates the classic
 * PostgreSQL deadlock caused by two transactions updating the same rows in opposite orders.
 * Each row is then incremented atomically (`points = points + $1`) rather than read-modify-write.
 */
export async function applyLeaderboardPoints(
  tx: BetStoreTx,
  deltas: readonly LeaderboardPointDelta[],
): Promise<void> {
  const ordered = [...deltas].sort((a, b) =>
    a.userAddress < b.userAddress ? -1 : a.userAddress > b.userAddress ? 1 : 0,
  );
  for (const delta of ordered) {
    if (delta.points === 0n) {
      continue;
    }
    await tx.incrementLeaderboardPoints(delta.userAddress, delta.points);
  }
}

/** Raised when a BetPlaced event references a market that does not exist. */
export class UnknownMarketError extends Error {
  constructor(public readonly marketId: number) {
    super(`BetPlaced references unknown market ${marketId}`);
    this.name = 'UnknownMarketError';
  }
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
 * Throws {@link UnknownMarketError} when the market is missing, so the caller can skip the
 * event rather than violate the `bets.market_id` foreign key.
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

    if (!(await tx.marketExists(event.marketId))) {
      throw new UnknownMarketError(event.marketId);
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

    await applyLeaderboardPoints(tx, [
      { userAddress: event.bettor, points: event.netAmount },
    ]);

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

/** One resolved bet outcome used to compute win/loss counts and P&L. */
export interface ResolvedBet {
  bettor: string;
  /** Net amount staked (after fees), in the smallest token unit. */
  netAmount: bigint;
  /** Payout credited to the bettor when the market resolved in their favour, else `0n`. */
  payout: bigint;
  /** Whether the bet won. */
  won: boolean;
  timestamp: Date;
}

/** A single point in the cumulative P&L time series. */
export interface PnlDataPoint {
  /** ISO date (UTC, `YYYY-MM-DD`) the point covers. */
  date: string;
  /** Cumulative net profit/loss up to and including this day, in the smallest token unit. */
  cumulativePnl: bigint;
}

/** Aggregated historical performance for one user. */
export interface UserAnalytics {
  address: string;
  totalBets: number;
  winCount: number;
  lossCount: number;
  /** Win rate as a percentage (0–100), rounded to two decimals. */
  winRate: number;
  /** Total amount staked across all bets, in the smallest token unit. */
  totalVolume: bigint;
  /** Net profit/loss across all resolved bets, in the smallest token unit. */
  totalPnl: bigint;
  /** Return on investment as a percentage, rounded to two decimals. */
  roi: number;
  /** Cumulative P&L over the trailing 30 days, one point per day, for charting. */
  pnlSeries: PnlDataPoint[];
  /** Referral commissions earned by the user, in the smallest token unit. */
  referralCommissions: bigint;
  /** Current token balances held by the user, keyed by token symbol. */
  tokenBalances: Record<string, bigint>;
}

/** Source of the raw data needed to build a user's analytics. */
export interface UserAnalyticsStore {
  /** All resolved bets for the user, ordered by timestamp ascending. */
  getResolvedBets(address: string): Promise<ResolvedBet[]>;
  /** Total referral commissions earned by the user, in the smallest token unit. */
  getReferralCommissions(address: string): Promise<bigint>;
  /** Current token balances held by the user, keyed by token symbol. */
  getTokenBalances(address: string): Promise<Record<string, bigint>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PNL_WINDOW_DAYS = 30;

function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Builds the trailing 30-day cumulative P&L series. Each day's point carries the running total
 * of net P&L (payout minus stake) for every resolved bet up to and including that day, so the
 * series can be plotted directly as a cumulative growth curve.
 */
function buildPnlSeries(bets: ResolvedBet[], now: Date): PnlDataPoint[] {
  const windowStart = new Date(now.getTime() - (PNL_WINDOW_DAYS - 1) * DAY_MS);
  const startKey = toUtcDateKey(windowStart);

  // Running P&L from bets before the window seeds the first point so the curve is continuous.
  let running = 0n;
  const dailyPnl = new Map<string, bigint>();
  for (const bet of bets) {
    const pnl = bet.payout - bet.netAmount;
    const key = toUtcDateKey(bet.timestamp);
    if (key < startKey) {
      running += pnl;
    } else {
      dailyPnl.set(key, (dailyPnl.get(key) ?? 0n) + pnl);
    }
  }

  const series: PnlDataPoint[] = [];
  for (let i = 0; i < PNL_WINDOW_DAYS; i += 1) {
    const day = new Date(windowStart.getTime() + i * DAY_MS);
    const key = toUtcDateKey(day);
    running += dailyPnl.get(key) ?? 0n;
    series.push({ date: key, cumulativePnl: running });
  }
  return series;
}

/**
 * Aggregates a user's historical bets, payouts, and IPREDICT rewards into total P&L, win rate,
 * ROI, a 30-day cumulative P&L series, referral commissions, and token balances (#242).
 */
export async function getUserAnalytics(
  store: UserAnalyticsStore,
  address: string,
  now: Date = new Date(),
): Promise<UserAnalytics> {
  const [bets, referralCommissions, tokenBalances] = await Promise.all([
    store.getResolvedBets(address),
    store.getReferralCommissions(address),
    store.getTokenBalances(address),
  ]);

  let winCount = 0;
  let lossCount = 0;
  let totalVolume = 0n;
  let totalPnl = 0n;
  for (const bet of bets) {
    totalVolume += bet.netAmount;
    totalPnl += bet.payout - bet.netAmount;
    if (bet.won) {
      winCount += 1;
    } else {
      lossCount += 1;
    }
  }

  const resolved = winCount + lossCount;
  const winRate = resolved === 0 ? 0 : roundPercent((winCount / resolved) * 100);
  const roi = totalVolume === 0n ? 0 : roundPercent((Number(totalPnl) / Number(totalVolume)) * 100);

  return {
    address,
    totalBets: bets.length,
    winCount,
    lossCount,
    winRate,
    totalVolume,
    totalPnl,
    roi,
    pnlSeries: buildPnlSeries(bets, now),
    referralCommissions,
    tokenBalances,
  };
}
