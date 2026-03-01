import {
  coerceContextBudgetUsage,
  type ContextCompactionGateStatus,
  type ContextPressureStatus,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  extractCompactionEntryId,
  extractCompactionSummary,
  formatPercent,
  resolveInjectionScopeId,
} from "./context-shared.js";

const CONTEXT_INJECTION_MESSAGE_TYPE = "brewva-context-injection";
const CONTEXT_CONTRACT_MARKER = "[Brewva Context Contract]";

interface CompactionGateState {
  turnIndex: number;
  lastRuntimeGateRequired: boolean;
}

function getOrCreateGateState(
  store: Map<string, CompactionGateState>,
  sessionId: string,
): CompactionGateState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const created: CompactionGateState = {
    turnIndex: 0,
    lastRuntimeGateRequired: false,
  };
  store.set(sessionId, created);
  return created;
}

function emitRuntimeEvent(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    turn: number;
    type: string;
    payload: Record<string, unknown>;
  },
): void {
  runtime.events.record({
    sessionId: input.sessionId,
    turn: input.turn,
    type: input.type,
    payload: input.payload,
  });
}

async function resolveContextInjection(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    prompt: string;
    usage: ReturnType<typeof coerceContextBudgetUsage>;
    injectionScopeId?: string;
  },
): Promise<{
  text: string;
  accepted: boolean;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
}> {
  return runtime.context.buildInjection(
    input.sessionId,
    input.prompt,
    input.usage,
    input.injectionScopeId,
  );
}

function buildCompactionGateMessage(input: {
  pressure: ContextPressureStatus;
  reason: "hard_limit" | "floor_unmet";
}): string {
  const usagePercent = formatPercent(input.pressure.usageRatio);
  const hardLimitPercent = formatPercent(input.pressure.hardLimitRatio);
  const reasonLine =
    input.reason === "floor_unmet"
      ? "Context arena floors are unmet after planning; compaction is required to restore minimum viable context."
      : "Context pressure is critical.";
  return [
    "[ContextCompactionGate]",
    reasonLine,
    `Current usage: ${usagePercent} (hard limit: ${hardLimitPercent}).`,
    "Call tool `session_compact` immediately before any other tool call.",
  ].join("\n");
}

function buildTapeStatusBlock(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  gateStatus: ContextCompactionGateStatus;
}): string {
  const tapeStatus = input.runtime.events.getTapeStatus(input.sessionId);
  const usagePercent = formatPercent(input.gateStatus.pressure.usageRatio);
  const hardLimitPercent = formatPercent(input.gateStatus.pressure.hardLimitRatio);
  const action = input.gateStatus.required ? "session_compact_now" : "none";
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
    `context_pressure: ${input.gateStatus.pressure.level}`,
    `context_usage: ${usagePercent}`,
    `context_hard_limit: ${hardLimitPercent}`,
    `compaction_gate_reason: ${input.gateStatus.reason ?? "none"}`,
    `recent_compact_performed: ${input.gateStatus.recentCompaction ? "true" : "false"}`,
    `turns_since_compaction: ${input.gateStatus.turnsSinceCompaction ?? "none"}`,
    `recent_compaction_window_turns: ${input.gateStatus.windowTurns}`,
    `required_action: ${action}`,
  ].join("\n");
}

function buildContextContractBlock(runtime: BrewvaRuntime): string {
  const tapeThresholds = runtime.events.getTapePressureThresholds();
  const hardLimitPercent = formatPercent(runtime.context.getHardLimitRatio());
  const highThresholdPercent = formatPercent(runtime.context.getCompactionThresholdRatio());

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

function applyContextContract(systemPrompt: unknown, runtime: BrewvaRuntime): string {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  if (base.includes(CONTEXT_CONTRACT_MARKER)) {
    return base;
  }
  const contract = buildContextContractBlock(runtime);
  if (base.trim().length === 0) return contract;
  return `${base}\n\n${contract}`;
}

export function registerContextTransform(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const gateStateBySession = new Map<string, CompactionGateState>();

  pi.on("turn_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    state.turnIndex = Math.max(state.turnIndex, event.turnIndex);
    runtime.context.onTurnStart(sessionId, event.turnIndex);
    return undefined;
  });

  pi.on("context", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    runtime.context.observeUsage(sessionId, usage);

    if (!runtime.context.shouldRequestCompaction(sessionId, usage)) {
      return undefined;
    }

    emitRuntimeEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      type: "context_compaction_skipped",
      payload: {
        reason: ctx.hasUI ? "manual_compaction_required" : "non_interactive_mode",
      },
    });

    return undefined;
  });

  pi.on("session_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    const wasGated = state.lastRuntimeGateRequired;
    state.lastRuntimeGateRequired = false;

    runtime.context.markCompacted(sessionId, {
      fromTokens: null,
      toTokens: usage?.tokens ?? null,
      summary: extractCompactionSummary(event),
      entryId: extractCompactionEntryId(event),
    });
    emitRuntimeEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      type: "session_compact",
      payload: {
        entryId: event.compactionEntry.id,
        fromExtension: event.fromExtension,
      },
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

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const injectionScopeId = resolveInjectionScopeId(ctx.sessionManager);
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    runtime.context.observeUsage(sessionId, usage);
    const emitGateEvents = (
      gateStatus: ContextCompactionGateStatus,
      reason: "hard_limit" | "floor_unmet",
    ): void => {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_gate_armed",
        payload: {
          reason,
          usagePercent: gateStatus.pressure.usageRatio,
          hardLimitPercent: gateStatus.pressure.hardLimitRatio,
        },
      });
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "critical_without_compact",
        payload: {
          reason,
          usagePercent: gateStatus.pressure.usageRatio,
          hardLimitPercent: gateStatus.pressure.hardLimitRatio,
          contextPressure: gateStatus.pressure.level,
          requiredTool: "session_compact",
        },
      });
    };

    let gateStatus = runtime.context.getCompactionGateStatus(sessionId, usage);
    let gateReason: "hard_limit" | "floor_unmet" | null =
      gateStatus.reason === "floor_unmet"
        ? "floor_unmet"
        : gateStatus.required
          ? "hard_limit"
          : null;
    if (gateStatus.required && gateReason) {
      emitGateEvents(gateStatus, gateReason);
    }
    const systemPromptWithContract = applyContextContract(
      (event as { systemPrompt?: unknown }).systemPrompt,
      runtime,
    );

    const injection = await resolveContextInjection(runtime, {
      sessionId,
      prompt: event.prompt,
      usage,
      injectionScopeId,
    });
    const gateStatusAfterInjection = runtime.context.getCompactionGateStatus(sessionId, usage);
    if (!gateStatus.required && gateStatusAfterInjection.required) {
      const postInjectionReason =
        gateStatusAfterInjection.reason === "floor_unmet" ? "floor_unmet" : "hard_limit";
      emitGateEvents(gateStatusAfterInjection, postInjectionReason);
    }
    gateStatus = gateStatusAfterInjection;
    gateReason =
      gateStatus.reason === "floor_unmet"
        ? "floor_unmet"
        : gateStatus.required
          ? "hard_limit"
          : null;
    state.lastRuntimeGateRequired = gateStatus.required;

    const blocks: string[] = [
      buildTapeStatusBlock({
        runtime,
        sessionId,
        gateStatus,
      }),
    ];
    if (gateStatus.required) {
      blocks.push(
        buildCompactionGateMessage({
          pressure: gateStatus.pressure,
          reason: gateReason === "floor_unmet" ? "floor_unmet" : "hard_limit",
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
          gateRequired: gateStatus.required,
        },
      },
    };
  });
}
