import {
  TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  TOOL_OUTPUT_OBSERVED_EVENT_TYPE,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { persistToolOutputArtifact } from "./tool-output-artifact-store.js";
import { distillToolOutput, estimateTokens } from "./tool-output-distiller.js";

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

export function registerLedgerWriter(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  pi.on("tool_result", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const outputText = extractTextContent(event.content);
    const outputArtifact = persistToolOutputArtifact({
      workspaceRoot: resolveWorkspaceRoot(runtime, ctx),
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      outputText,
      timestamp: Date.now(),
    });
    const outputObservation = buildOutputObservation(runtime, sessionId, outputText);
    const outputDistillation = distillToolOutput({
      toolName: event.toolName,
      isError: event.isError,
      outputText,
    });

    runtime.events.record({
      sessionId,
      type: TOOL_OUTPUT_OBSERVED_EVENT_TYPE,
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        ...outputObservation,
        artifactRef: outputArtifact?.artifactRef ?? null,
      },
    });
    if (outputArtifact) {
      runtime.events.record({
        sessionId,
        type: TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE,
        payload: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          artifactRef: outputArtifact.artifactRef,
          rawChars: outputArtifact.rawChars,
          rawBytes: outputArtifact.rawBytes,
          sha256: outputArtifact.sha256,
        },
      });
    }
    if (outputDistillation.distillationApplied) {
      runtime.events.record({
        sessionId,
        type: TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
        payload: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
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
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.input,
      outputText,
      success: !event.isError,
      verdict: event.isError ? "fail" : "pass",
      metadata: {
        toolCallId: event.toolCallId,
        details: event.details as Record<string, unknown> | undefined,
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

    return undefined;
  });
}
