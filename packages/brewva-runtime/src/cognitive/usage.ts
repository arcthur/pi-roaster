import type { CognitiveRankOutput, CognitiveTokenBudgetStatus, CognitiveUsage } from "./port.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, value);
}

function readOptionalModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readRankScores(value: unknown): CognitiveRankOutput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is CognitiveRankOutput =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        entry.id.trim().length > 0 &&
        typeof entry.score === "number" &&
        Number.isFinite(entry.score),
    )
    .map((entry) => ({
      id: entry.id.trim(),
      score: entry.score,
    }));
}

export function normalizeCognitiveUsage(value: unknown): CognitiveUsage | null {
  if (!isRecord(value)) return null;

  const model = readOptionalModel(value.model);
  const inputTokens = readNonNegativeNumber(value.inputTokens);
  const outputTokens = readNonNegativeNumber(value.outputTokens);
  const explicitTotalTokens = readNonNegativeNumber(value.totalTokens);
  const costUsd = readNonNegativeNumber(value.costUsd);
  const inferredTotalTokens =
    explicitTotalTokens ??
    (inputTokens !== null || outputTokens !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null);

  if (
    model === undefined &&
    inputTokens === null &&
    outputTokens === null &&
    inferredTotalTokens === null &&
    costUsd === null
  ) {
    return null;
  }

  const normalized: CognitiveUsage = {};
  if (model !== undefined) normalized.model = model;
  if (inputTokens !== null) normalized.inputTokens = inputTokens;
  if (outputTokens !== null) normalized.outputTokens = outputTokens;
  if (inferredTotalTokens !== null) normalized.totalTokens = inferredTotalTokens;
  if (costUsd !== null) normalized.costUsd = costUsd;
  return normalized;
}

export function normalizeCognitiveRankResult(value: unknown): {
  scores: CognitiveRankOutput[];
  usage: CognitiveUsage | null;
} {
  if (Array.isArray(value)) {
    return {
      scores: readRankScores(value),
      usage: null,
    };
  }
  if (!isRecord(value)) {
    return {
      scores: [],
      usage: null,
    };
  }
  const scores = readRankScores(value.scores ?? value.ranking);
  return {
    scores,
    usage: normalizeCognitiveUsage(value.usage),
  };
}

export function cognitiveUsagePayload(
  usage: CognitiveUsage | null | undefined,
): Record<string, unknown> | null {
  if (!usage) return null;
  const payload: Record<string, unknown> = {};
  if (typeof usage.model === "string" && usage.model.trim().length > 0) {
    payload.model = usage.model.trim();
  }
  const inputTokens = readNonNegativeNumber(usage.inputTokens);
  if (inputTokens !== null) payload.inputTokens = inputTokens;
  const outputTokens = readNonNegativeNumber(usage.outputTokens);
  if (outputTokens !== null) payload.outputTokens = outputTokens;
  const totalTokens = readNonNegativeNumber(usage.totalTokens);
  if (totalTokens !== null) payload.totalTokens = totalTokens;
  const costUsd = readNonNegativeNumber(usage.costUsd);
  if (costUsd !== null) payload.costUsd = costUsd;
  return Object.keys(payload).length > 0 ? payload : null;
}

export function cognitiveBudgetPayload(
  budget: CognitiveTokenBudgetStatus | null | undefined,
): Record<string, unknown> | null {
  if (!budget) return null;
  return {
    maxTokensPerTurn: budget.maxTokensPerTurn,
    consumedTokens: budget.consumedTokens,
    remainingTokens: budget.remainingTokens,
    exhausted: budget.exhausted,
  };
}
