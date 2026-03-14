import type { ToolInvocationPosture } from "../types.js";
import type { ToolResultVerdict } from "../utils/tool-result.js";

interface TrustState {
  score: number;
  samples: number;
  lastAdvisoryTurn?: number;
}

const DEFAULT_SCORE = 0.5;

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export interface ObserveTrustToolResultInput {
  sessionId: string;
  posture: ToolInvocationPosture;
  verdict: ToolResultVerdict;
}

export interface ObserveVerificationOutcomeInput {
  sessionId: string;
  outcome: "pass" | "fail" | "skipped";
  evidenceFreshness?: "none" | "fresh" | "stale" | "mixed";
}

export interface ObserveRollbackResultInput {
  sessionId: string;
  ok: boolean;
  failedPaths?: number;
  strategy?: "workspace_patchset" | "task_state_journal" | "artifact_write" | "generic_journal";
}

export class TrustMeterService {
  private readonly states = new Map<string, TrustState>();

  private getState(sessionId: string): TrustState {
    const existing = this.states.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: TrustState = {
      score: DEFAULT_SCORE,
      samples: 0,
    };
    this.states.set(sessionId, created);
    return created;
  }

  observeToolResult(input: ObserveTrustToolResultInput): void {
    const state = this.getState(input.sessionId);
    state.samples += 1;

    const baseDelta =
      input.verdict === "pass" ? 0.05 : input.verdict === "inconclusive" ? -0.01 : -0.07;
    const weightedDelta =
      input.posture === "observe"
        ? baseDelta
        : input.posture === "reversible_mutate"
          ? baseDelta * 0.7
          : baseDelta * 0.4;

    state.score = clampScore(state.score + weightedDelta);
  }

  observeVerificationOutcome(input: ObserveVerificationOutcomeInput): void {
    const state = this.getState(input.sessionId);
    state.samples += 1;

    let delta = 0;
    if (input.outcome === "pass") {
      delta += 0.08;
    } else if (input.outcome === "fail") {
      delta -= 0.12;
    } else {
      delta -= 0.01;
    }

    if (input.evidenceFreshness === "fresh") {
      delta += 0.02;
    } else if (input.evidenceFreshness === "stale") {
      delta -= 0.03;
    } else if (input.evidenceFreshness === "mixed") {
      delta -= 0.01;
    }

    state.score = clampScore(state.score + delta);
  }

  observeRollbackResult(input: ObserveRollbackResultInput): void {
    const state = this.getState(input.sessionId);
    state.samples += 1;

    const failedPaths = Math.max(0, Math.floor(input.failedPaths ?? 0));
    let delta = 0;
    if (!input.ok) {
      delta = -0.08;
    } else if (failedPaths === 0) {
      delta = input.strategy === "task_state_journal" ? 0.03 : 0.04;
    } else {
      delta = -0.03;
    }

    state.score = clampScore(state.score + delta);
  }

  getExplorationThresholdBoost(sessionId: string): number {
    const score = this.getState(sessionId).score;
    if (score >= 0.85) return 2;
    if (score >= 0.7) return 1;
    return 0;
  }

  shouldEmitAdvisory(sessionId: string, turn: number): boolean {
    const state = this.getState(sessionId);
    const minTurnGap = state.score >= 0.85 ? 3 : state.score >= 0.7 ? 2 : 1;
    if (typeof state.lastAdvisoryTurn !== "number") {
      return true;
    }
    return turn - state.lastAdvisoryTurn >= minTurnGap;
  }

  markAdvisoryEmitted(sessionId: string, turn: number): void {
    this.getState(sessionId).lastAdvisoryTurn = turn;
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId);
  }
}
