import type {
  ParallelAcquireResult,
  ParallelSessionSnapshot,
  ParallelSnapshot,
  BrewvaConfig,
} from "../types.js";

interface SessionParallelState {
  active: Set<string>;
  totalStarted: number;
  waiters: ParallelSlotWaiter[];
}

interface ParallelSlotWaiter {
  runId: string;
  resolve: (result: ParallelAcquireResult) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ParallelBudgetManager {
  private readonly config: BrewvaConfig["parallel"];
  private readonly sessions = new Map<string, SessionParallelState>();

  constructor(config: BrewvaConfig["parallel"]) {
    this.config = config;
  }

  acquire(sessionId: string, runId: string): ParallelAcquireResult {
    if (!this.config.enabled) {
      return { accepted: false, reason: "disabled" };
    }

    const state = this.getOrCreate(sessionId);
    if (state.active.has(runId)) {
      return { accepted: true };
    }

    if (state.active.size >= this.config.maxConcurrent) {
      return { accepted: false, reason: "max_concurrent" };
    }

    if (state.totalStarted >= this.config.maxTotalPerSession) {
      return { accepted: false, reason: "max_total" };
    }

    state.active.add(runId);
    state.totalStarted += 1;
    return { accepted: true };
  }

  acquireAsync(
    sessionId: string,
    runId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<ParallelAcquireResult> {
    const immediate = this.acquire(sessionId, runId);
    if (immediate.accepted || immediate.reason === "disabled" || immediate.reason === "max_total") {
      return Promise.resolve(immediate);
    }

    const state = this.getOrCreate(sessionId);
    if (state.waiters.some((waiter) => waiter.runId === runId)) {
      return Promise.resolve({ accepted: false, reason: "max_concurrent" });
    }

    return new Promise<ParallelAcquireResult>((resolve) => {
      const waiter: ParallelSlotWaiter = {
        runId,
        resolve,
      };

      const timeoutMs =
        typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
          ? Math.max(1, Math.trunc(options.timeoutMs))
          : 0;
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(sessionId, waiter);
          resolve({ accepted: false, reason: "timeout" });
        }, timeoutMs);
        waiter.timer.unref?.();
      }

      state.waiters.push(waiter);
    });
  }

  release(sessionId: string, runId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.active.delete(runId);
    this.drainWaiters(sessionId, state);
  }

  snapshotSession(sessionId: string): ParallelSessionSnapshot | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    return {
      activeRunIds: [...state.active.values()],
      totalStarted: state.totalStarted,
    };
  }

  restoreSession(sessionId: string, snapshot: ParallelSessionSnapshot | undefined): number {
    if (!snapshot) return 0;
    const droppedActiveRuns = new Set(snapshot.activeRunIds).size;
    this.sessions.set(sessionId, {
      // Active workers do not survive process restarts, so restoring them would leak maxConcurrent slots.
      active: new Set<string>(),
      totalStarted: Math.max(0, snapshot.totalStarted),
      waiters: [],
    });
    return droppedActiveRuns;
  }

  clear(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      for (const waiter of state.waiters) {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.resolve({ accepted: false, reason: "cancelled" });
      }
    }
    this.sessions.delete(sessionId);
  }

  snapshot(): ParallelSnapshot {
    const sessions: ParallelSnapshot["sessions"] = {};
    let active = 0;
    let totalStarted = 0;

    for (const [sessionId, state] of this.sessions.entries()) {
      sessions[sessionId] = {
        active: state.active.size,
        totalStarted: state.totalStarted,
      };
      active += state.active.size;
      totalStarted += state.totalStarted;
    }

    return {
      active,
      totalStarted,
      sessions,
    };
  }

  private getOrCreate(sessionId: string): SessionParallelState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionParallelState = {
      active: new Set<string>(),
      totalStarted: 0,
      waiters: [],
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private drainWaiters(sessionId: string, state: SessionParallelState): void {
    while (state.waiters.length > 0) {
      const next = state.waiters[0];
      if (!next) return;

      const acquired = this.acquire(sessionId, next.runId);
      if (!acquired.accepted && acquired.reason === "max_concurrent") {
        return;
      }

      state.waiters.shift();
      if (next.timer) {
        clearTimeout(next.timer);
      }

      next.resolve(acquired);
    }
  }

  private removeWaiter(sessionId: string, waiter: ParallelSlotWaiter): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const index = state.waiters.indexOf(waiter);
    if (index >= 0) {
      state.waiters.splice(index, 1);
    }
  }
}
