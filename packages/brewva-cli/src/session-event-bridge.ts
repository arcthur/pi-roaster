import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";

type SessionLike = {
  sessionManager: {
    getSessionId(): string;
  };
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function maybeRecordAssistantUsage(
  runtime: BrewvaRuntime,
  sessionId: string,
  message: unknown,
): void {
  if (!isRecord(message)) return;
  if (message.role !== "assistant") return;

  const usage = message.usage;
  if (!isRecord(usage)) return;

  const provider =
    typeof message.provider === "string" ? message.provider : undefined;
  const modelName = typeof message.model === "string" ? message.model : undefined;
  const model = provider && modelName ? `${provider}/${modelName}` : modelName ?? "unknown";
  const stopReason =
    typeof message.stopReason === "string" ? message.stopReason : undefined;

  runtime.recordAssistantUsage({
    sessionId,
    model,
    inputTokens: numberOrZero(usage.input),
    outputTokens: numberOrZero(usage.output),
    cacheReadTokens: numberOrZero(usage.cacheRead),
    cacheWriteTokens: numberOrZero(usage.cacheWrite),
    totalTokens: numberOrZero(usage.totalTokens),
    costUsd: isRecord(usage.cost) ? numberOrZero(usage.cost.total) : 0,
    stopReason,
  });
}

export function registerRuntimeCoreEventBridge(
  runtime: BrewvaRuntime,
  session: SessionLike,
): () => void {
  let turnIndex = 0;

  return session.subscribe((event) => {
    const sessionId = session.sessionManager.getSessionId();

    switch (event.type) {
      case "agent_start":
        turnIndex = 0;
        runtime.recordEvent({
          sessionId,
          type: "agent_start",
        });
        break;
      case "turn_start":
        runtime.onTurnStart(sessionId, turnIndex);
        runtime.recordEvent({
          sessionId,
          type: "turn_start",
          turn: turnIndex,
        });
        break;
      case "turn_end": {
        const toolResults = Array.isArray((event as { toolResults?: unknown }).toolResults)
          ? (event as { toolResults: unknown[] }).toolResults.length
          : 0;
        runtime.recordEvent({
          sessionId,
          type: "turn_end",
          turn: turnIndex,
          payload: { toolResults },
        });
        turnIndex += 1;
        break;
      }
      case "message_end":
        maybeRecordAssistantUsage(
          runtime,
          sessionId,
          (event as { message?: unknown }).message,
        );
        break;
      case "agent_end": {
        const messages = (event as { messages?: unknown }).messages;
        const messageCount = Array.isArray(messages) ? messages.length : 0;
        runtime.recordEvent({
          sessionId,
          type: "agent_end",
          payload: {
            messageCount,
            costSummary: runtime.getCostSummary(sessionId),
          },
        });
        break;
      }
      default:
        break;
    }
  });
}
