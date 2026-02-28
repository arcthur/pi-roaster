import type {
  ContextBudgetSessionState,
  ContextBudgetUsage,
  ContextCompactionDecision,
  ContextCompactionReason,
  ContextInjectionDecision,
  BrewvaConfig,
} from "../types.js";
import { estimateTokenCount, normalizePercent, truncateTextToTokenBudget } from "../utils/token.js";

interface SessionBudgetState {
  turnIndex: number;
  lastCompactionTurn: number;
  lastCompactionAtMs?: number;
  lastContextUsage?: ContextBudgetUsage;
  pendingCompactionReason?: ContextCompactionReason;
}

export class ContextBudgetManager {
  private readonly config: BrewvaConfig["infrastructure"]["contextBudget"];
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionBudgetState>();

  constructor(
    config: BrewvaConfig["infrastructure"]["contextBudget"],
    options: { now?: () => number } = {},
  ) {
    this.config = config;
    this.now = options.now ?? Date.now;
  }

  beginTurn(sessionId: string, turnIndex: number): void {
    const state = this.getOrCreate(sessionId);
    state.turnIndex = Math.max(state.turnIndex, turnIndex);
  }

  observeUsage(sessionId: string, usage: ContextBudgetUsage | undefined): void {
    if (!usage) return;
    const state = this.getOrCreate(sessionId);
    state.lastContextUsage = {
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: normalizePercent(usage.percent, {
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
      }),
    };
  }

  planInjection(
    sessionId: string,
    inputText: string,
    usage?: ContextBudgetUsage,
    options: { bypassMaxInjectionTokens?: boolean } = {},
  ): ContextInjectionDecision {
    if (!this.config.enabled) {
      const tokens = estimateTokenCount(inputText);
      return {
        accepted: true,
        finalText: inputText,
        originalTokens: tokens,
        finalTokens: tokens,
        truncated: false,
      };
    }

    this.observeUsage(sessionId, usage);
    const state = this.getOrCreate(sessionId);
    const usagePercent = usage
      ? normalizePercent(usage.percent, {
          tokens: usage.tokens,
          contextWindow: usage.contextWindow,
        })
      : normalizePercent(state.lastContextUsage?.percent);
    const originalTokens = estimateTokenCount(inputText);

    if (usagePercent !== null && usagePercent >= this.config.hardLimitPercent) {
      return {
        accepted: false,
        finalText: "",
        originalTokens,
        finalTokens: 0,
        truncated: false,
        droppedReason: "hard_limit",
      };
    }

    const tokenBudget = options.bypassMaxInjectionTokens
      ? Number.MAX_SAFE_INTEGER
      : Math.max(32, this.config.maxInjectionTokens);
    const finalText = truncateTextToTokenBudget(inputText, tokenBudget);
    const finalTokens = estimateTokenCount(finalText);
    return {
      accepted: finalText.length > 0,
      finalText,
      originalTokens,
      finalTokens,
      truncated: finalTokens < originalTokens,
    };
  }

  shouldRequestCompaction(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextCompactionDecision {
    if (!this.config.enabled) {
      return { shouldCompact: false };
    }

    this.observeUsage(sessionId, usage);
    const state = this.getOrCreate(sessionId);
    const current = usage ?? state.lastContextUsage;
    const usagePercent = usage
      ? normalizePercent(usage.percent, {
          tokens: usage.tokens,
          contextWindow: usage.contextWindow,
        })
      : normalizePercent(current?.percent);
    if (state.pendingCompactionReason) {
      return { shouldCompact: true, reason: state.pendingCompactionReason, usage: current };
    }
    if (usagePercent === null) {
      return { shouldCompact: false, usage: current };
    }

    const hardLimitPercent = normalizePercent(this.config.hardLimitPercent) ?? 1;
    const compactionThresholdPercent =
      normalizePercent(this.config.compactionThresholdPercent) ?? hardLimitPercent;
    const pressureBypassPercent = normalizePercent(this.config.compaction.pressureBypassPercent);
    const bypassCooldown =
      usagePercent >= hardLimitPercent ||
      (pressureBypassPercent !== null && usagePercent >= pressureBypassPercent);

    if (!bypassCooldown) {
      const sinceLastCompaction = Math.max(0, state.turnIndex - state.lastCompactionTurn);
      if (sinceLastCompaction < this.config.compaction.minTurnsBetween) {
        return { shouldCompact: false, usage: current };
      }

      const minSecondsBetweenCompaction = this.config.compaction.minSecondsBetween;
      const minCooldownMs = Math.floor(minSecondsBetweenCompaction * 1000);
      if (minCooldownMs > 0 && typeof state.lastCompactionAtMs === "number") {
        const elapsedMs = Math.max(0, this.now() - state.lastCompactionAtMs);
        if (elapsedMs < minCooldownMs) {
          return { shouldCompact: false, usage: current };
        }
      }
    }

    if (usagePercent >= hardLimitPercent) {
      return { shouldCompact: true, reason: "hard_limit", usage: current };
    }
    if (usagePercent >= compactionThresholdPercent) {
      return { shouldCompact: true, reason: "usage_threshold", usage: current };
    }
    return { shouldCompact: false, usage: current };
  }

  markCompacted(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.lastCompactionTurn = state.turnIndex;
    state.lastCompactionAtMs = this.now();
    state.pendingCompactionReason = undefined;
  }

  requestCompaction(sessionId: string, reason: ContextCompactionReason): void {
    const state = this.getOrCreate(sessionId);
    state.pendingCompactionReason = reason;
  }

  getPendingCompactionReason(sessionId: string): ContextCompactionReason | null {
    const state = this.sessions.get(sessionId);
    if (!state?.pendingCompactionReason) return null;
    return state.pendingCompactionReason;
  }

  snapshotSession(sessionId: string): ContextBudgetSessionState | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    return {
      turnIndex: state.turnIndex,
      lastCompactionTurn: state.lastCompactionTurn,
      lastCompactionAtMs: state.lastCompactionAtMs,
      lastContextUsage: state.lastContextUsage
        ? {
            tokens: state.lastContextUsage.tokens,
            contextWindow: state.lastContextUsage.contextWindow,
            percent: state.lastContextUsage.percent,
          }
        : undefined,
      pendingCompactionReason: state.pendingCompactionReason,
    };
  }

  restoreSession(sessionId: string, snapshot: ContextBudgetSessionState | undefined): void {
    if (!snapshot) return;
    this.sessions.set(sessionId, {
      turnIndex: snapshot.turnIndex,
      lastCompactionTurn: snapshot.lastCompactionTurn,
      lastCompactionAtMs:
        typeof snapshot.lastCompactionAtMs === "number" &&
        Number.isFinite(snapshot.lastCompactionAtMs)
          ? snapshot.lastCompactionAtMs
          : undefined,
      lastContextUsage: snapshot.lastContextUsage
        ? {
            tokens: snapshot.lastContextUsage.tokens,
            contextWindow: snapshot.lastContextUsage.contextWindow,
            percent: normalizePercent(snapshot.lastContextUsage.percent),
          }
        : undefined,
      pendingCompactionReason: snapshot.pendingCompactionReason,
    });
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getCompactionInstructions(): string {
    return this.config.compactionInstructions;
  }

  private getOrCreate(sessionId: string): SessionBudgetState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const state: SessionBudgetState = {
      turnIndex: 0,
      lastCompactionTurn: -Number.MAX_SAFE_INTEGER,
      lastCompactionAtMs: undefined,
      lastContextUsage: undefined,
    };
    this.sessions.set(sessionId, state);
    return state;
  }
}
