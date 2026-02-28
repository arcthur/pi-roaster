export interface ContextStabilityMonitorSnapshot {
  consecutiveDegradedTurns: number;
  stabilized: boolean;
  stabilizedTurns: number;
}

interface SessionStabilityState {
  consecutiveDegradedTurns: number;
  stabilized: boolean;
  stabilizedTurns: number;
  lastDecisionTurn: number | null;
  lastOutcomeTurn: number | null;
}

export class ContextStabilityMonitor {
  private readonly consecutiveThreshold: number;
  private readonly recoveryProbeIntervalTurns: number;
  private readonly sessions = new Map<string, SessionStabilityState>();

  constructor(options: { consecutiveThreshold: number; recoveryProbeIntervalTurns?: number }) {
    this.consecutiveThreshold = Math.max(0, Math.floor(options.consecutiveThreshold));
    this.recoveryProbeIntervalTurns = Math.max(
      1,
      Math.floor(options.recoveryProbeIntervalTurns ?? 3),
    );
  }

  shouldForceCriticalOnly(sessionId: string, turn?: number): boolean {
    if (this.consecutiveThreshold <= 0) return false;
    const state = this.sessions.get(sessionId);
    if (!state?.stabilized) return false;

    const normalizedTurn = this.normalizeTurn(turn);
    if (normalizedTurn === null || state.lastDecisionTurn !== normalizedTurn) {
      state.stabilizedTurns += 1;
      state.lastDecisionTurn = normalizedTurn;
    }
    const isProbeTurn = state.stabilizedTurns % this.recoveryProbeIntervalTurns === 0;
    return !isProbeTurn;
  }

  /** Returns true if this call caused a normal -> stabilized transition. */
  recordDegraded(sessionId: string, turn?: number): boolean {
    if (this.consecutiveThreshold <= 0) return false;

    const state = this.getOrCreate(sessionId);
    const normalizedTurn = this.normalizeTurn(turn);
    if (normalizedTurn !== null && state.lastOutcomeTurn === normalizedTurn) {
      return false;
    }
    state.lastOutcomeTurn = normalizedTurn;
    state.consecutiveDegradedTurns += 1;

    if (!state.stabilized && state.consecutiveDegradedTurns >= this.consecutiveThreshold) {
      state.stabilized = true;
      state.stabilizedTurns = 0;
      state.lastDecisionTurn = null;
      return true;
    }

    if (state.stabilized) {
      // If a probe turn still degrades, restart probe cadence.
      state.stabilizedTurns = 0;
      state.lastDecisionTurn = null;
    }
    return false;
  }

  /** Returns true if this call caused a stabilized -> normal transition. */
  recordNormal(sessionId: string, options: { wasForced?: boolean; turn?: number } = {}): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    const normalizedTurn = this.normalizeTurn(options.turn);
    if (normalizedTurn !== null && state.lastOutcomeTurn === normalizedTurn) {
      return false;
    }
    state.lastOutcomeTurn = normalizedTurn;

    if (state.stabilized) {
      if (options.wasForced === true) {
        return false;
      }
      this.sessions.delete(sessionId);
      return true;
    }

    if (state.consecutiveDegradedTurns > 0) {
      this.sessions.delete(sessionId);
    }
    return false;
  }

  isStabilized(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.stabilized === true;
  }

  snapshot(sessionId: string): ContextStabilityMonitorSnapshot {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return {
        consecutiveDegradedTurns: 0,
        stabilized: false,
        stabilizedTurns: 0,
      };
    }
    return {
      consecutiveDegradedTurns: state.consecutiveDegradedTurns,
      stabilized: state.stabilized,
      stabilizedTurns: state.stabilizedTurns,
    };
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private getOrCreate(sessionId: string): SessionStabilityState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const created: SessionStabilityState = {
      consecutiveDegradedTurns: 0,
      stabilized: false,
      stabilizedTurns: 0,
      lastDecisionTurn: null,
      lastOutcomeTurn: null,
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private normalizeTurn(turn: number | undefined): number | null {
    return typeof turn === "number" && Number.isFinite(turn) ? Math.max(0, Math.floor(turn)) : null;
  }
}
