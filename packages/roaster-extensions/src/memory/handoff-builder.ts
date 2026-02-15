import type { EvidenceLedgerRow, RoasterConfig, RoasterRuntime } from "@pi-roaster/roaster-runtime";
import {
  DECISION_TOOLS,
  MUTATION_TOOLS,
  collectFilePaths,
  computeGoalOverlapScore,
  rankUniqueTexts,
  summarizeDecision,
  summarizeRow,
  tokenizeGoalTerms,
} from "./relevance.js";
import { truncateText } from "./text.js";

export type SessionHandoffRelevanceConfig = RoasterConfig["infrastructure"]["interruptRecovery"]["sessionHandoff"]["relevance"];

export function parseDigestSummary(digest: string): {
  count: number;
  pass: number;
  fail: number;
  inconclusive: number;
  entries: Array<{ tool: string; verdict: string; argsSummary: string }>;
} {
  const lines = digest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const summaryLine = lines.find((line) => line.startsWith("count="));
  if (!summaryLine) {
    throw new Error("missing_digest_summary");
  }

  const summaryMatch = /^count=(\d+)\s+pass=(\d+)\s+fail=(\d+)\s+inconclusive=(\d+)$/.exec(summaryLine);
  if (!summaryMatch) {
    throw new Error("invalid_digest_summary");
  }

  const entries = lines
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const match = /^- ([^(]+)\(([^)]+)\)\s*(.*)$/.exec(line);
      if (!match) {
        throw new Error("invalid_digest_entry");
      }
      return {
        tool: match[1]?.trim() ?? "unknown",
        verdict: match[2]?.trim() ?? "unknown",
        argsSummary: match[3]?.trim() ?? "",
      };
    });

  return {
    count: Number.parseInt(summaryMatch[1] ?? "0", 10),
    pass: Number.parseInt(summaryMatch[2] ?? "0", 10),
    fail: Number.parseInt(summaryMatch[3] ?? "0", 10),
    inconclusive: Number.parseInt(summaryMatch[4] ?? "0", 10),
    entries,
  };
}

export function buildHandoffFromRows(input: {
  rows: EvidenceLedgerRow[];
  digest: string;
  goal: string | undefined;
  relevance: SessionHandoffRelevanceConfig;
  maxSummaryChars: number;
}): string {
  const rows = [...input.rows].sort((left, right) => left.timestamp - right.timestamp);
  const recentRows = rows.slice(-12);
  const latestRows = [...recentRows].reverse();
  const goalTerms = input.relevance.enabled ? tokenizeGoalTerms(input.goal) : [];

  const scoredRows = latestRows.map((row, index) => {
    const combined = `${row.tool}\n${row.argsSummary}\n${row.outputSummary}`;
    const paths = collectFilePaths(combined);
    const artifactSignal = paths.length > 0 || MUTATION_TOOLS.has(row.tool) ? 1 : 0;
    const goalScore = computeGoalOverlapScore(combined, goalTerms);
    const recencyScore = latestRows.length <= 1 ? 1 : 1 - index / (latestRows.length - 1);
    const failureScore = row.verdict === "fail" ? 1 : 0;
    const score = input.relevance.enabled
      ? input.relevance.goalWeight * goalScore +
        input.relevance.failureWeight * failureScore +
        input.relevance.recencyWeight * recencyScore +
        input.relevance.artifactWeight * artifactSignal
      : recencyScore;
    return {
      row,
      score,
      goalScore,
      artifactSignal,
      paths,
    };
  });

  const decisions = rankUniqueTexts(
    scoredRows
      .filter((item) => DECISION_TOOLS.has(item.row.tool))
      .map((item) => ({
        text: summarizeDecision(item.row),
        score: item.score + item.goalScore,
        timestamp: item.row.timestamp,
      })),
    4,
  ).map((item) => item.text);

  const artifacts = rankUniqueTexts(
    scoredRows.flatMap((item) => {
      const paths = item.paths.length > 0 ? item.paths : item.artifactSignal > 0 ? ["(unknown-path)"] : [];
      return paths.map((path) => ({
        text: `${path} (${item.row.tool})`,
        score: item.score + (path === "(unknown-path)" ? 0 : 0.1),
        timestamp: item.row.timestamp,
      }));
    }),
    6,
  ).map((item) => item.text);

  const failedRows = scoredRows.filter((item) => item.row.verdict === "fail");
  const failuresByTool = new Map<string, number>();
  for (const item of failedRows) {
    failuresByTool.set(item.row.tool, (failuresByTool.get(item.row.tool) ?? 0) + 1);
  }
  const repeatedFailures = rankUniqueTexts(
    [...failuresByTool.entries()]
      .filter((entry) => entry[1] > 1)
      .map(([tool, count]) => {
        const toolRows = failedRows.filter((item) => item.row.tool === tool);
        const bestScore = toolRows.reduce((best, item) => Math.max(best, item.score), 0);
        const latestTimestamp = toolRows.reduce((latest, item) => Math.max(latest, item.row.timestamp), 0);
        return {
          text: `Repeated failure on ${tool} (${count}x)`,
          score: bestScore + count,
          timestamp: latestTimestamp,
        };
      }),
    4,
  );
  const failureRows = rankUniqueTexts(
    failedRows.map((item) => ({
      text: summarizeRow(item.row),
      score: item.score + item.goalScore,
      timestamp: item.row.timestamp,
    })),
    4,
  );
  const antiPatterns = rankUniqueTexts(
    [
      ...repeatedFailures.map((item) => ({ text: item.text, score: item.score, timestamp: item.timestamp })),
      ...failureRows.map((item) => ({ text: item.text, score: item.score, timestamp: item.timestamp })),
    ],
    4,
  ).map((item) => item.text);

  const openFailures = failedRows
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.row.timestamp - left.row.timestamp;
    })
    .slice(0, 4)
    .map((item) => `- ${item.row.tool}: ${item.row.argsSummary || "(no args summary)"}`);

  const recentActionsSource = input.relevance.enabled
    ? [...scoredRows].sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return right.row.timestamp - left.row.timestamp;
      })
    : scoredRows;
  const recentActions = recentActionsSource.slice(0, 4).map((item) => `- ${summarizeRow(item.row)}`);

  const summary = parseDigestSummary(input.digest);
  const matchedGoalTerms =
    goalTerms.length === 0
      ? 0
      : goalTerms.filter((term) => scoredRows.some((item) => `${item.row.tool} ${item.row.argsSummary} ${item.row.outputSummary}`.toLowerCase().includes(term)))
          .length;
  const lines: string[] = [
    "[SessionHandoff]",
    "source=ledger_rows",
    "filter=recency+goal+failures+mutations",
    `records=${summary.count} pass=${summary.pass} fail=${summary.fail} inconclusive=${summary.inconclusive}`,
    `goalTerms=${goalTerms.length} matchedGoalTerms=${matchedGoalTerms}`,
    "decisions:",
    ...(decisions.length > 0 ? decisions.map((item) => `- ${item}`) : ["- (none)"]),
    "artifacts:",
    ...(artifacts.length > 0 ? artifacts.map((item) => `- ${item}`) : ["- (none)"]),
    "antiPatterns:",
    ...(antiPatterns.length > 0 ? antiPatterns.map((item) => `- ${item}`) : ["- (none)"]),
    "openFailures:",
    ...(openFailures.length > 0 ? openFailures : ["- (none)"]),
    "recentActions:",
    ...(recentActions.length > 0 ? recentActions : ["- (none)"]),
  ];

  return truncateText(lines.join("\n"), input.maxSummaryChars);
}

