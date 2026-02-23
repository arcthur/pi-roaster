import { formatISO } from "date-fns";
import type {
  MemoryCrystal,
  MemoryInsight,
  MemoryUnit,
  WorkingMemorySection,
  WorkingMemorySnapshot,
} from "./types.js";

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function rankUnits(units: MemoryUnit[]): MemoryUnit[] {
  return units.toSorted((left, right) => {
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return right.lastSeenAt - left.lastSeenAt;
  });
}

function compactStatement(text: string, maxChars = 220): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

function readUnitMetadataString(unit: MemoryUnit, key: string): string | null {
  const value = unit.metadata?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isLessonSignal(memorySignal: string | null): boolean {
  if (!memorySignal) return false;
  if (memorySignal === "lesson") return true;
  return memorySignal.startsWith("verification_outcome");
}

function sectionLinesOrEmpty(lines: string[]): string[] {
  return lines.length > 0 ? lines : ["- (none)"];
}

function buildSections(input: {
  units: MemoryUnit[];
  crystals: MemoryCrystal[];
  insights: MemoryInsight[];
}): WorkingMemorySection[] {
  const active = input.units.filter((unit) => unit.status === "active");
  const rankedActive = rankUnits(active);
  const rankedAll = rankUnits(input.units);

  const nowLines: string[] = [];
  for (const unit of rankedActive) {
    if (unit.type !== "fact" && unit.type !== "learning" && unit.type !== "pattern") continue;
    const memorySignal = readUnitMetadataString(unit, "memorySignal");
    if (isLessonSignal(memorySignal)) continue;
    nowLines.push(`- ${compactStatement(unit.statement)}`);
    if (nowLines.length >= 4) break;
  }
  for (const crystal of input.crystals.toSorted(
    (left, right) => right.updatedAt - left.updatedAt,
  )) {
    nowLines.push(`- crystal(${crystal.topic}): ${compactStatement(crystal.summary, 180)}`);
    if (nowLines.length >= 6) break;
  }

  const decisions = rankedAll
    .filter((unit) => unit.status === "active" && unit.type === "decision")
    .slice(0, 6)
    .map((unit) => `- ${compactStatement(unit.statement)}`);

  const constraints = rankedActive
    .filter((unit) => unit.type === "constraint" || unit.type === "preference")
    .slice(0, 6)
    .map((unit) =>
      unit.type === "preference"
        ? `- preference: ${compactStatement(unit.statement)}`
        : `- ${compactStatement(unit.statement)}`,
    );

  const risks = rankedActive
    .filter((unit) => unit.type === "risk")
    .slice(0, 6)
    .map((unit) => `- ${compactStatement(unit.statement)}`);

  const lessons = rankedAll
    .filter((unit) => {
      if (unit.status !== "active") return false;
      if (unit.type !== "learning") return false;
      const memorySignal = readUnitMetadataString(unit, "memorySignal");
      const source = readUnitMetadataString(unit, "source");
      return (
        isLessonSignal(memorySignal) ||
        source === "verification_outcome_recorded" ||
        source === "cognitive_outcome_reflection"
      );
    })
    .slice(0, 6)
    .map((unit) => `- ${compactStatement(unit.statement)}`);

  const openThreads = rankedActive
    .filter((unit) => unit.type === "risk" || unit.type === "hypothesis")
    .slice(0, 4)
    .map((unit) => `- ${compactStatement(unit.statement)}`);
  for (const insight of input.insights) {
    if (insight.status !== "open") continue;
    openThreads.push(`- insight: ${compactStatement(insight.message)}`);
    if (openThreads.length >= 8) break;
  }

  return [
    {
      title: "Now",
      lines: sectionLinesOrEmpty(dedupeLines(nowLines)),
    },
    {
      title: "Decisions",
      lines: sectionLinesOrEmpty(dedupeLines(decisions)),
    },
    {
      title: "Constraints",
      lines: sectionLinesOrEmpty(dedupeLines(constraints)),
    },
    {
      title: "Risks",
      lines: sectionLinesOrEmpty(dedupeLines(risks)),
    },
    {
      title: "Lessons Learned",
      lines: sectionLinesOrEmpty(dedupeLines(lessons)),
    },
    {
      title: "Open Threads",
      lines: sectionLinesOrEmpty(dedupeLines(openThreads)),
    },
  ];
}

function renderContent(snapshot: WorkingMemorySnapshot): string {
  const lines: string[] = ["[WorkingMemory]", `generated_at: ${formatISO(snapshot.generatedAt)}`];
  for (const section of snapshot.sections) {
    lines.push(section.title);
    lines.push(...section.lines);
  }
  return lines.join("\n");
}

function trimContentByChars(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + (out.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    out.push(line);
    used += cost;
  }
  return out.join("\n");
}

export function buildWorkingMemorySnapshot(input: {
  sessionId: string;
  units: MemoryUnit[];
  crystals: MemoryCrystal[];
  insights: MemoryInsight[];
  maxChars: number;
}): WorkingMemorySnapshot {
  const sections = buildSections({
    units: input.units,
    crystals: input.crystals,
    insights: input.insights,
  });
  const sourceUnitIds = input.units.map((unit) => unit.id);
  const crystalIds = input.crystals.map((crystal) => crystal.id);
  const insightIds = input.insights.map((insight) => insight.id);
  const base: WorkingMemorySnapshot = {
    sessionId: input.sessionId,
    generatedAt: Date.now(),
    sourceUnitIds,
    crystalIds,
    insightIds,
    sections,
    content: "",
  };
  const rendered = renderContent(base);
  const trimmed = trimContentByChars(rendered, Math.max(200, input.maxChars));
  return {
    ...base,
    content: trimmed,
  };
}
