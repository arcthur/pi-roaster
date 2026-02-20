import {
  classifyViewportQuality,
  computeViewportSignalScore,
  shouldSkipViewportInjection,
  type ViewportQuality,
} from "../policy/viewport-policy.js";
import {
  buildViewportContext,
  type ViewportContextResult,
  type ViewportMetrics,
} from "./viewport.js";

export interface ViewportPolicyDecision {
  selected: ViewportContextResult;
  injected: boolean;
  variant: "full" | "no_neighborhood" | "minimal" | "skipped";
  quality: ViewportQuality;
  score: number | null;
  snr: number | null;
  effectiveSnr: number | null;
  reason: string;
  guardBlock?: string;
  evaluated: Array<{
    variant: string;
    metrics: ViewportMetrics;
    score: number | null;
    snr: number | null;
    effectiveSnr: number | null;
  }>;
}

function formatScore(value: number | null): string {
  return value === null ? "null" : value.toFixed(2);
}

function buildViewportPolicyGuardBlock(input: {
  quality: ViewportQuality;
  variant: string;
  score: number | null;
  snr: number | null;
  effectiveSnr: number | null;
  reason: string;
  metrics: ViewportMetrics;
}): string {
  const included =
    input.metrics.includedFiles.length > 0 ? input.metrics.includedFiles.join(", ") : "(none)";
  const unavailable =
    input.metrics.unavailableFiles.length > 0
      ? input.metrics.unavailableFiles
          .slice(0, 3)
          .map((entry) => `${entry.file}:${entry.reason}`)
          .join(", ")
      : "none";

  return [
    "[ViewportPolicy]",
    `quality=${input.quality} variant=${input.variant} reason=${input.reason}`,
    `score=${formatScore(input.score)} snr=${formatScore(input.snr)} effectiveSnr=${formatScore(input.effectiveSnr)}`,
    `includedFiles=${included}`,
    `unavailableFiles=${unavailable}`,
    "",
    "Policy:",
    "- Treat low-signal viewport as unreliable; do not start editing yet.",
    "- Refine TaskSpec targets.files/targets.symbols, or gather evidence (lsp_symbols, lsp_diagnostics).",
    "- Re-run diagnostics/verification before applying patches.",
  ].join("\n");
}

export function buildOutputHealthGuardBlock(health: { score: number; flags: string[] }): string {
  const score = Math.max(0, Math.min(1, health.score));
  const flags = health.flags.length > 0 ? health.flags.join(",") : "none";
  return [
    "[OutputHealthGuard]",
    `score=${score.toFixed(2)} flags=${flags}`,
    "- Keep sentences short and concrete.",
    "- Do not repeat the same reasoning. If stuck, stop and verify or ask for missing info.",
    "- Prefer tool-based verification over speculation.",
  ].join("\n");
}

