import type { ViewportMetrics } from "../context/viewport.js";

export type ViewportQuality = "good" | "ok" | "low" | "unknown";

export interface ViewportSignalScore {
  snr: number | null;
  effectiveSnr: number | null;
  score: number | null;
  signalLines: number;
  noiseLines: number;
}

export interface ViewportQualityThresholds {
  good: number;
  ok: number;
  skip: number;
}

export const DEFAULT_VIEWPORT_QUALITY_THRESHOLDS: ViewportQualityThresholds = {
  good: 0.22,
  ok: 0.12,
  skip: 0.04,
};

function normalizeMetricNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeSnr(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function maxNullable(...values: Array<number | null>): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    best = best === null ? value : Math.max(best, value);
  }
  return best;
}

export function computeViewportSignalScore(
  metrics: ViewportMetrics,
): ViewportSignalScore {
  const keywordSnr = normalizeSnr(metrics.snr);

  const relevantHitLines = normalizeMetricNumber(metrics.relevantHitLines);
  const relevantTotalLines = normalizeMetricNumber(metrics.relevantTotalLines);
  const importsExportsLines = normalizeMetricNumber(
    metrics.importsExportsLines,
  );
  const symbolLines = normalizeMetricNumber(metrics.symbolLines);
  const neighborhoodLines = normalizeMetricNumber(metrics.neighborhoodLines);

  const keywordSignal = relevantHitLines;
  const structuralSignal = symbolLines + neighborhoodLines;
  const signalLines = keywordSignal + structuralSignal;

  const relevantNoise = Math.max(0, relevantTotalLines - relevantHitLines);
  const noiseLines = relevantNoise + importsExportsLines;

  const denom = signalLines + noiseLines;
  const effectiveSnr = denom > 0 ? signalLines / denom : null;
  const score = (() => {
    if (keywordSnr === null) return effectiveSnr;
    if (relevantHitLines > 0) return keywordSnr;
    return maxNullable(keywordSnr, effectiveSnr);
  })();

  return {
    snr: keywordSnr,
    effectiveSnr,
    score,
    signalLines,
    noiseLines,
  };
}

export function classifyViewportQuality(
  score: number | null,
  thresholds: ViewportQualityThresholds = DEFAULT_VIEWPORT_QUALITY_THRESHOLDS,
): ViewportQuality {
  if (score === null) return "unknown";
  if (score >= thresholds.good) return "good";
  if (score >= thresholds.ok) return "ok";
  return "low";
}

export function shouldSkipViewportInjection(input: {
  metrics: ViewportMetrics;
  score: ViewportSignalScore;
  thresholds?: ViewportQualityThresholds;
}): { skip: boolean; reason?: string } {
  const thresholds = input.thresholds ?? DEFAULT_VIEWPORT_QUALITY_THRESHOLDS;
  const score = input.score.score;
  if (score === null) return { skip: false };

  if (score > thresholds.skip) return { skip: false };

  const relevantHitLines = normalizeMetricNumber(
    input.metrics.relevantHitLines,
  );
  const structuralSignal =
    normalizeMetricNumber(input.metrics.symbolLines) +
    normalizeMetricNumber(input.metrics.neighborhoodLines);
  if (relevantHitLines > 0 || structuralSignal > 0) return { skip: false };

  const includedFiles = input.metrics.includedFiles ?? [];
  if (includedFiles.length === 0) return { skip: false };

  return { skip: true, reason: "viewport_low_signal" };
}
