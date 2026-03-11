import {
  TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  TOOL_OUTPUT_OBSERVED_EVENT_TYPE,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { persistToolOutputArtifact } from "./tool-output-artifact-store.js";
import { distillToolOutput, estimateTokens } from "./tool-output-distiller.js";

interface ToolLifecycleState {
  toolName: string;
  args?: Record<string, unknown>;
  sawResult: boolean;
}

type ToolOutcomeVerdict = "pass" | "fail" | "inconclusive";

interface ArtifactOverride {
  artifactRef: string;
  rawChars: number;
  rawBytes: number;
  sha256: string;
}

function normalizeArgs(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

function normalizeToolResultStatus(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const raw = details?.status;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeToolResultVerdict(
  details: Record<string, unknown> | undefined,
): ToolOutcomeVerdict | undefined {
  const raw = details?.verdict;
  if (raw === "pass" || raw === "fail" || raw === "inconclusive") {
    return raw;
  }
  return undefined;
}

function normalizeArtifactOverride(
  details: Record<string, unknown> | undefined,
): ArtifactOverride | undefined {
  const raw = details?.artifactOverride;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.artifactRef !== "string" || candidate.artifactRef.trim().length === 0) {
    return undefined;
  }
  if (typeof candidate.sha256 !== "string" || candidate.sha256.trim().length === 0) {
    return undefined;
  }
  if (typeof candidate.rawChars !== "number" || !Number.isFinite(candidate.rawChars)) {
    return undefined;
  }
  if (typeof candidate.rawBytes !== "number" || !Number.isFinite(candidate.rawBytes)) {
    return undefined;
  }

  return {
    artifactRef: candidate.artifactRef.trim(),
    rawChars: Math.max(0, Math.floor(candidate.rawChars)),
    rawBytes: Math.max(0, Math.floor(candidate.rawBytes)),
    sha256: candidate.sha256.trim(),
  };
}

function resolveToolOutcome(input: {
  isError: boolean;
  details: Record<string, unknown> | undefined;
}): { isError: boolean; verdict: ToolOutcomeVerdict } {
  const explicitVerdict = normalizeToolResultVerdict(input.details);
  if (explicitVerdict) {
    return {
      isError: input.isError,
      verdict: explicitVerdict,
    };
  }
  return {
    isError: input.isError,
    verdict: input.isError ? "fail" : "pass",
  };
}

function extractToolExecutionResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) return extractTextContent(content);
  const text = (result as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function getSessionLifecycleStore(
  statesBySession: Map<string, Map<string, ToolLifecycleState>>,
  sessionId: string,
): Map<string, ToolLifecycleState> {
  const existing = statesBySession.get(sessionId);
  if (existing) return existing;
  const created = new Map<string, ToolLifecycleState>();
  statesBySession.set(sessionId, created);
  return created;
}

function upsertToolLifecycleState(
  statesBySession: Map<string, Map<string, ToolLifecycleState>>,
  input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
  },
): ToolLifecycleState {
  const sessionStore = getSessionLifecycleStore(statesBySession, input.sessionId);
  const existing = sessionStore.get(input.toolCallId);
  if (existing) {
    if (input.args && Object.keys(input.args).length > 0) {
      existing.args = input.args;
    }
    if (!existing.toolName && input.toolName) {
      existing.toolName = input.toolName;
    }
    return existing;
  }

  const created: ToolLifecycleState = {
    toolName: input.toolName,
    args: input.args,
    sawResult: false,
  };
  sessionStore.set(input.toolCallId, created);
  return created;
}

function deleteToolLifecycleState(
  statesBySession: Map<string, Map<string, ToolLifecycleState>>,
  sessionId: string,
  toolCallId: string,
): void {
  const sessionStore = statesBySession.get(sessionId);
  if (!sessionStore) return;
  sessionStore.delete(toolCallId);
  if (sessionStore.size === 0) {
    statesBySession.delete(sessionId);
  }
}

const FINALIZED_TOOL_CALLS_MAX = 512;

function getFinalizedToolCalls(
  finalizedBySession: Map<string, Set<string>>,
  sessionId: string,
): Set<string> {
  const existing = finalizedBySession.get(sessionId);
  if (existing) return existing;
  const created = new Set<string>();
  finalizedBySession.set(sessionId, created);
  return created;
}

function markToolCallFinalized(
  finalizedBySession: Map<string, Set<string>>,
  sessionId: string,
  toolCallId: string,
): void {
  const finalized = getFinalizedToolCalls(finalizedBySession, sessionId);
  if (finalized.has(toolCallId)) {
    finalized.delete(toolCallId);
  }
  finalized.add(toolCallId);
  if (finalized.size <= FINALIZED_TOOL_CALLS_MAX) return;
  const oldest = finalized.values().next().value;
  if (oldest) {
    finalized.delete(oldest);
  }
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: string; text?: string } =>
        Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text",
    )
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n");
}

