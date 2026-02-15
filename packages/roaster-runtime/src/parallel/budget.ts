import type { ParallelAcquireResult, ParallelSessionSnapshot, ParallelSnapshot, RoasterConfig } from "../types.js";

interface SessionParallelState {
  active: Set<string>;
  totalStarted: number;
}

export class ParallelBudgetManager {
  private readonly config: RoasterConfig["parallel"];
  private readonly sessions = new Map<string, SessionParallelState>();

  constructor(config: RoasterConfig["parallel"]) {
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

    if (state.totalStarted >= this.config.maxTotal) {
      return { accepted: false, reason: "max_total" };
    }

    state.active.add(runId);
    state.totalStarted += 1;
    return { accepted: true };
  }

  release(sessionId: string, runId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.active.delete(runId);
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
    });
    return droppedActiveRuns;
  }

  clear(sessionId: string): void {
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
    };
    this.sessions.set(sessionId, created);
    return created;
  }
}
