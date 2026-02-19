export const DEFAULT_CHARS_PER_TOKEN = 3.5;

export function estimateTokenCount(text: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return Math.max(0, Math.ceil(text.length / charsPerToken));
}

export function normalizePercent(
  value: number | null | undefined,
  options?: {
    tokens?: number | null;
    contextWindow?: number | null;
  },
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;

  const raw = Number(value);
  const tokens = options?.tokens;
  const contextWindow = options?.contextWindow;
  const hasTokenTelemetry =
    typeof tokens === "number" &&
    Number.isFinite(tokens) &&
    tokens >= 0 &&
    typeof contextWindow === "number" &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0;

  // Upstream context telemetry is not stable across providers and may report:
  // - ratio (0..1)
  // - percentage points (0..100), including low values below 1.0 (e.g. 0.98%)
  // If token telemetry is available, infer the unit by comparing proximity.
  const usageRatioFromTelemetry = hasTokenTelemetry
    ? Math.max(0, Math.min(tokens / contextWindow, 1))
    : null;

  let normalized = raw;
  if (raw > 1) {
    normalized = raw / 100;
  } else if (usageRatioFromTelemetry !== null) {
    const pointsFromTelemetry = usageRatioFromTelemetry * 100;
    const distanceAsRatio = Math.abs(raw - usageRatioFromTelemetry);
    const distanceAsPoints = Math.abs(raw - pointsFromTelemetry);
    normalized = distanceAsPoints < distanceAsRatio ? raw / 100 : raw;
  }

  return Math.max(0, Math.min(normalized, 1));
}

export function truncateTextToTokenBudget(
  text: string,
  tokenBudget: number,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): string {
  const maxChars = Math.floor(Math.max(0, tokenBudget) * charsPerToken);
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}
