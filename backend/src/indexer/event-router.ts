/**
 * Single event router for live indexing and backfill (#21, #23).
 *
 * Every contract event goes through `dispatchContractEvent`, which looks up its topic and calls
 * the one handler registered for it. Live polling and the backfill runner both use this router,
 * so both run the same handler code. Topics with no handler are reported, not dropped.
 *
 * Idempotency (#220): each event carries a deterministic `event_hash` derived from
 * `(ledger_sequence, tx_hash, event_index)`. The router tracks hashes it has already dispatched
 * so a restart during a partially processed ledger does not re-run handlers for events that were
 * already applied. Handlers persist the same hash under a UNIQUE constraint and use
 * `ON CONFLICT DO NOTHING`, so duplicate writes are rejected at the database layer too.
 */

import type { RawContractEvent } from "./event-schema";

export type EventHandler = (event: RawContractEvent) => Promise<void>;

export type UnmappedHandler = (event: RawContractEvent) => void;

/**
 * Computes the deterministic event hash from ledger sequence, tx hash and event index.
 * The same event always yields the same hash, so it can be used as an idempotency key.
 */
export function computeEventHash(event: RawContractEvent): string {
  return `${event.ledger_sequence}:${event.tx_hash}:${event.event_index}`;
}

export class EventRouter {
  private readonly handlers = new Map<string, EventHandler>();
  private readonly processedHashes = new Set<string>();

  constructor(private readonly onUnmapped: UnmappedHandler) {}

  /** Registers the handler for one topic. A topic can have only one handler. */
  register(topic: string, handler: EventHandler): void {
    if (this.handlers.has(topic)) {
      throw new Error(`handler already registered for topic ${topic}`);
    }
    this.handlers.set(topic, handler);
  }

  /**
   * Routes one event to its handler. Returns `false` when no handler is registered or when the
   * event was already processed (duplicate on restart).
   */
  async dispatchContractEvent(event: RawContractEvent): Promise<boolean> {
    const eventHash = computeEventHash(event);
    if (this.processedHashes.has(eventHash)) {
      return false;
    }

    const handler = this.handlers.get(event.topic);
    if (!handler) {
      this.onUnmapped(event);
      return false;
    }

    await handler(event);
    this.processedHashes.add(eventHash);
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
