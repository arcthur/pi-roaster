import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type ContextBudgetUsage,
  type ContextPressureStatus,
  type RoasterRuntime,
} from "@pi-roaster/roaster-runtime";

const CONTEXT_INJECTION_MESSAGE_TYPE = "roaster-context-injection";
const CONTEXT_CONTRACT_MARKER = "[Roaster Context Contract]";

interface CompactionGateState {
  turnIndex: number;
  compactionRequired: boolean;
  lastCompactionTurn: number | null;
}

function getOrCreateGateState(store: Map<string, CompactionGateState>, sessionId: string): CompactionGateState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const created: CompactionGateState = {
    turnIndex: 0,
    compactionRequired: false,
    lastCompactionTurn: null,
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

function formatPercent(ratio: number | null): string {
  if (ratio === null) return "unknown";
  return `${(ratio * 100).toFixed(1)}%`;
}

function resolveRecentCompactionWindowTurns(runtime: RoasterRuntime): number {
  const raw = runtime.config.infrastructure.contextBudget.minTurnsBetweenCompaction;
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.floor(raw));
}

function hydrateLastCompactionTurnFromTape(
  runtime: RoasterRuntime,
  sessionId: string,
  state: CompactionGateState,
): void {
  if (state.lastCompactionTurn !== null) return;
  const latest = runtime.queryEvents(sessionId, {
    type: "context_compacted",
    last: 1,
  })[0];
  if (!latest) return;
  if (typeof latest.turn !== "number" || !Number.isFinite(latest.turn)) return;
  state.lastCompactionTurn = Math.max(0, Math.floor(latest.turn));
}

