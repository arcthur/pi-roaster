import type { EvidenceLedgerRow } from "../types.js";

export function formatLedgerRows(rows: EvidenceLedgerRow[]): string {
  if (rows.length === 0) {
    return "No evidence records found.";
  }

  const lines: string[] = [];
  for (const row of rows) {
    lines.push(
      `[${new Date(row.timestamp).toISOString()}] id=${row.id} tool=${row.tool} verdict=${row.verdict} skill=${row.skill ?? "-"}`,
    );
    lines.push(`  args: ${row.argsSummary}`);
    lines.push(`  output: ${row.outputSummary}`);
  }
  return lines.join("\n");
}
