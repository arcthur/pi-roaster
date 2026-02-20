import type { MemoryCrystal, MemorySourceRef, MemoryUnit } from "./types.js";
import { mergeSourceRefs, normalizeText } from "./utils.js";

function summarizeUnits(units: MemoryUnit[]): string {
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

export function compileCrystalDrafts(input: {
  sessionId: string;
  units: MemoryUnit[];
  minUnits: number;
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
    drafts.push({
      sessionId: input.sessionId,
      topic,
      summary: summarizeUnits(sorted),
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
