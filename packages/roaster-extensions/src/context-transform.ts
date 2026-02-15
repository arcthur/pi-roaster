import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type ContextBudgetUsage, type RoasterRuntime } from "@pi-roaster/roaster-runtime";

const CONTEXT_INJECTION_MESSAGE_TYPE = "roaster-context-injection";
type CompactionCircuitBreakerConfig = RoasterRuntime["config"]["infrastructure"]["contextBudget"]["compactionCircuitBreaker"];

interface CompactionCircuitState {
  turnIndex: number;
  consecutiveFailures: number;
  pendingRequestTurn: number | null;
  openUntilTurn: number | null;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return "unknown_error";
}

function getOrCreateCircuitState(store: Map<string, CompactionCircuitState>, sessionId: string): CompactionCircuitState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const created: CompactionCircuitState = {
    turnIndex: 0,
    consecutiveFailures: 0,
    pendingRequestTurn: null,
    openUntilTurn: null,
  };
  store.set(sessionId, created);
  return created;
}

function emitRuntimeEvent(
  runtime: RoasterRuntime,
  input: {
    sessionId: string;
    turn: number;
    type: string;
    payload: Record<string, unknown>;
  },
): void {
  runtime.recordEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    type: input.type,
    payload: input.payload,
  });
}

function markFailure(
  runtime: RoasterRuntime,
  state: CompactionCircuitState,
  breaker: CompactionCircuitBreakerConfig,
  sessionId: string,
  reason: "missing_session_compact" | "compact_call_failed",
  details?: Record<string, unknown>,
): void {
  if (!breaker.enabled) return;
  state.consecutiveFailures += 1;

  if (state.consecutiveFailures < breaker.maxConsecutiveFailures) {
    return;
  }

  state.openUntilTurn = state.turnIndex + breaker.cooldownTurns - 1;
  state.consecutiveFailures = 0;

  emitRuntimeEvent(runtime, {
    sessionId,
    turn: state.turnIndex,
    type: "context_compaction_breaker_opened",
    payload: {
      reason,
      cooldownTurns: breaker.cooldownTurns,
      openUntilTurn: state.openUntilTurn,
      ...details,
    },
  });
}

function isCircuitOpen(state: CompactionCircuitState): boolean {
  return state.openUntilTurn !== null && state.turnIndex <= state.openUntilTurn;
}

function toBudgetUsage(input: unknown): ContextBudgetUsage | undefined {
  const usage = input as { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  if (!usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) {
    return undefined;
  }
  return {
    tokens: typeof usage.tokens === "number" ? usage.tokens : null,
    contextWindow: usage.contextWindow,
    percent: typeof usage.percent === "number" ? usage.percent : null,
  };
}

function extractCompactionSummary(input: unknown): string | undefined {
  const event = input as
    | {
        compactionEntry?: {
          summary?: unknown;
          content?: unknown;
          text?: unknown;
        };
      }
    | undefined;
  const entry = event?.compactionEntry;
  if (!entry) return undefined;

  const candidates = [entry.summary, entry.content, entry.text];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const normalized = candidate.trim();
      if (normalized.length > 0) return normalized;
    }
  }
  return undefined;
}

function extractCompactionEntryId(input: unknown): string | undefined {
  const event = input as
    | {
        compactionEntry?: {
          id?: unknown;
        };
      }
    | undefined;
  const id = event?.compactionEntry?.id;
  if (typeof id !== "string") return undefined;
  const normalized = id.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveInjectionScopeId(input: unknown): string | undefined {
  const sessionManager = input as { getLeafId?: (() => string | null | undefined) | undefined } | undefined;
  const leafId = sessionManager?.getLeafId?.();
  if (typeof leafId !== "string") return undefined;
  const normalized = leafId.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function registerContextTransform(pi: ExtensionAPI, runtime: RoasterRuntime): void {
  const compactionBreaker = runtime.config.infrastructure.contextBudget.compactionCircuitBreaker;
  const compactionCircuitBySession = new Map<string, CompactionCircuitState>();

  pi.on("turn_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateCircuitState(compactionCircuitBySession, sessionId);
    state.turnIndex = Math.max(state.turnIndex, event.turnIndex);
    if (state.openUntilTurn !== null && state.turnIndex > state.openUntilTurn) {
      state.openUntilTurn = null;
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_breaker_closed",
        payload: {
          reason: "cooldown_elapsed",
        },
      });
    }
    runtime.onTurnStart(sessionId, event.turnIndex);
    return undefined;
  });

  pi.on("context", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateCircuitState(compactionCircuitBySession, sessionId);
    const usage = toBudgetUsage(ctx.getContextUsage());
    runtime.observeContextUsage(sessionId, usage);

    if (state.pendingRequestTurn !== null && state.turnIndex > state.pendingRequestTurn) {
      state.pendingRequestTurn = null;
      markFailure(runtime, state, compactionBreaker, sessionId, "missing_session_compact");
    }

    if (!runtime.shouldRequestCompaction(sessionId, usage)) {
      return undefined;
    }

    if (isCircuitOpen(state)) {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_skipped",
        payload: {
          reason: "circuit_open",
          openUntilTurn: state.openUntilTurn,
        },
      });
      return undefined;
    }

    try {
      ctx.compact({
        customInstructions: runtime.contextBudget.getCompactionInstructions(),
      });
      state.pendingRequestTurn = state.turnIndex;
    } catch (error) {
      state.pendingRequestTurn = null;
      markFailure(runtime, state, compactionBreaker, sessionId, "compact_call_failed", {
        error: normalizeErrorMessage(error),
      });
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_skipped",
        payload: {
          reason: "compact_call_failed",
          error: normalizeErrorMessage(error),
        },
      });
    }
    return undefined;
  });

  pi.on("session_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateCircuitState(compactionCircuitBySession, sessionId);
    const wasOpen = state.openUntilTurn !== null;
    state.pendingRequestTurn = null;
    state.consecutiveFailures = 0;
    state.openUntilTurn = null;
    const usage = toBudgetUsage(ctx.getContextUsage());
    runtime.markContextCompacted(sessionId, {
      fromTokens: null,
      toTokens: usage?.tokens ?? null,
      summary: extractCompactionSummary(event),
      entryId: extractCompactionEntryId(event),
    });
    if (wasOpen) {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_breaker_closed",
        payload: {
          reason: "compaction_succeeded",
        },
      });
    }
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    compactionCircuitBySession.delete(sessionId);
    return undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const injectionScopeId = resolveInjectionScopeId(ctx.sessionManager);
    const usage = toBudgetUsage(ctx.getContextUsage());
    const injection = runtime.buildContextInjection(sessionId, event.prompt, usage, injectionScopeId);
    if (!injection.accepted) {
      return undefined;
    }
    return {
      message: {
        customType: CONTEXT_INJECTION_MESSAGE_TYPE,
        content: injection.text,
        display: false,
        details: {
          originalTokens: injection.originalTokens,
          finalTokens: injection.finalTokens,
          truncated: injection.truncated,
        },
      },
    };
  });
}
