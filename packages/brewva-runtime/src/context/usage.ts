import type { ContextBudgetUsage } from "../types.js";

type UsageLike =
  | {
      tokens?: unknown;
      contextWindow?: unknown;
      percent?: unknown;
    }
  | null
  | undefined;

function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function coerceContextBudgetUsage(input: unknown): ContextBudgetUsage | undefined {
  const usage = input as UsageLike;
  if (!usage || typeof usage !== "object") return undefined;

  const contextWindow = normalizeFiniteNumber(usage.contextWindow);
  if (contextWindow === null || contextWindow <= 0) return undefined;

  const tokens = normalizeFiniteNumber(usage.tokens);
  const percent = normalizeFiniteNumber(usage.percent);
  return {
    tokens: tokens !== null && tokens >= 0 ? tokens : null,
    contextWindow,
    percent,
  };
}
