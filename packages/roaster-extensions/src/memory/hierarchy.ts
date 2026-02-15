import type { RoasterConfig } from "@pi-roaster/roaster-runtime";
import { computeGoalOverlapScore, tokenizeGoalTerms } from "./relevance.js";
import { stripLeadingHeader, truncateText } from "./text.js";

export type SessionHandoffHierarchyConfig = RoasterConfig["infrastructure"]["interruptRecovery"]["sessionHandoff"]["hierarchy"];

function toHierarchyPreview(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return truncateText(normalized, maxChars);
}

function extractHandoffHighlights(text: string, perEntryLimit: number): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const bullets = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
  if (bullets.length > 0) {
    return bullets.slice(0, perEntryLimit);
  }

  const fallback = lines.find((line) => !line.startsWith("[") && !line.endsWith(":"));
  return fallback ? [fallback] : [];
}

function summarizeHierarchyChunk(input: {
  entries: string[];
  targetLevel: number;
  maxCharsPerEntry: number;
}): string {
  const highlights = input.entries.flatMap((entry) => extractHandoffHighlights(entry, 2));
  const uniqueHighlights = [...new Set(highlights)].slice(0, 6);
  const lines = [
    `[HierarchyL${input.targetLevel}]`,
    "source=recursive_compaction",
    `size=${input.entries.length}`,
    ...(uniqueHighlights.length > 0
      ? uniqueHighlights.map((line) => `- ${line}`)
      : [`- ${toHierarchyPreview(input.entries.join(" "), input.maxCharsPerEntry)}`]),
  ];
  return truncateText(lines.join("\n"), input.maxCharsPerEntry);
}

function normalizeHierarchy(input: unknown, levelCount: number, maxCharsPerEntry: number): string[][] {
  const fallback = Array.from({ length: levelCount }, () => [] as string[]);
  if (!input || typeof input !== "object") {
    return fallback;
  }
  const levels = (input as { levels?: unknown }).levels;
  if (!Array.isArray(levels)) {
    return fallback;
  }

  for (let index = 0; index < levelCount; index += 1) {
    const level = levels[index];
    if (!Array.isArray(level)) continue;
    fallback[index] = level
      .filter((item): item is string => typeof item === "string")
      .map((item) => truncateText(item.trim(), maxCharsPerEntry))
      .filter((item) => item.length > 0);
  }
  return fallback;
}

export function buildNextHierarchy(input: {
  current: unknown;
  handoffText: string;
  config: SessionHandoffHierarchyConfig;
}): { levels: string[][] } {
  const levelCount = Math.max(1, input.config.maxLevels);
  const levels = normalizeHierarchy(input.current, levelCount, input.config.maxCharsPerEntry);
  const baseEntry = truncateText(stripLeadingHeader(input.handoffText, "[SessionHandoff]"), input.config.maxCharsPerEntry);
  if (baseEntry.length > 0) {
    levels[0]?.push(baseEntry);
  }

  if (levelCount > 1) {
    for (let levelIndex = 0; levelIndex < levelCount - 1; levelIndex += 1) {
      const source = levels[levelIndex];
      const target = levels[levelIndex + 1];
      if (!source || !target) continue;

      while (source.length > input.config.entriesPerLevel && source.length >= input.config.branchFactor) {
        const chunk = source.splice(0, input.config.branchFactor);
        const summarized = summarizeHierarchyChunk({
          entries: chunk,
          targetLevel: levelIndex + 1,
          maxCharsPerEntry: input.config.maxCharsPerEntry,
        });
        target.push(summarized);
      }
    }
  }

  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    const level = levels[levelIndex];
    if (!level) continue;
    if (level.length > input.config.entriesPerLevel) {
      levels[levelIndex] = level.slice(-input.config.entriesPerLevel);
    }
  }

  return { levels };
}

export function buildHierarchyInjectionBlocks(input: {
  hierarchy: unknown;
  config: SessionHandoffHierarchyConfig;
  goal?: string;
}): string[] {
  if (!input.config.enabled) return [];
  const levels = normalizeHierarchy(input.hierarchy, input.config.maxLevels, input.config.maxCharsPerEntry);
  const goalTerms = tokenizeGoalTerms(input.goal);

  const candidates = levels.flatMap((items, levelIndex) =>
    items.map((item, itemIndex) => {
      const recency = items.length <= 1 ? 1 : itemIndex / (items.length - 1);
      const levelBonus = levelIndex / Math.max(1, input.config.maxLevels);
      const goalScore = goalTerms.length > 0 ? computeGoalOverlapScore(item, goalTerms) : 0;
      const score = goalScore * 2 + recency * 0.3 + levelBonus * 0.2;
      return {
        levelIndex,
        item,
        score,
        goalScore,
        recency,
      };
    }),
  );

  if (candidates.length === 0) return [];

  const shouldFilterByGoal = input.config.goalFilterEnabled && goalTerms.length > 0;
  let selected = shouldFilterByGoal
    ? candidates
        .filter((candidate) => candidate.goalScore >= input.config.minGoalScore)
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          if (right.levelIndex !== left.levelIndex) return right.levelIndex - left.levelIndex;
          return right.recency - left.recency;
        })
    : candidates.sort((left, right) => {
        if (right.levelIndex !== left.levelIndex) return right.levelIndex - left.levelIndex;
        return right.recency - left.recency;
      });

  if (selected.length === 0) {
    selected = [...candidates].sort((left, right) => {
      if (right.levelIndex !== left.levelIndex) return right.levelIndex - left.levelIndex;
      return right.recency - left.recency;
    });
  }

  const capped = selected.slice(0, input.config.maxInjectedEntries);
  const grouped = new Map<number, string[]>();
  for (const entry of capped) {
    const list = grouped.get(entry.levelIndex) ?? [];
    list.push(entry.item);
    grouped.set(entry.levelIndex, list);
  }

  const blocks: string[] = [];
  const orderedLevels = [...grouped.keys()].sort((left, right) => right - left);
  for (const levelIndex of orderedLevels) {
    const entries = grouped.get(levelIndex) ?? [];
    const topEntries = entries
      .slice(0, input.config.entriesPerLevel)
      .map((item) => `- ${toHierarchyPreview(stripLeadingHeader(item, `[HierarchyL${levelIndex}]`), input.config.maxCharsPerEntry)}`);
    if (topEntries.length === 0) continue;
    const block = [`[UserMemoryHierarchy:L${levelIndex}]`, ...topEntries].join("\n");
    blocks.push(block);
  }
  return blocks;
}

export function capBlocksByTotalChars(blocks: string[], maxChars: number): string[] {
  if (blocks.length === 0) return [];
  const capped: string[] = [];
  let consumed = 0;
  for (const block of blocks) {
    const cost = block.length + (capped.length > 0 ? 2 : 0);
    if (consumed + cost > maxChars) {
      continue;
    }
    capped.push(block);
    consumed += cost;
  }
  return capped;
}
