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
 * Batched handler for high-frequency topics (#210). Receives a group of events that must be
 * persisted together in one atomic transaction. Throwing rejects the whole batch so the router
 * can retain the events for a later flush instead of dropping them.
 */
export type BatchEventHandler = (events: RawContractEvent[]) => Promise<void>;

/** Default buffer window and batch size for high-frequency topics (#210). */
export const DEFAULT_BATCH_FLUSH_MS = 1000;
export const DEFAULT_BATCH_MAX_SIZE = 100;

export interface BatchOptions {
  /** How long events may sit in the buffer before a flush is attempted. */
  flushIntervalMs?: number;
  /** Maximum events per flush; reaching this triggers an immediate flush. */
  maxBatchSize?: number;
}

interface BatchQueue {
  handler: BatchEventHandler;
  buffer: RawContractEvent[];
  flushIntervalMs: number;
  maxBatchSize: number;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<void> | null;
}

export class EventRouter {
  private readonly handlers = new Map<string, EventHandler>();
  private readonly batchQueues = new Map<string, BatchQueue>();

  constructor(private readonly onUnmapped: UnmappedHandler) {}

  /** Registers the handler for one topic. A topic can have only one handler. */
  register(topic: string, handler: EventHandler): void {
    if (this.handlers.has(topic) || this.batchQueues.has(topic)) {
      throw new Error(`handler already registered for topic ${topic}`);
    }
    this.handlers.set(topic, handler);
  }

  /**
   * Registers a batched handler for a high-frequency topic (#210). Events are buffered and
   * flushed together in one atomic write, either when the buffer reaches `maxBatchSize` or
   * after `flushIntervalMs`. A topic can have only one handler.
   */
  registerBatch(topic: string, handler: BatchEventHandler, options: BatchOptions = {}): void {
    if (this.handlers.has(topic) || this.batchQueues.has(topic)) {
      throw new Error(`handler already registered for topic ${topic}`);
    }
    this.batchQueues.set(topic, {
      handler,
      buffer: [],
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_BATCH_FLUSH_MS,
      maxBatchSize: options.maxBatchSize ?? DEFAULT_BATCH_MAX_SIZE,
      timer: null,
      flushing: null,
    });
  }

  /** Routes one event to its handler. Returns `false` when no handler is registered. */
  async dispatchContractEvent(event: RawContractEvent): Promise<boolean> {
    const batch = this.batchQueues.get(event.topic);
    if (batch) {
      this.enqueue(batch, event);
      return true;
    }
    const handler = this.handlers.get(event.topic);
    if (!handler) {
      this.onUnmapped(event);
      return false;
    }
    await handler(event);
    return true;
  }

  /**
   * Flushes every buffered topic now. Callers should await this on shutdown so buffered events
   * are not lost. A failed flush retains its events for the next attempt.
   */
  async flushAll(): Promise<void> {
    await Promise.all([...this.batchQueues.values()].map((queue) => this.flush(queue)));
  }

  private enqueue(queue: BatchQueue, event: RawContractEvent): void {
    queue.buffer.push(event);
    if (queue.buffer.length >= queue.maxBatchSize) {
      void this.flush(queue);
      return;
    }
    if (queue.timer === null) {
      queue.timer = setTimeout(() => {
        queue.timer = null;
        void this.flush(queue);
      }, queue.flushIntervalMs);
      // Do not keep the process alive solely for a pending flush.
      if (typeof queue.timer === "object" && queue.timer !== null && "unref" in queue.timer) {
        (queue.timer as { unref: () => void }).unref();
      }
    }
  }

  private flush(queue: BatchQueue): Promise<void> {
    if (queue.flushing) {
      return queue.flushing;
    }
    if (queue.timer !== null) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }
    if (queue.buffer.length === 0) {
      return Promise.resolve();
    }
    const batch = queue.buffer.splice(0, queue.maxBatchSize);
    queue.flushing = queue
      .handler(batch)
      .catch((error: unknown) => {
        // Retain the events so a later flush retries them instead of dropping them (#210).
        queue.buffer.unshift(...batch);
        throw error;
      })
      .finally(() => {
        queue.flushing = null;
        if (queue.buffer.length > 0) {
          this.enqueue(queue, queue.buffer.pop() as RawContractEvent);
        }
      });
    return queue.flushing;
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
