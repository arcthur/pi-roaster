import { resolveSkillSelectionProjection } from "@brewva/brewva-deliberation";
import type {
  BrewvaRuntime,
  ContextCompactionGateStatus,
  ContextInjectionEntry,
} from "@brewva/brewva-runtime";
import { coerceContextBudgetUsage } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { prepareContextComposerSupport } from "./context-composer-support.js";
import { buildContextComposedEventPayload, composeContextBlocks } from "./context-composer.js";
import { applyContextContract } from "./context-contract.js";
import {
  extractCompactionEntryId,
  extractCompactionSummary,
  resolveInjectionScopeId,
} from "./context-shared.js";
import { clearRuntimeTurnClock, observeRuntimeTurnStart } from "./runtime-turn-clock.js";

const CONTEXT_INJECTION_MESSAGE_TYPE = "brewva-context-injection";
const CONTEXT_COMPOSED_EVENT_TYPE = "context_composed";

export interface ContextTransformOptions {
  autoCompactionWatchdogMs?: number;
}

interface CompactionGateState {
  turnIndex: number;
  lastRuntimeGateRequired: boolean;
  autoCompactionInFlight: boolean;
  autoCompactionWatchdog: ReturnType<typeof setTimeout> | null;
  deferredAutoCompactionReason: string | null;
}

const DEFAULT_AUTO_COMPACTION_WATCHDOG_MS = 30_000;
const AUTO_COMPACTION_WATCHDOG_ERROR = "auto_compaction_watchdog_timeout";

function getOrCreateGateState(
  store: Map<string, CompactionGateState>,
  sessionId: string,
): CompactionGateState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const created: CompactionGateState = {
    turnIndex: 0,
    lastRuntimeGateRequired: false,
    autoCompactionInFlight: false,
    autoCompactionWatchdog: null,
    deferredAutoCompactionReason: null,
  };
  store.set(sessionId, created);
  return created;
}

function clearAutoCompactionState(state: CompactionGateState): void {
  state.autoCompactionInFlight = false;
  state.deferredAutoCompactionReason = null;
  if (state.autoCompactionWatchdog) {
    clearTimeout(state.autoCompactionWatchdog);
    state.autoCompactionWatchdog = null;
  }
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

function emitContextComposedEvent(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    turn: number;
    composed: ReturnType<typeof composeContextBlocks>;
    injectionAccepted: boolean;
  },
): void {
  emitRuntimeEvent(runtime, {
    sessionId: input.sessionId,
    turn: input.turn,
    type: CONTEXT_COMPOSED_EVENT_TYPE,
    payload: buildContextComposedEventPayload(input.composed, input.injectionAccepted),
  });
}

function normalizeRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return "unknown_error";
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
  entries: ContextInjectionEntry[];
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

function resolveRoutingProjection(
  runtime: BrewvaRuntime,
  sessionId: string,
): {
  selection: {
    status: string;
    reason: string;
    selectedCount: number;
    selectedSkills: string[];
  };
  error: string | null;
} {
  return resolveSkillSelectionProjection(runtime, sessionId);
}