function buildOutputObservation(
  runtime: BrewvaRuntime,
  sessionId: string,
  outputText: string,
): {
  rawChars: number;
  rawBytes: number;
  rawTokens: number;
  contextUsagePercent: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPressure: string;
  contextHardLimitPercent: number;
  contextCompactionThresholdPercent: number;
} {
  const usage = runtime.context.getUsage(sessionId);
  const pressure = runtime.context.getPressureStatus(sessionId, usage);
  return {
    rawChars: outputText.length,
    rawBytes: Buffer.byteLength(outputText, "utf8"),
    rawTokens: estimateTokens(outputText),
    contextUsagePercent: pressure.usageRatio,
    contextTokens: typeof usage?.tokens === "number" ? usage.tokens : null,
    contextWindow: typeof usage?.contextWindow === "number" ? usage.contextWindow : null,
    contextPressure: pressure.level,
    contextHardLimitPercent: pressure.hardLimitRatio,
    contextCompactionThresholdPercent: pressure.compactionThresholdRatio,
  };
}

function resolveWorkspaceRoot(runtime: BrewvaRuntime, context: unknown): string {
  if (!context || typeof context !== "object") return runtime.cwd;
  const cwd = (context as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd : runtime.cwd;
}

function recordToolOutcome(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    context: unknown;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    isError: boolean;
    outputText: string;
    details?: Record<string, unknown>;
    verdict: "pass" | "fail" | "inconclusive";
    lifecycleFallbackReason?: string;
  },
): void {
  const artifactOverride = normalizeArtifactOverride(input.details);
  const outputArtifact =
    artifactOverride ??
    persistToolOutputArtifact({
      workspaceRoot: resolveWorkspaceRoot(runtime, input.context),
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      outputText: input.outputText,
      timestamp: Date.now(),
    });
  const outputObservation = buildOutputObservation(runtime, input.sessionId, input.outputText);
  const outputDistillation = distillToolOutput({
    toolName: input.toolName,
    isError: input.isError,
    outputText: input.outputText,
    verdict: input.verdict,
  });

  runtime.events.record({
    sessionId: input.sessionId,
    type: TOOL_OUTPUT_OBSERVED_EVENT_TYPE,
    payload: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      isError: input.isError,
      verdict: input.verdict,
      ...outputObservation,
      artifactRef: outputArtifact?.artifactRef ?? null,
    },
  });
  if (outputArtifact) {
    runtime.events.record({
      sessionId: input.sessionId,
      type: TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE,
      payload: {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        isError: input.isError,
        artifactRef: outputArtifact.artifactRef,
        rawChars: outputArtifact.rawChars,
        rawBytes: outputArtifact.rawBytes,
        sha256: outputArtifact.sha256,
      },
    });
  }
  if (outputDistillation.distillationApplied) {
    runtime.events.record({
      sessionId: input.sessionId,
      type: TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
      payload: {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        isError: input.isError,
        verdict: input.verdict,
        strategy: outputDistillation.strategy,
        rawChars: outputDistillation.rawChars,
        rawBytes: outputDistillation.rawBytes,
        rawTokens: outputDistillation.rawTokens,
        summaryChars: outputDistillation.summaryChars,
        summaryBytes: outputDistillation.summaryBytes,
        summaryTokens: outputDistillation.summaryTokens,
        compressionRatio: outputDistillation.compressionRatio,
        truncated: outputDistillation.truncated,
        summaryText: outputDistillation.summaryText,
        artifactRef: outputArtifact?.artifactRef ?? null,
      },
    });
  }

  runtime.tools.finish({
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    args: input.args,
    outputText: input.outputText,
    channelSuccess: !input.isError,
    verdict: input.verdict,
    metadata: {
      toolCallId: input.toolCallId,
      details: input.details,
      lifecycleFallbackReason: input.lifecycleFallbackReason ?? null,
      outputObservation: {
        ...outputObservation,
        artifactRef: outputArtifact?.artifactRef ?? null,
      },
      outputArtifact: outputArtifact
        ? {
            artifactRef: outputArtifact.artifactRef,
            rawChars: outputArtifact.rawChars,
            rawBytes: outputArtifact.rawBytes,
            sha256: outputArtifact.sha256,
          }
        : null,
      outputDistillation: outputDistillation.distillationApplied
        ? {
            strategy: outputDistillation.strategy,
            summaryText: outputDistillation.summaryText,
            rawTokens: outputDistillation.rawTokens,
            summaryTokens: outputDistillation.summaryTokens,
            compressionRatio: outputDistillation.compressionRatio,
            truncated: outputDistillation.truncated,
            artifactRef: outputArtifact?.artifactRef ?? null,
          }
        : null,
    },
  });
}

