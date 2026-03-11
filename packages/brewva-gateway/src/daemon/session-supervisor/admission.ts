import { createDeferred, type Deferred } from "../../utils/deferred.js";
import { SessionBackendCapacityError } from "../session-backend.js";
import type { LoggerLike } from "./worker-state.js";

interface SessionOpenAdmissionOptions {
  logger: LoggerLike;
  maxWorkers: number;
  maxPendingSessionOpens: number;
  getCurrentWorkers(): number;
}

export class SessionOpenAdmissionController {
  private readonly pendingOpenWaiters: Deferred<void>[] = [];
  private pendingOpenReservations = 0;

  constructor(private readonly options: SessionOpenAdmissionOptions) {}

  async acquire(sessionId: string): Promise<void> {
    while (
      this.options.getCurrentWorkers() + this.pendingOpenReservations >=
      this.options.maxWorkers
    ) {
      if (this.options.maxPendingSessionOpens <= 0) {
        throw new SessionBackendCapacityError(
          "worker_limit",
          `session worker limit reached: ${this.options.maxWorkers}`,
          {
            maxWorkers: this.options.maxWorkers,
            currentWorkers: this.options.getCurrentWorkers(),
            queueDepth: this.pendingOpenWaiters.length,
            maxQueueDepth: this.options.maxPendingSessionOpens,
          },
        );
      }
      if (this.pendingOpenWaiters.length >= this.options.maxPendingSessionOpens) {
        throw new SessionBackendCapacityError(
          "open_queue_full",
          `session open queue full: ${this.options.maxPendingSessionOpens}`,
          {
            maxWorkers: this.options.maxWorkers,
            currentWorkers: this.options.getCurrentWorkers(),
            queueDepth: this.pendingOpenWaiters.length,
            maxQueueDepth: this.options.maxPendingSessionOpens,
          },
        );
      }

      this.options.logger.warn("session open waiting for worker capacity", {
        sessionId,
        maxWorkers: this.options.maxWorkers,
        currentWorkers: this.options.getCurrentWorkers(),
        queueDepth: this.pendingOpenWaiters.length + 1,
      });
      const waiter = createDeferred<void>();
      this.pendingOpenWaiters.push(waiter);
      await waiter.promise;
    }
    this.pendingOpenReservations += 1;
  }

  release(): void {
    if (this.pendingOpenReservations > 0) {
      this.pendingOpenReservations -= 1;
    }
    this.notifyIfAvailable();
  }

  notifyIfAvailable(): void {
    if (this.pendingOpenWaiters.length === 0) {
      return;
    }
    if (
      this.options.getCurrentWorkers() + this.pendingOpenReservations >=
      this.options.maxWorkers
    ) {
      return;
    }
    const next = this.pendingOpenWaiters.shift();
    next?.resolve(undefined);
  }
}