export function buildHandoffFromDigest(digest: string, maxSummaryChars: number): string {
  const parsed = parseDigestSummary(digest);

  const toolCounts = new Map<string, number>();
  for (const entry of parsed.entries) {
    const current = toolCounts.get(entry.tool) ?? 0;
    toolCounts.set(entry.tool, current + 1);
  }

  const topTools = [...toolCounts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .slice(0, 3)
    .map(([tool, count]) => `${tool}:${count}`);

  const failures = parsed.entries.filter((entry) => entry.verdict === "fail").slice(0, 3);
  const recentActions = parsed.entries.slice(0, 3);

  const lines: string[] = [
    "[SessionHandoff]",
    `records=${parsed.count} pass=${parsed.pass} fail=${parsed.fail} inconclusive=${parsed.inconclusive}`,
    `topTools=${topTools.length > 0 ? topTools.join(", ") : "(none)"}`,
    "openFailures:",
    ...(failures.length > 0
      ? failures.map((entry) => `- ${entry.tool}: ${entry.argsSummary || "(no args summary)"}`)
      : ["- (none)"]),
    "recentActions:",
    ...(recentActions.length > 0
      ? recentActions.map((entry) => `- ${entry.tool}(${entry.verdict}) ${entry.argsSummary}`.trim())
      : ["- (none)"]),
  ];

  return truncateText(lines.join("\n"), maxSummaryChars);
}

export function readRecentRows(runtime: RoasterRuntime, sessionId: string): EvidenceLedgerRow[] {
  const ledger = runtime.ledger;
  if (!ledger) return [];
  return ledger.query(sessionId, { last: 24 });
}

export function buildFallbackHandoff(input: {
  digest: string;
  previousSessionHandoff?: string;
  previousUserHandoff?: string;
  reason: string;
  maxSummaryChars: number;
}): { handoff: string; source: "session_cache" | "user_cache" | "digest_preview" } {
  const sessionHandoff = input.previousSessionHandoff?.trim();
  if (sessionHandoff) {
    return { handoff: truncateText(sessionHandoff, input.maxSummaryChars), source: "session_cache" };
  }
  const userHandoff = input.previousUserHandoff?.trim();
  if (userHandoff) {
    return { handoff: truncateText(userHandoff, input.maxSummaryChars), source: "user_cache" };
  }
  const preview = input.digest.replace(/\s+/g, " ").trim();
  const fallback = [
    "[SessionHandoff]",
    "mode=fallback",
    `reason=${input.reason}`,
    `digestPreview=${preview.length > 0 ? preview : "(empty)"}`,
  ].join("\n");
  return { handoff: truncateText(fallback, input.maxSummaryChars), source: "digest_preview" };
}
