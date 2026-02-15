import type { EvidenceLedgerRow, LedgerDigest } from "../types.js";
import { estimateTokenCount } from "../utils/token.js";

const INFRASTRUCTURE_TOOLS = new Set([
  "roaster_cost",
  "roaster_context_compaction",
  "ledger_checkpoint",
]);

export function buildLedgerDigest(sessionId: string, rows: EvidenceLedgerRow[], maxRecords: number, maxTokens: number): LedgerDigest {
  const taskRows = rows.filter((row) => !INFRASTRUCTURE_TOOLS.has(row.tool));
  const recent = taskRows.slice(-Math.max(1, maxRecords));

  const records: LedgerDigest["records"] = [];
  let usedTokens = 0;
  for (const row of recent.reverse()) {
    const snippet = `${row.tool} ${row.argsSummary} ${row.outputSummary}`;
    const rowTokens = estimateTokenCount(snippet);
    if (usedTokens + rowTokens > maxTokens) {
      continue;
    }
    usedTokens += rowTokens;
    records.push({
      id: row.id,
      timestamp: row.timestamp,
      tool: row.tool,
      skill: row.skill,
      verdict: row.verdict,
      argsSummary: row.argsSummary,
      outputSummary: row.outputSummary,
    });
  }

  records.reverse();

  const summary = {
    total: records.length,
    pass: records.filter((row) => row.verdict === "pass").length,
    fail: records.filter((row) => row.verdict === "fail").length,
    inconclusive: records.filter((row) => row.verdict === "inconclusive").length,
  };

  return {
    generatedAt: Date.now(),
    sessionId,
    records,
    summary,
  };
}

export function formatDigestForContext(digest: LedgerDigest): string {
  const lines: string[] = [
    "[Ledger Digest]",
    `records=${digest.summary.total} pass=${digest.summary.pass} fail=${digest.summary.fail} inconclusive=${digest.summary.inconclusive}`,
  ];

  for (const row of digest.records) {
    lines.push(`- ${row.tool} (${row.verdict}) :: ${row.argsSummary} => ${row.outputSummary}`);
  }

  return lines.join("\n");
}