export function registerContextTransform(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
  options: ContextTransformOptions = {},
): void {
  const gateStateBySession = new Map<string, CompactionGateState>();
  const autoCompactionWatchdogMs = Math.max(
    1,
    Math.trunc(options.autoCompactionWatchdogMs ?? DEFAULT_AUTO_COMPACTION_WATCHDOG_MS),
  );

  pi.on("turn_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const runtimeTurn = observeRuntimeTurnStart(sessionId, event.turnIndex, event.timestamp);
    state.turnIndex = runtimeTurn;
    runtime.context.onTurnStart(sessionId, runtimeTurn);
    return undefined;
  });

  pi.on("context", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    runtime.context.observeUsage(sessionId, usage);

    if (!runtime.context.checkAndRequestCompaction(sessionId, usage)) {
      return undefined;
    }

    if (ctx.hasUI) {
      // Missing UI-idle telemetry is unsafe for live-turn manual compaction.
      const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : false;
      if (!idle) {
        const pendingReason =
          runtime.context.getPendingCompactionReason(sessionId) ?? "usage_threshold";
        if (state.deferredAutoCompactionReason === pendingReason) {
          return undefined;
        }
        state.deferredAutoCompactionReason = pendingReason;
        // `ctx.compact()` maps to manual compaction and aborts the active agent run.
        // Triggering it from a live context hook can strand the current turn without auto-resume.
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "context_compaction_skipped",
          payload: {
            reason: "agent_active_manual_compaction_unsafe",
          },
        });
        return undefined;
      }
      state.deferredAutoCompactionReason = null;

      if (state.autoCompactionInFlight) {
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "context_compaction_skipped",
          payload: {
            reason: "auto_compaction_in_flight",
          },
        });
        return undefined;
      }

      const pendingReason = runtime.context.getPendingCompactionReason(sessionId);
      const compactionReason = pendingReason ?? "usage_threshold";
      state.autoCompactionInFlight = true;
      if (state.autoCompactionWatchdog) {
        clearTimeout(state.autoCompactionWatchdog);
      }
      state.autoCompactionWatchdog = setTimeout(() => {
        if (!state.autoCompactionInFlight) return;
        clearAutoCompactionState(state);
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "context_compaction_auto_failed",
          payload: {
            reason: compactionReason,
            error: AUTO_COMPACTION_WATCHDOG_ERROR,
            watchdogMs: autoCompactionWatchdogMs,
          },
        });
      }, autoCompactionWatchdogMs);

      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_auto_requested",
        payload: {
          reason: compactionReason,
          usagePercent: usage?.percent ?? null,
          tokens: usage?.tokens ?? null,
        },
      });

      const clearInFlight = () => {
        clearAutoCompactionState(state);
      };
      const recordAutoFailure = (error: unknown) => {
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "context_compaction_auto_failed",
          payload: {
            reason: compactionReason,
            error: normalizeRuntimeError(error),
          },
        });
      };

      try {
        ctx.compact({
          customInstructions: runtime.context.getCompactionInstructions(),
          onComplete: () => {
            clearInFlight();
            emitRuntimeEvent(runtime, {
              sessionId,
              turn: state.turnIndex,
              type: "context_compaction_auto_completed",
              payload: {
                reason: compactionReason,
              },
            });
          },
          onError: (error) => {
            clearInFlight();
            recordAutoFailure(error);
          },
        });
      } catch (error) {
        clearInFlight();
        recordAutoFailure(error);
      }

      return undefined;
    }

    emitRuntimeEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      type: "context_compaction_skipped",
      payload: {
        reason: "non_interactive_mode",
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
    clearAutoCompactionState(state);

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
    const state = gateStateBySession.get(sessionId);
    if (state) {
      clearAutoCompactionState(state);
    }
    gateStateBySession.delete(sessionId);
    clearRuntimeTurnClock(sessionId);
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
      reason: "hard_limit",
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

    let { gateStatus, pendingCompactionReason, capabilityView } = prepareContextComposerSupport({
      runtime,
      pi,
      sessionId,
      prompt: event.prompt,
      usage,
    });
    if (gateStatus.required) {
      emitGateEvents(gateStatus, "hard_limit");
    }
    const systemPromptWithContract = applyContextContract(
      (event as { systemPrompt?: unknown }).systemPrompt,
      runtime,
    );
    const originalPrompt = event.prompt;

    if (gateStatus.required) {
      state.lastRuntimeGateRequired = true;
      const skippedReason = "critical_compaction_gate";
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "skill_routing_selection",
        payload: {
          status: "skipped",
          reason: skippedReason,
          selectedCount: 0,
          selectedSkills: [],
          inputChars: originalPrompt.length,
          error: null,
        },
      });

      const composed = composeContextBlocks({
        runtime,
        sessionId,
        gateStatus,
        pendingCompactionReason,
        capabilityView,
        admittedEntries: [],
        injectionAccepted: false,
      });
      emitContextComposedEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        composed,
        injectionAccepted: false,
      });

      return {
        systemPrompt: systemPromptWithContract,
        message: {
          customType: CONTEXT_INJECTION_MESSAGE_TYPE,
          content: composed.content,
          display: false,
          details: {
            originalTokens: 0,
            finalTokens: 0,
            truncated: false,
            gateRequired: true,
            contextComposition: {
              narrativeRatio: composed.metrics.narrativeRatio,
              narrativeTokens: composed.metrics.narrativeTokens,
              constraintTokens: composed.metrics.constraintTokens,
              diagnosticTokens: composed.metrics.diagnosticTokens,
            },
            routingSelection: {
              status: "skipped",
              reason: skippedReason,
              selectedCount: 0,
            },
            capabilityView: {
              requested: capabilityView.requested,
              expanded: capabilityView.expanded,
              missing: capabilityView.missing,
            },
          },
        },
      };
    }

    const injection = await resolveContextInjection(runtime, {
      sessionId,
      prompt: originalPrompt,
      usage,
      injectionScopeId,
    });
    const routingProjection = resolveRoutingProjection(runtime, sessionId);
    const supportAfterInjection = prepareContextComposerSupport({
      runtime,
      pi,
      sessionId,
      prompt: originalPrompt,
      usage,
    });
    const gateStatusAfterInjection = supportAfterInjection.gateStatus;
    if (!gateStatus.required && gateStatusAfterInjection.required) {
      emitGateEvents(gateStatusAfterInjection, "hard_limit");
    }
    gateStatus = gateStatusAfterInjection;
    pendingCompactionReason = supportAfterInjection.pendingCompactionReason;
    capabilityView = supportAfterInjection.capabilityView;
    state.lastRuntimeGateRequired = gateStatus.required;

    emitRuntimeEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      type: "skill_routing_selection",
      payload: {
        status: routingProjection.selection.status,
        reason: routingProjection.selection.reason,
        selectedCount: routingProjection.selection.selectedCount,
        selectedSkills: routingProjection.selection.selectedSkills,
        inputChars: originalPrompt.length,
        error: routingProjection.error,
      },
    });

    if (pendingCompactionReason && !gateStatus.required) {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_advisory",
        payload: {
          reason: pendingCompactionReason,
          usagePercent: gateStatus.pressure.usageRatio,
          compactionThresholdPercent: gateStatus.pressure.compactionThresholdRatio,
          hardLimitPercent: gateStatus.pressure.hardLimitRatio,
          contextPressure: gateStatus.pressure.level,
          requiredTool: "session_compact",
        },
      });
    }
    const composed = composeContextBlocks({
      runtime,
      sessionId,
      gateStatus,
      pendingCompactionReason,
      capabilityView,
      admittedEntries: injection.entries,
      injectionAccepted: injection.accepted,
    });
    emitContextComposedEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      composed,
      injectionAccepted: injection.accepted,
    });

    return {
      systemPrompt: systemPromptWithContract,
      message: {
        customType: CONTEXT_INJECTION_MESSAGE_TYPE,
        content: composed.content,
        display: false,
        details: {
          originalTokens: injection.originalTokens,
          finalTokens: injection.finalTokens,
          truncated: injection.truncated,
          gateRequired: gateStatus.required,
          contextComposition: {
            narrativeRatio: composed.metrics.narrativeRatio,
            narrativeTokens: composed.metrics.narrativeTokens,
            constraintTokens: composed.metrics.constraintTokens,
            diagnosticTokens: composed.metrics.diagnosticTokens,
          },
          routingSelection: {
            status: routingProjection.selection.status,
            reason: routingProjection.selection.reason,
            selectedCount: routingProjection.selection.selectedCount,
          },
          capabilityView: {
            requested: capabilityView.requested,
            expanded: capabilityView.expanded,
            missing: capabilityView.missing,
          },
        },
      },
    };
  });
}