function hasRecentCompaction(
  runtime: RoasterRuntime,
  state: CompactionGateState,
): boolean {
  if (state.lastCompactionTurn === null) return false;
  const turnsSinceCompact = Math.max(0, state.turnIndex - state.lastCompactionTurn);
  return turnsSinceCompact < resolveRecentCompactionWindowTurns(runtime);
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

function buildCompactionGateMessage(input: {
  pressure: ContextPressureStatus;
}): string {
  const usagePercent = formatPercent(input.pressure.usageRatio);
  const hardLimitPercent = formatPercent(input.pressure.hardLimitRatio);
  return [
    "[ContextCompactionGate]",
    "Context pressure is critical.",
    `Current usage: ${usagePercent} (hard limit: ${hardLimitPercent}).`,
    "Call tool `session_compact` immediately before any other tool call.",
  ].join("\n");
}

function buildTapeStatusBlock(input: {
  runtime: RoasterRuntime;
  sessionId: string;
  pressure: ContextPressureStatus;
  state: CompactionGateState;
  gateRequired: boolean;
}): string {
  const tapeStatus = input.runtime.getTapeStatus(input.sessionId);
  const usagePercent = formatPercent(input.pressure.usageRatio);
  const hardLimitPercent = formatPercent(input.pressure.hardLimitRatio);
  const windowTurns = resolveRecentCompactionWindowTurns(input.runtime);
  const recentCompact = hasRecentCompaction(input.runtime, input.state);
  const contextPressure = input.pressure.level;
  const action = input.gateRequired ? "session_compact_now" : "none";
  const tapePressure = tapeStatus.tapePressure;
  const totalEntries = String(tapeStatus.totalEntries);
  const entriesSinceAnchor = String(tapeStatus.entriesSinceAnchor);
  const entriesSinceCheckpoint = String(tapeStatus.entriesSinceCheckpoint);
  const lastAnchorName = tapeStatus.lastAnchor?.name ?? "none";
  const lastAnchorId = tapeStatus.lastAnchor?.id ?? "none";

  return [
    "[TapeStatus]",
    `tape_pressure: ${tapePressure}`,
    `tape_entries_total: ${totalEntries}`,
    `tape_entries_since_anchor: ${entriesSinceAnchor}`,
    `tape_entries_since_checkpoint: ${entriesSinceCheckpoint}`,
    `last_anchor_name: ${lastAnchorName}`,
    `last_anchor_id: ${lastAnchorId}`,
    `context_pressure: ${contextPressure}`,
    `context_usage: ${usagePercent}`,
    `context_hard_limit: ${hardLimitPercent}`,
    `recent_compact_performed: ${recentCompact ? "true" : "false"}`,
    `recent_compaction_window_turns: ${windowTurns}`,
    `required_action: ${action}`,
  ].join("\n");
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function buildContextContractBlock(runtime: RoasterRuntime): string {
  const tapeThresholds = runtime.config.tape.tapePressureThresholds;
  const hardLimitPercent = formatPercent(runtime.getContextHardLimitRatio());
  const highThresholdPercent = formatPercent(
    runtime.getContextCompactionThresholdRatio(),
  );

  return [
    CONTEXT_CONTRACT_MARKER,
    "You manage two independent resources.",
    "1) State tape:",
    "- use `tape_handoff` for semantic phase boundaries and handoffs.",
    "- use `tape_info` to inspect tape/context pressure.",
    "- use `tape_search` when you need historical recall.",
    `- tape_pressure is based on entries_since_anchor (low=${tapeThresholds.low}, medium=${tapeThresholds.medium}, high=${tapeThresholds.high}).`,
    "2) Message buffer (LLM context window):",
    "- use `session_compact` to reduce message history tokens.",
    `- context_pressure >= high (${highThresholdPercent}) means compact soon.`,
    `- context_pressure == critical (${hardLimitPercent}) means compact immediately.`,
    "Hard rules:",
    "- `tape_handoff` does not reduce message tokens.",
    "- `session_compact` does not change tape state semantics.",
    "- if context pressure is critical without recent compaction, runtime blocks non-`session_compact` tools.",
  ].join("\n");
}

function applyContextContract(systemPrompt: unknown, runtime: RoasterRuntime): string {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  if (base.includes(CONTEXT_CONTRACT_MARKER)) {
    return base;
  }
  const contract = buildContextContractBlock(runtime);
  if (base.trim().length === 0) return contract;
  return `${base}\n\n${contract}`;
}

export function registerContextTransform(pi: ExtensionAPI, runtime: RoasterRuntime): void {
  const gateStateBySession = new Map<string, CompactionGateState>();

  pi.on("turn_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    state.turnIndex = Math.max(state.turnIndex, event.turnIndex);
    runtime.onTurnStart(sessionId, event.turnIndex);
    return undefined;
  });

  pi.on("context", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const usage = toBudgetUsage(ctx.getContextUsage());
    runtime.observeContextUsage(sessionId, usage);

    if (!runtime.shouldRequestCompaction(sessionId, usage)) {
      return undefined;
    }

    if (ctx.hasUI === false) {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_skipped",
        payload: {
          reason: "non_interactive_mode",
        },
      });
    }

    return undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    hydrateLastCompactionTurnFromTape(runtime, sessionId, state);
    if (!state.compactionRequired) {
      return undefined;
    }

    if (normalizeToolName(event.toolName) === "session_compact") {
      return undefined;
    }

    emitRuntimeEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      type: "context_compaction_gate_blocked_tool",
      payload: {
        blockedTool: event.toolName,
        reason: "critical_context_pressure_without_compaction",
      },
    });

    return {
      block: true,
      reason:
        "Context usage is critical. Call tool 'session_compact' first, then continue with other tools.",
    };
  });

  pi.on("session_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const usage = toBudgetUsage(ctx.getContextUsage());
    const wasGated = state.compactionRequired;
    state.lastCompactionTurn = state.turnIndex;
    state.compactionRequired = false;

    runtime.markContextCompacted(sessionId, {
      fromTokens: null,
      toTokens: usage?.tokens ?? null,
      summary: extractCompactionSummary(event),
      entryId: extractCompactionEntryId(event),
    });

    if (wasGated) {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_gate_cleared",
        payload: {
          reason: "session_compact_performed",
        },
      });
    }
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    gateStateBySession.delete(sessionId);
    return undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    hydrateLastCompactionTurnFromTape(runtime, sessionId, state);
    const injectionScopeId = resolveInjectionScopeId(ctx.sessionManager);
    const usage = toBudgetUsage(ctx.getContextUsage());
    runtime.observeContextUsage(sessionId, usage);
    const pressure = runtime.getContextPressureStatus(sessionId, usage);

    const gateRequired =
      runtime.config.infrastructure.contextBudget.enabled &&
      pressure.level === "critical" &&
      !hasRecentCompaction(runtime, state);
    state.compactionRequired = gateRequired;
    const systemPromptWithContract = applyContextContract(
      (event as { systemPrompt?: unknown }).systemPrompt,
      runtime,
    );

    if (gateRequired) {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_gate_armed",
        payload: {
          usagePercent: pressure.usageRatio,
          hardLimitPercent: pressure.hardLimitRatio,
        },
      });
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "critical_without_compact",
        payload: {
          usagePercent: pressure.usageRatio,
          hardLimitPercent: pressure.hardLimitRatio,
          contextPressure: pressure.level,
          requiredTool: "session_compact",
        },
      });
    }

    const injection = runtime.buildContextInjection(sessionId, event.prompt, usage, injectionScopeId);
    const blocks: string[] = [
      buildTapeStatusBlock({
        runtime,
        sessionId,
        pressure,
        state,
        gateRequired,
      }),
    ];
    if (gateRequired) {
      blocks.push(
        buildCompactionGateMessage({
          pressure,
        }),
      );
    }
    if (injection.accepted && injection.text.trim().length > 0) {
      blocks.push(injection.text);
    }

    return {
      systemPrompt: systemPromptWithContract,
      message: {
        customType: CONTEXT_INJECTION_MESSAGE_TYPE,
        content: blocks.join("\n\n"),
        display: false,
        details: {
          originalTokens: injection.originalTokens,
          finalTokens: injection.finalTokens,
          truncated: injection.truncated,
          gateRequired,
        },
      },
    };
  });
}
