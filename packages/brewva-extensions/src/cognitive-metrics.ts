import {
  COGNITIVE_METRIC_FIRST_PRODUCTIVE_ACTION_EVENT_TYPE,
  COGNITIVE_METRIC_REHYDRATION_USEFULNESS_EVENT_TYPE,
  COGNITIVE_METRIC_RESUMPTION_PROGRESS_EVENT_TYPE,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import { getBrewvaToolSurface } from "@brewva/brewva-tools";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  clearRuntimeTurnClock,
  getCurrentRuntimeTurn,
  observeRuntimeTurnStart,
} from "./runtime-turn-clock.js";

// These metrics observe the cognitive product plane from the control plane.
// They do not create model-facing context and they do not alter kernel
// commitments; they only derive outcome telemetry from replayable evidence.
const FIRST_PRODUCTIVE_ACTION_EVENT_TYPE = COGNITIVE_METRIC_FIRST_PRODUCTIVE_ACTION_EVENT_TYPE;
const RESUMPTION_PROGRESS_EVENT_TYPE = COGNITIVE_METRIC_RESUMPTION_PROGRESS_EVENT_TYPE;
const REHYDRATION_USEFULNESS_EVENT_TYPE = COGNITIVE_METRIC_REHYDRATION_USEFULNESS_EVENT_TYPE;
const REHYDRATION_EVENT_TYPES = new Set([
  "memory_reference_rehydrated",
  "memory_summary_rehydrated",
  "memory_open_loop_rehydrated",
]);
const NON_PRODUCTIVE_TOOL_NAMES = new Set([
  "cost_view",
  "obs_query",
  "obs_slo_assert",
  "obs_snapshot",
  "session_compact",
  "tape_handoff",
  "tape_info",
  "tape_search",
]);

interface MetricState {
  firstProductiveRecorded: boolean;
  processedToolCallIds: Set<string>;
  seenRehydrationEventIds: Set<string>;
  pendingResumeAnchorTurn: number | null;
  pendingRehydrationKinds: string[];
}

interface ToolResultRecordedPayload {
  toolCallId?: string;
  toolName?: string;
  verdict?: string;
}

function getOrCreateState(store: Map<string, MetricState>, sessionId: string): MetricState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const created: MetricState = {
    firstProductiveRecorded: false,
    processedToolCallIds: new Set<string>(),
    seenRehydrationEventIds: new Set<string>(),
    pendingResumeAnchorTurn: null,
    pendingRehydrationKinds: [],
  };
  store.set(sessionId, created);
  return created;
}

function isProductiveTool(toolName: string | undefined): boolean {
  if (typeof toolName !== "string" || toolName.trim().length === 0) {
    return false;
  }
  const normalized = toolName.trim().toLowerCase();
  if (NON_PRODUCTIVE_TOOL_NAMES.has(normalized)) {
    return false;
  }
  return getBrewvaToolSurface(normalized) !== "operator";
}

function normalizeRehydrationKind(type: string): string {
  if (type === "memory_reference_rehydrated") return "reference";
  if (type === "memory_summary_rehydrated") return "summary";
  if (type === "memory_open_loop_rehydrated") return "open_loop";
  return "unknown";
}

function extractLatestRecordedToolResult(
  runtime: BrewvaRuntime,
  sessionId: string,
  toolCallId: string,
): ToolResultRecordedPayload | null {
  const events = runtime.events.query(sessionId, {
    type: "tool_result_recorded",
    last: 6,
  });
  for (const event of events.toReversed()) {
    const payload = event.payload as ToolResultRecordedPayload | undefined;
    if (payload?.toolCallId === toolCallId) {
      return payload;
    }
  }
  return null;
}

function recordRehydrationUsefulness(
  runtime: BrewvaRuntime,
  sessionId: string,
  state: MetricState,
  input: {
    useful: boolean;
    reason: "productive_action" | "window_elapsed" | "session_shutdown";
    turnIndex: number;
    toolName?: string;
  },
): void {
  if (state.pendingResumeAnchorTurn === null) {
    return;
  }
  const turnsFromResume = Math.max(1, input.turnIndex - state.pendingResumeAnchorTurn + 1);
  runtime.events.record({
    sessionId,
    type: REHYDRATION_USEFULNESS_EVENT_TYPE,
    turn: input.turnIndex,
    payload: {
      useful: input.useful,
      reason: input.reason,
      turnsFromResume,
      rehydrationKinds: [...state.pendingRehydrationKinds],
      toolName: input.toolName ?? null,
    },
  });
  state.pendingResumeAnchorTurn = null;
  state.pendingRehydrationKinds = [];
}