export function registerLedgerWriter(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const lifecycleStatesBySession = new Map<string, Map<string, ToolLifecycleState>>();
  const finalizedToolCallsBySession = new Map<string, Set<string>>();

  pi.on("tool_execution_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (getFinalizedToolCalls(finalizedToolCallsBySession, sessionId).has(event.toolCallId)) {
      return undefined;
    }
    upsertToolLifecycleState(lifecycleStatesBySession, {
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: normalizeArgs(event.args),
    });
    return undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (getFinalizedToolCalls(finalizedToolCallsBySession, sessionId).has(event.toolCallId)) {
      return undefined;
    }
    upsertToolLifecycleState(lifecycleStatesBySession, {
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: normalizeArgs(event.input),
    });
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (getFinalizedToolCalls(finalizedToolCallsBySession, sessionId).has(event.toolCallId)) {
      return undefined;
    }
    const lifecycleState = upsertToolLifecycleState(lifecycleStatesBySession, {
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: normalizeArgs(event.input),
    });
    lifecycleState.sawResult = true;
    const details = event.details as Record<string, unknown> | undefined;
    const outcome = resolveToolOutcome({
      isError: event.isError,
      details,
    });
    const outputText = extractTextContent(event.content);
    recordToolOutcome(runtime, {
      sessionId,
      context: ctx,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: lifecycleState.args ?? {},
      isError: outcome.isError,
      outputText,
      details,
      verdict: outcome.verdict,
    });
    markToolCallFinalized(finalizedToolCallsBySession, sessionId, event.toolCallId);
    deleteToolLifecycleState(lifecycleStatesBySession, sessionId, event.toolCallId);

    return undefined;
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (getFinalizedToolCalls(finalizedToolCallsBySession, sessionId).has(event.toolCallId)) {
      deleteToolLifecycleState(lifecycleStatesBySession, sessionId, event.toolCallId);
      return undefined;
    }
    const lifecycleState = upsertToolLifecycleState(lifecycleStatesBySession, {
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
    if (lifecycleState.sawResult) {
      deleteToolLifecycleState(lifecycleStatesBySession, sessionId, event.toolCallId);
      return undefined;
    }

    const resultText = extractToolExecutionResultText(event.result);
    const outputText =
      resultText.trim().length > 0
        ? resultText
        : event.isError
          ? "[ToolResultFallback] tool_execution_end reported failure before tool_result was emitted."
          : "[ToolResultFallback] tool_execution_end reported success before tool_result was emitted.";

    const rawResult =
      event.result && typeof event.result === "object" && !Array.isArray(event.result)
        ? (event.result as Record<string, unknown>)
        : undefined;
    const resultDetails =
      rawResult?.details &&
      typeof rawResult.details === "object" &&
      !Array.isArray(rawResult.details)
        ? (rawResult.details as Record<string, unknown>)
        : undefined;
    const outcome = resolveToolOutcome({
      isError: event.isError,
      details: resultDetails,
    });

    recordToolOutcome(runtime, {
      sessionId,
      context: ctx,
      toolCallId: event.toolCallId,
      toolName: lifecycleState.toolName,
      args: lifecycleState.args ?? {},
      isError: outcome.isError,
      outputText,
      details: {
        ...resultDetails,
        sourceEvent: "tool_execution_end",
        toolResultObserved: false,
        toolExecutionIsError: event.isError,
        toolExecutionResultType: typeof event.result,
        toolExecutionResultStatus: normalizeToolResultStatus(resultDetails) ?? null,
      },
      verdict: outcome.verdict,
      lifecycleFallbackReason: "tool_execution_end_without_tool_result",
    });
    markToolCallFinalized(finalizedToolCallsBySession, sessionId, event.toolCallId);
    deleteToolLifecycleState(lifecycleStatesBySession, sessionId, event.toolCallId);

    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lifecycleStatesBySession.delete(sessionId);
    finalizedToolCallsBySession.delete(sessionId);

    return undefined;
  });
}
