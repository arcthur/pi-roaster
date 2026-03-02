import type { MemoryCrystal, MemorySourceRef, MemoryUnit } from "./types.js";
import { mergeSourceRefs, normalizeText } from "./utils.js";

function summarizeUnitsExtractive(units: MemoryUnit[]): string {
  const ranked = units
    .toSorted((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return right.lastSeenAt - left.lastSeenAt;
    })
    .slice(0, 4);
  const lines = ranked.map((unit) => `- ${unit.statement}`);
  return ["[Crystal]", ...lines].join("\n");
}

export interface CrystalDraft extends Omit<MemoryCrystal, "id" | "createdAt" | "updatedAt"> {}

export interface CrystalSummarizeInput {
  topic: string;
  units: Array<{
    id: string;
    statement: string;
    confidence: number;
    lastSeenAt: number;
  }>;
  fallbackSummary: string;
}

export function compileCrystalDrafts(input: {
  sessionId: string;
  units: MemoryUnit[];
  minUnits: number;
  summarize?: (input: CrystalSummarizeInput) => string | null | undefined;
}): CrystalDraft[] {
  const grouped = new Map<string, MemoryUnit[]>();
  for (const unit of input.units) {
    if (unit.sessionId !== input.sessionId) continue;
    if (unit.status === "superseded") continue;
    const key = normalizeText(unit.topic);
    if (!key) continue;
    const bucket = grouped.get(key) ?? [];
    bucket.push(unit);
    grouped.set(key, bucket);
  }

  const drafts: CrystalDraft[] = [];
  for (const units of grouped.values()) {
    if (units.length < input.minUnits) continue;
    const sorted = units.toSorted((left, right) => right.lastSeenAt - left.lastSeenAt);
    const latest = sorted[0];
    if (!latest) continue;
    const topic = latest.topic;
    const unitIds = sorted.map((unit) => unit.id);
    const averageConfidence =
      sorted.reduce((accumulator, unit) => accumulator + unit.confidence, 0) / sorted.length;
    const fallbackSummary = summarizeUnitsExtractive(sorted);
    const summarized = input.summarize?.({
      topic,
      units: sorted.map((unit) => ({
        id: unit.id,
        statement: unit.statement,
        confidence: unit.confidence,
        lastSeenAt: unit.lastSeenAt,
      })),
      fallbackSummary,
    });
    const summary =
      typeof summarized === "string" && summarized.trim().length > 0
        ? summarized.trim()
        : fallbackSummary;
    drafts.push({
      sessionId: input.sessionId,
      topic,
      summary,
      unitIds,
      confidence: averageConfidence,
      sourceRefs: sorted.reduce(
        (merged, unit) => mergeSourceRefs(merged, unit.sourceRefs),
        [] as MemorySourceRef[],
      ),
      metadata: {
        unitCount: sorted.length,
      },
    });
  }

  return drafts.toSorted((left, right) => right.confidence - left.confidence);
}
