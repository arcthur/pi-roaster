function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface AssistantUsageRecorder {
  recordAssistantUsage(input: {
    sessionId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
    stopReason?: string;
  }): void;
}

export function recordAssistantUsageFromMessage(
  runtime: AssistantUsageRecorder,
  sessionId: string,
  message: unknown,
): void {
  if (!isRecord(message)) return;
  if (message.role !== "assistant") return;

  const usage = message.usage;
  if (!isRecord(usage)) return;

  const provider = typeof message.provider === "string" ? message.provider : undefined;
  const modelName = typeof message.model === "string" ? message.model : undefined;
  const model = provider && modelName ? `${provider}/${modelName}` : (modelName ?? "unknown");
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;

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
