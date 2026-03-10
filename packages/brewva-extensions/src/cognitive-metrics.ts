import {
  COGNITIVE_METRIC_FIRST_PRODUCTIVE_ACTION_EVENT_TYPE,
  COGNITIVE_METRIC_REHYDRATION_USEFULNESS_EVENT_TYPE,
  COGNITIVE_METRIC_RESUMPTION_PROGRESS_EVENT_TYPE,
  MEMORY_EPISODE_REHYDRATED_EVENT_TYPE,
  MEMORY_OPEN_LOOP_REHYDRATED_EVENT_TYPE,
  MEMORY_PROCEDURE_REHYDRATED_EVENT_TYPE,
  MEMORY_REFERENCE_REHYDRATED_EVENT_TYPE,
  MEMORY_SUMMARY_REHYDRATED_EVENT_TYPE,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import { getBrewvaToolSurface } from "@brewva/brewva-tools";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { normalizeOptionalString } from "./context-shared.js";
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
const REHYDRATION_EVENT_TYPES = new Set<string>([
  MEMORY_PROCEDURE_REHYDRATED_EVENT_TYPE,
  MEMORY_REFERENCE_REHYDRATED_EVENT_TYPE,
  MEMORY_SUMMARY_REHYDRATED_EVENT_TYPE,
  MEMORY_EPISODE_REHYDRATED_EVENT_TYPE,
  MEMORY_OPEN_LOOP_REHYDRATED_EVENT_TYPE,
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
const MAX_TRACKED_TOOL_CALL_IDS = 256;
const MAX_TRACKED_REHYDRATION_EVENT_IDS = 128;

interface MetricState {
  firstProductiveRecorded: boolean;
  processedToolCallIds: Set<string>;
  processedToolCallOrder: string[];
  seenRehydrationEventIds: Set<string>;
  seenRehydrationEventOrder: string[];
  pendingResumeAnchorTurn: number | null;
  pendingRehydrations: RehydrationSignal[];
}

interface ToolResultRecordedPayload {
  toolCallId?: string;
  toolName?: string;
  verdict?: string;
}

interface RehydrationSignal {
  kind: string;
  packetKey: string | null;
  artifactRef: string | null;
}

interface RehydrationEventPayload {
  packetKey?: string;
  artifactRef?: string;
}

function getOrCreateState(store: Map<string, MetricState>, sessionId: string): MetricState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const created: MetricState = {
    firstProductiveRecorded: false,
    processedToolCallIds: new Set<string>(),
    processedToolCallOrder: [],
    seenRehydrationEventIds: new Set<string>(),
    seenRehydrationEventOrder: [],
    pendingResumeAnchorTurn: null,
    pendingRehydrations: [],
  };
  store.set(sessionId, created);
  return created;
}

function rememberBoundedId(
  set: Set<string>,
  order: string[],
  value: string,
  maxSize: number,
): void {
  if (set.has(value)) {
    return;
  }
  set.add(value);
  order.push(value);
  while (order.length > maxSize) {
    const removed = order.shift();
    if (removed) {
      set.delete(removed);
    }
  }
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
  if (type === MEMORY_PROCEDURE_REHYDRATED_EVENT_TYPE) return "procedure";
  if (type === MEMORY_REFERENCE_REHYDRATED_EVENT_TYPE) return "reference";
  if (type === MEMORY_SUMMARY_REHYDRATED_EVENT_TYPE) return "summary";
  if (type === MEMORY_EPISODE_REHYDRATED_EVENT_TYPE) return "episode";
  if (type === MEMORY_OPEN_LOOP_REHYDRATED_EVENT_TYPE) return "open_loop";
  return "unknown";
}

function summarizeRehydrationKinds(rehydrations: RehydrationSignal[]): string[] {
  return [...new Set(rehydrations.map((rehydration) => rehydration.kind))];
}

function extractRehydrationSignal(
  type: string,
  payload: RehydrationEventPayload | undefined,
): RehydrationSignal {
  return {
    kind: normalizeRehydrationKind(type),
    packetKey: normalizeOptionalString(payload?.packetKey),
    artifactRef: normalizeOptionalString(payload?.artifactRef),
  };
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
      rehydrationKinds: summarizeRehydrationKinds(state.pendingRehydrations),
      rehydrationPackets: state.pendingRehydrations.map((rehydration) => ({
        kind: rehydration.kind,
        packetKey: rehydration.packetKey,
        artifactRef: rehydration.artifactRef,
      })),
      toolName: input.toolName ?? null,
    },
  });
  state.pendingResumeAnchorTurn = null;
  state.pendingRehydrations = [];
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
  const freshRehydrations: RehydrationSignal[] = [];
  for (const event of events) {
    if (!REHYDRATION_EVENT_TYPES.has(event.type)) continue;
    if (state.seenRehydrationEventIds.has(event.id)) continue;
    rememberBoundedId(
      state.seenRehydrationEventIds,
      state.seenRehydrationEventOrder,
      event.id,
      MAX_TRACKED_REHYDRATION_EVENT_IDS,
    );
    freshRehydrations.push(
      extractRehydrationSignal(event.type, event.payload as RehydrationEventPayload | undefined),
    );
  }
  if (freshRehydrations.length === 0) {
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
  state.pendingRehydrations = freshRehydrations;
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
        rehydrationKinds: summarizeRehydrationKinds(state.pendingRehydrations),
        rehydrationPackets: state.pendingRehydrations.map((rehydration) => ({
          kind: rehydration.kind,
          packetKey: rehydration.packetKey,
          artifactRef: rehydration.artifactRef,
        })),
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
  rememberBoundedId(
    state.processedToolCallIds,
    state.processedToolCallOrder,
    toolCallId,
    MAX_TRACKED_TOOL_CALL_IDS,
  );
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
