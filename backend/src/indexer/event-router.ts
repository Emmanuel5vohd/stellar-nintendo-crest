/**
 * Single event router for live indexing and backfill (#21, #23).
 *
 * Every contract event goes through `dispatchContractEvent`, which looks up its topic and calls
 * the one handler registered for it. Live polling and the backfill runner both use this router,
 * so both run the same handler code. Topics with no handler are reported, not dropped.
 */

import type { RawContractEvent } from "./event-schema";

export type EventHandler = (event: RawContractEvent) => Promise<void>;

export type UnmappedHandler = (event: RawContractEvent) => void;

/**
 * PostgreSQL pool tuning for the indexer runner (#217). Bursts of hundreds of concurrent bet
 * events otherwise exhaust the pool and time out queries, so the pool is bounded and every
 * statement is capped.
 */
export interface PoolConfig {
  min: number;
  max: number;
  statementTimeoutMs: number;
  idleTimeoutMs: number;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  min: 5,
  max: 30,
  statementTimeoutMs: 5000,
  idleTimeoutMs: 10000,
};

/**
 * Runs `work` against a pooled connection and always releases it (#217). The `finally` block
 * guarantees release even when the handler throws, so a failing event cannot leak a connection.
 */
export async function withPooledConnection<T>(
  acquire: () => Promise<T>,
  release: (connection: T) => void,
  work: (connection: T) => Promise<void>,
): Promise<void> {
  const connection = await acquire();
  try {
    await work(connection);
  } finally {
    release(connection);
  }
}

/**
 * Retries `work` with exponential backoff when the pool is saturated (#217). Transient pool
 * exhaustion is retried a bounded number of times; any other error is rethrown immediately.
 */
export async function withPoolRetry<T>(
  work: () => Promise<T>,
  isPoolExhausted: (error: unknown) => boolean,
  maxAttempts = 5,
  baseDelayMs = 50,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      attempt += 1;
      if (attempt >= maxAttempts || !isPoolExhausted(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

export class EventRouter {
  private readonly handlers = new Map<string, EventHandler>();

  constructor(private readonly onUnmapped: UnmappedHandler) {}

  /** Registers the handler for one topic. A topic can have only one handler. */
  register(topic: string, handler: EventHandler): void {
    if (this.handlers.has(topic)) {
      throw new Error(`handler already registered for topic ${topic}`);
    }
    this.handlers.set(topic, handler);
  }

  /** Routes one event to its handler. Returns `false` when no handler is registered. */
  async dispatchContractEvent(event: RawContractEvent): Promise<boolean> {
    const handler = this.handlers.get(event.topic);
    if (!handler) {
      this.onUnmapped(event);
      return false;
    }
    await handler(event);
    return true;
  }
}

/**
 * Builds the router with the user-facing handlers wired in (#21): claims, fee withdrawals and
 * loyalty points. Each handler is supplied by the caller, so the store is injected, not global.
 */
export function buildUserEventRouter(
  handlers: {
    claim: EventHandler;
    feeWithdrawn: EventHandler;
    rewardPoints: EventHandler;
  },
  onUnmapped: UnmappedHandler,
): EventRouter {
  const router = new EventRouter(onUnmapped);
  router.register("claim", handlers.claim);
  router.register("fee_withdrawn", handlers.feeWithdrawn);
  router.register("reward_points", handlers.rewardPoints);
  return router;
}

/**
 * A decoded IPREDICT SAC token event (#216). `transfer` moves tokens between wallets, `mint`
 * awards new tokens to a recipient. `marketId` is present when the event can be attributed to
 * a specific market (e.g. a mint triggered by a market resolution).
 */
export interface TokenEvent {
  kind: "transfer" | "mint";
  from: string | null;
  to: string;
  amount: bigint;
  marketId: string | null;
}

/**
 * Decodes a raw SAC-style token event into a `TokenEvent` (#216). Returns `null` when the event
 * is not a token `transfer`/`mint` event or its payload is malformed, so callers can skip it.
 *
 * Expected payload shape: `{ from?, to, amount, marketId? }` where `amount` is a decimal string
 * or number. `mint` events have no `from`; `transfer` events require one.
 */
export function decodeTokenEvent(event: RawContractEvent): TokenEvent | null {
  if (event.topic !== "transfer" && event.topic !== "mint") {
    return null;
  }

  const payload = event.data as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const to = payload.to;
  if (typeof to !== "string" || to.length === 0) {
    return null;
  }

  const rawAmount = payload.amount;
  let amount: bigint;
  try {
    if (typeof rawAmount === "bigint") {
      amount = rawAmount;
    } else if (typeof rawAmount === "string" && rawAmount.length > 0) {
      amount = BigInt(rawAmount);
    } else if (typeof rawAmount === "number" && Number.isFinite(rawAmount)) {
      amount = BigInt(Math.trunc(rawAmount));
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const rawFrom = payload.from;
  const from = typeof rawFrom === "string" && rawFrom.length > 0 ? rawFrom : null;
  if (event.topic === "transfer" && from === null) {
    return null;
  }

  const rawMarketId = payload.marketId;
  const marketId =
    typeof rawMarketId === "string" && rawMarketId.length > 0 ? rawMarketId : null;

  return { kind: event.topic, from, to, amount, marketId };
}

/**
 * Builds the router with the IPREDICT token handlers wired in (#216): `transfer` and `mint`
 * events are decoded and handed to the caller-supplied ledger writer, which persists them to
 * the `token_transfers` table. Undecodable token events are reported via `onUnmapped`.
 */
export function buildTokenEventRouter(
  handlers: {
    recordTokenEvent: (event: TokenEvent) => Promise<void>;
  },
  onUnmapped: UnmappedHandler,
): EventRouter {
  const router = new EventRouter(onUnmapped);
  const route = async (event: RawContractEvent): Promise<void> => {
    const decoded = decodeTokenEvent(event);
    if (!decoded) {
      onUnmapped(event);
      return;
    }
    await handlers.recordTokenEvent(decoded);
  };
  router.register("transfer", route);
  router.register("mint", route);
  return router;
}
