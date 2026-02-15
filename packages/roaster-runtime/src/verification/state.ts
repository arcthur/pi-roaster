import type { VerificationCheckRun, VerificationEvidence, VerificationSessionState } from "../types.js";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class VerificationStateStore {
  private readonly sessions = new Map<string, VerificationSessionState>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  markWrite(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.lastWriteAt = Date.now();
  }

  appendEvidence(sessionId: string, evidence: VerificationEvidence[]): void {
    if (evidence.length === 0) return;
    const state = this.getOrCreate(sessionId);
    this.prune(state);
    state.evidence.push(...evidence);
  }

  setCheckRun(sessionId: string, checkName: string, run: VerificationCheckRun): void {
    const state = this.getOrCreate(sessionId);
    this.prune(state);
    state.checkRuns[checkName] = run;
  }

  get(sessionId: string): VerificationSessionState {
    const state = this.getOrCreate(sessionId);
    this.prune(state);
    return {
      lastWriteAt: state.lastWriteAt,
      evidence: [...state.evidence],
      checkRuns: { ...state.checkRuns },
      denialCount: state.denialCount,
    };
  }

  resetDenials(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.denialCount = 0;
  }

  bumpDenials(sessionId: string): number {
    const state = this.getOrCreate(sessionId);
    state.denialCount += 1;
    return state.denialCount;
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  snapshot(sessionId: string): VerificationSessionState | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    this.prune(state);
    return {
      lastWriteAt: state.lastWriteAt,
      evidence: [...state.evidence],
      checkRuns: { ...state.checkRuns },
      denialCount: state.denialCount,
    };
  }

  restore(sessionId: string, snapshot: VerificationSessionState | undefined): void {
    if (!snapshot) return;
    this.sessions.set(sessionId, {
      lastWriteAt: snapshot.lastWriteAt,
      evidence: [...snapshot.evidence],
      checkRuns: { ...snapshot.checkRuns },
      denialCount: snapshot.denialCount,
    });
  }

  private getOrCreate(sessionId: string): VerificationSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const state: VerificationSessionState = {
      evidence: [],
      checkRuns: {},
      denialCount: 0,
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private prune(state: VerificationSessionState): void {
    const now = Date.now();
    state.evidence = state.evidence.filter((entry) => now - entry.timestamp <= this.ttlMs);
    state.checkRuns = Object.fromEntries(
      Object.entries(state.checkRuns).filter(([, run]) => now - run.timestamp <= this.ttlMs),
    );
  }
}