function maybeFlushExpiredRehydrationWindow(
  runtime: BrewvaRuntime,
  sessionId: string,
  state: MetricState,
  currentTurn: number,
): void {
  if (state.pendingResumeAnchorTurn === null) {
    return;
  }
  if (currentTurn <= state.pendingResumeAnchorTurn + 1) {
    return;
  }
  recordRehydrationUsefulness(runtime, sessionId, state, {
    useful: false,
    reason: "window_elapsed",
    turnIndex: currentTurn,
  });
}

function refreshResumeAnchor(runtime: BrewvaRuntime, sessionId: string, state: MetricState): void {
  const events = runtime.events.query(sessionId, { last: 16 });
  const freshKinds: string[] = [];
  for (const event of events) {
    if (!REHYDRATION_EVENT_TYPES.has(event.type)) continue;
    if (state.seenRehydrationEventIds.has(event.id)) continue;
    state.seenRehydrationEventIds.add(event.id);
    freshKinds.push(normalizeRehydrationKind(event.type));
  }
  if (freshKinds.length === 0) {
    return;
  }
  const currentTurn = getCurrentRuntimeTurn(sessionId);
  if (state.pendingResumeAnchorTurn !== null) {
    recordRehydrationUsefulness(runtime, sessionId, state, {
      useful: false,
      reason: "window_elapsed",
      turnIndex: currentTurn,
    });
  }
  state.pendingResumeAnchorTurn = currentTurn;
  state.pendingRehydrationKinds = [...new Set(freshKinds)];
}

function recordProductiveToolMetrics(
  runtime: BrewvaRuntime,
  sessionId: string,
  state: MetricState,
  payload: ToolResultRecordedPayload,
): void {
  const toolName =
    typeof payload.toolName === "string" ? payload.toolName.trim().toLowerCase() : "";
  if (!toolName || payload.verdict !== "pass" || !isProductiveTool(toolName)) {
    return;
  }
  const currentTurn = getCurrentRuntimeTurn(sessionId);
  const turnIndex = currentTurn + 1;
  const toolSurface = getBrewvaToolSurface(toolName) ?? "external";

  if (!state.firstProductiveRecorded) {
    runtime.events.record({
      sessionId,
      type: FIRST_PRODUCTIVE_ACTION_EVENT_TYPE,
      turn: currentTurn,
      payload: {
        turnIndex,
        toolName,
        toolSurface,
      },
    });
    state.firstProductiveRecorded = true;
  }

  if (state.pendingResumeAnchorTurn !== null) {
    const turnsFromResume = Math.max(1, currentTurn - state.pendingResumeAnchorTurn + 1);
    runtime.events.record({
      sessionId,
      type: RESUMPTION_PROGRESS_EVENT_TYPE,
      turn: currentTurn,
      payload: {
        turnIndex,
        turnsFromResume,
        toolName,
        toolSurface,
        rehydrationKinds: [...state.pendingRehydrationKinds],
      },
    });
    recordRehydrationUsefulness(runtime, sessionId, state, {
      useful: turnsFromResume <= 2,
      reason: "productive_action",
      turnIndex: currentTurn,
      toolName,
    });
  }
}

function processRecordedToolResult(
  runtime: BrewvaRuntime,
  sessionId: string,
  state: MetricState,
  toolCallId: string | undefined,
): void {
  if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) {
    return;
  }
  if (state.processedToolCallIds.has(toolCallId)) {
    return;
  }
  const payload = extractLatestRecordedToolResult(runtime, sessionId, toolCallId);
  if (!payload) {
    return;
  }
  state.processedToolCallIds.add(toolCallId);
  recordProductiveToolMetrics(runtime, sessionId, state, payload);
}

export function registerCognitiveMetrics(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const stateBySession = new Map<string, MetricState>();

  pi.on("session_start", (_event, ctx) => {
    getOrCreateState(stateBySession, ctx.sessionManager.getSessionId());
    return undefined;
  });

  pi.on("turn_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateState(stateBySession, sessionId);
    const currentTurn = observeRuntimeTurnStart(sessionId, event.turnIndex, event.timestamp);
    maybeFlushExpiredRehydrationWindow(runtime, sessionId, state, currentTurn);
    return undefined;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateState(stateBySession, sessionId);
    refreshResumeAnchor(runtime, sessionId, state);
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateState(stateBySession, sessionId);
    processRecordedToolResult(
      runtime,
      sessionId,
      state,
      typeof event.toolCallId === "string" ? event.toolCallId : undefined,
    );
    return undefined;
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateState(stateBySession, sessionId);
    processRecordedToolResult(
      runtime,
      sessionId,
      state,
      typeof event.toolCallId === "string" ? event.toolCallId : undefined,
    );
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = stateBySession.get(sessionId);
    if (state) {
      recordRehydrationUsefulness(runtime, sessionId, state, {
        useful: false,
        reason: "session_shutdown",
        turnIndex: getCurrentRuntimeTurn(sessionId),
      });
    }
    stateBySession.delete(sessionId);
    clearRuntimeTurnClock(sessionId);
    return undefined;
  });
}
