import { pgPoolActiveConnections, pgPoolIdleConnections, pgPoolWaitingQueries, setGauge } from "../indexer/metrics";

export interface PoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  on(event: string, listener: (...args: any[]) => void): void;
}

export const SLOW_ACQUIRE_THRESHOLD_MS = 200;

/**
 * Instruments a pg-pool instance to track active, idle, and waiting queries in Prometheus telemetry.
 */
export function instrumentPool(pool: PoolLike): void {
  const updateMetrics = () => {
    setGauge(pgPoolActiveConnections, Math.max(0, pool.totalCount - pool.idleCount));
    setGauge(pgPoolIdleConnections, pool.idleCount);
    setGauge(pgPoolWaitingQueries, pool.waitingCount);
  };

  pool.on("acquire", () => {
    updateMetrics();
  });

  pool.on("release", () => {
    updateMetrics();
  });

  pool.on("error", (err: Error) => {
    console.error("[pg-pool] Unexpected error on idle client", err);
  });

  updateMetrics();
}

/**
 * Logs a warning if query connection acquisition wait time exceeds 200ms.
 */
export function logSlowAcquire(durationMs: number): void {
  if (durationMs > SLOW_ACQUIRE_THRESHOLD_MS) {
    console.warn(`[WARN] Database connection pool wait time exceeded 200ms: ${durationMs}ms`);
  }
}
