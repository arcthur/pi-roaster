import type { EvidenceLedgerRow } from "@pi-roaster/roaster-runtime";

export const DECISION_TOOLS = new Set([
  "skill_load",
  "skill_complete",
  "roaster_verify",
  "roaster_context_compaction",
  "roaster_rollback",
  "rollback_last_patch",
  "ledger_checkpoint",
]);

export const MUTATION_TOOLS = new Set(["edit", "multi_edit", "write_file", "replace", "create_file", "delete_file"]);

const PATH_REGEX = /(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+/g;

const GOAL_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "have",
  "will",
  "need",
  "just",
  "then",
  "when",
  "where",
  "what",
  "how",
  "fix",
  "make",
  "build",
  "run",
  "test",
  "issue",
  "task",
]);

export function collectFilePaths(text: string): string[] {
  const matches = text.match(PATH_REGEX) ?? [];
  const normalized = matches
    .map((path) => path.replace(/^\.?\//, ""))
    .filter((path) => !path.startsWith("http"));
  return [...new Set(normalized)];
}

export function summarizeRow(row: EvidenceLedgerRow): string {
  const args = row.argsSummary.trim();
  return `${row.tool}(${row.verdict})${args.length > 0 ? ` ${args}` : ""}`.trim();
}

export function summarizeDecision(row: EvidenceLedgerRow): string {
  const args = row.argsSummary.trim();
  if (row.tool === "skill_load") {
    return `Activated skill ${args || "(unknown)"}`;
  }
  if (row.tool === "skill_complete") {
    return `Completed skill with outputs ${args || "(unspecified)"}`;
  }
  if (row.tool === "roaster_verify") {
    return `Verification ${row.verdict === "pass" ? "passed" : "failed"} for ${args || "configured checks"}`;
  }
  if (row.tool === "roaster_context_compaction") {
    return `Compacted context ${args || "(budget policy)"}`;
  }
  if (row.tool === "roaster_rollback" || row.tool === "rollback_last_patch") {
    return `Applied rollback ${args || "(last patch set)"}`;
  }
  if (row.tool === "ledger_checkpoint") {
    return `Created ledger checkpoint ${args || "(scheduled)"}`;
  }
  return summarizeRow(row);
}

export function tokenizeGoalTerms(goal: string | undefined): string[] {
  if (!goal) return [];
  const matches = goal.toLowerCase().match(/[a-z0-9._/-]+/g) ?? [];
  const filtered = matches.filter((token) => token.length >= 3 && !GOAL_STOP_WORDS.has(token));
  return [...new Set(filtered)];
}

export function computeGoalOverlapScore(text: string, goalTerms: string[]): number {
  if (goalTerms.length === 0) return 0;
  const normalized = text.toLowerCase();
  let matched = 0;
  for (const term of goalTerms) {
    if (normalized.includes(term)) {
      matched += 1;
    }
  }
  return matched / goalTerms.length;
}

export function rankUniqueTexts(
  items: Array<{ text: string; score: number; timestamp: number }>,
  limit: number,
): Array<{ text: string; score: number; timestamp: number }> {
  const bestByText = new Map<string, { score: number; timestamp: number }>();
  for (const item of items) {
    const existing = bestByText.get(item.text);
    if (!existing || item.score > existing.score || (item.score === existing.score && item.timestamp > existing.timestamp)) {
      bestByText.set(item.text, { score: item.score, timestamp: item.timestamp });
    }
  }

  return [...bestByText.entries()]
    .map(([text, value]) => ({ text, score: value.score, timestamp: value.timestamp }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.timestamp !== left.timestamp) return right.timestamp - left.timestamp;
      return left.text.localeCompare(right.text);
    })
    .slice(0, limit);
}