export function decideViewportPolicy(input: {
  cwd: string;
  sessionId: string;
  goal: string;
  targetFiles: string[];
  targetSymbols: string[];
}): ViewportPolicyDecision {
  const build = (
    options: Partial<Parameters<typeof buildViewportContext>[0]>,
  ): ViewportContextResult => {
    return buildViewportContext({
      cwd: input.cwd,
      goal: input.goal,
      targetFiles: input.targetFiles,
      targetSymbols: input.targetSymbols,
      ...options,
    });
  };

  const evaluated: Array<{
    variant: string;
    result: ViewportContextResult;
    metrics: ViewportMetrics;
    score: ReturnType<typeof computeViewportSignalScore>;
  }> = [];

  const full = build({});
  const fullScore = computeViewportSignalScore(full.metrics);
  evaluated.push({
    variant: "full",
    result: full,
    metrics: full.metrics,
    score: fullScore,
  });

  const skipDecision = shouldSkipViewportInjection({
    metrics: full.metrics,
    score: fullScore,
  });

  if (skipDecision.skip) {
    const reason = skipDecision.reason ?? "viewport_policy_skip";
    const guardBlock = buildViewportPolicyGuardBlock({
      quality: "low",
      variant: "skipped",
      score: fullScore.score,
      snr: fullScore.snr,
      effectiveSnr: fullScore.effectiveSnr,
      reason,
      metrics: full.metrics,
    });
    return {
      selected: full,
      injected: false,
      variant: "skipped",
      quality: "low",
      score: fullScore.score,
      snr: fullScore.snr,
      effectiveSnr: fullScore.effectiveSnr,
      reason,
      guardBlock,
      evaluated: evaluated.map((entry) => ({
        variant: entry.variant,
        metrics: entry.metrics,
        score: entry.score.score,
        snr: entry.score.snr,
        effectiveSnr: entry.score.effectiveSnr,
      })),
    };
  }

  const isBetter = (
    current: {
      result: ViewportContextResult;
      score: ReturnType<typeof computeViewportSignalScore>;
    },
    candidate: {
      result: ViewportContextResult;
      score: ReturnType<typeof computeViewportSignalScore>;
    },
  ): boolean => {
    const currentScore = current.score.score ?? -1;
    const candidateScore = candidate.score.score ?? -1;
    const improvement = candidateScore - currentScore;
    if (improvement > 0.04) return true;

    if (current.result.metrics.truncated && !candidate.result.metrics.truncated) {
      if (improvement >= -0.01) return true;
    }

    if (improvement > 0.01) {
      const candidateChars = candidate.result.metrics.totalChars;
      const currentChars = current.result.metrics.totalChars;
      if (candidateChars <= currentChars) return true;
    }

    return false;
  };

  let selectedVariant: "full" | "no_neighborhood" | "minimal" = "full";
  let selectedResult = full;
  let selectedScore = fullScore;
  let selectedQuality = classifyViewportQuality(selectedScore.score);

  const shouldTryNoNeighborhood =
    selectedQuality === "low" ||
    selectedResult.metrics.truncated ||
    ((selectedScore.score ?? 1) < 0.16 && selectedResult.metrics.neighborhoodLines > 12);

  if (shouldTryNoNeighborhood) {
    const noNeighborhood = build({ maxNeighborImports: 0 });
    const score = computeViewportSignalScore(noNeighborhood.metrics);
    evaluated.push({
      variant: "no_neighborhood",
      result: noNeighborhood,
      metrics: noNeighborhood.metrics,
      score,
    });

    if (
      isBetter({ result: selectedResult, score: selectedScore }, { result: noNeighborhood, score })
    ) {
      selectedVariant = "no_neighborhood";
      selectedResult = noNeighborhood;
      selectedScore = score;
      selectedQuality = classifyViewportQuality(selectedScore.score);
    }
  }

  const shouldTryMinimal = selectedQuality === "low" || selectedResult.metrics.truncated;
  if (shouldTryMinimal) {
    const minimal = build({
      maxNeighborImports: 0,
      maxImportsPerFile: 0,
    });
    const score = computeViewportSignalScore(minimal.metrics);
    evaluated.push({
      variant: "minimal",
      result: minimal,
      metrics: minimal.metrics,
      score,
    });

    if (isBetter({ result: selectedResult, score: selectedScore }, { result: minimal, score })) {
      selectedVariant = "minimal";
      selectedResult = minimal;
      selectedScore = score;
      selectedQuality = classifyViewportQuality(selectedScore.score);
    }
  }

  const reason =
    selectedVariant !== "full"
      ? "viewport_policy_variant_selected"
      : selectedQuality === "low"
        ? "viewport_policy_low_quality"
        : "viewport_policy_ok";

  const guardBlock =
    selectedQuality === "low"
      ? buildViewportPolicyGuardBlock({
          quality: selectedQuality,
          variant: selectedVariant,
          score: selectedScore.score,
          snr: selectedScore.snr,
          effectiveSnr: selectedScore.effectiveSnr,
          reason,
          metrics: selectedResult.metrics,
        })
      : undefined;

  return {
    selected: selectedResult,
    injected: Boolean(selectedResult.text),
    variant: selectedVariant,
    quality: selectedQuality,
    score: selectedScore.score,
    snr: selectedScore.snr,
    effectiveSnr: selectedScore.effectiveSnr,
    reason,
    guardBlock,
    evaluated: evaluated.map((entry) => ({
      variant: entry.variant,
      metrics: entry.metrics,
      score: entry.score.score,
      snr: entry.score.snr,
      effectiveSnr: entry.score.effectiveSnr,
    })),
  };
}
