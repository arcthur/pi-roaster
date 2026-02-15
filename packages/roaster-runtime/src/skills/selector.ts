import type { SkillSelection, SkillsIndexEntry } from "../types.js";

const WORD_RE = /[a-zA-Z0-9_-]+/g;

function tokenize(input: string): string[] {
  return (input.toLowerCase().match(WORD_RE) ?? []).filter((token) => token.length >= 2);
}

function costWeight(costHint: SkillsIndexEntry["costHint"]): number {
  if (costHint === "low") return 2;
  if (costHint === "medium") return 1;
  return 0;
}

export function selectTopKSkills(message: string, index: SkillsIndexEntry[], k: number): SkillSelection[] {
  const text = message.toLowerCase();
  const tokens = new Set(tokenize(message));

  const scored: SkillSelection[] = [];

  for (const entry of index) {
    const anti = entry.antiTags.some((tag) => tokens.has(tag.toLowerCase()) || text.includes(tag.toLowerCase()));
    if (anti) {
      continue;
    }

    let score = 0;
    const reasons: string[] = [];

    if (tokens.has(entry.name.toLowerCase()) || text.includes(entry.name.toLowerCase())) {
      score += 5;
      reasons.push("name-match");
    }

    for (const tag of entry.tags) {
      if (tokens.has(tag.toLowerCase()) || text.includes(tag.toLowerCase())) {
        score += 3;
        reasons.push(`tag:${tag}`);
      }
    }

    const descriptionTokens = tokenize(entry.description).slice(0, 8);
    for (const token of descriptionTokens) {
      if (tokens.has(token)) {
        score += 1;
      }
    }

    score += costWeight(entry.costHint);

    if (score <= 0) {
      continue;
    }

    scored.push({
      name: entry.name,
      score,
      reason: reasons.length > 0 ? reasons.join(",") : "description-match",
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return scored.slice(0, Math.max(1, k));
}
