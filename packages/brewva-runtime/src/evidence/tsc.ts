export type TscDiagnosticSeverity =
  | "error"
  | "warning"
  | "information"
  | "hint"
  | "unknown";

export interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: TscDiagnosticSeverity;
  code: string;
  message: string;
}

export function coerceTscDiagnosticSeverity(
  value: string,
): TscDiagnosticSeverity {
  const normalized = value.trim().toLowerCase();
  if (normalized === "error") return "error";
  if (normalized === "warning") return "warning";
  if (normalized === "information") return "information";
  if (normalized === "hint") return "hint";
  return "unknown";
}

export function parseTscDiagnostics(
  outputText: string,
  limit: number,
): { diagnostics: TscDiagnostic[]; truncated: boolean } {
  const out: TscDiagnostic[] = [];
  let truncated = false;

  const pattern = /^(.+?)\((\d+),(\d+)\):\s+([A-Za-z]+)\s+(TS\d+):\s+(.*)$/;

  for (const rawLine of outputText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(pattern);
    if (!match) continue;

    const file = match[1]?.trim();
    const lineNumber = Number(match[2]);
    const columnNumber = Number(match[3]);
    const severity = coerceTscDiagnosticSeverity(match[4] ?? "");
    const code = (match[5] ?? "").trim();
    const message = (match[6] ?? "").trim();

    if (
      !file ||
      !Number.isFinite(lineNumber) ||
      !Number.isFinite(columnNumber) ||
      !code ||
      !message
    ) {
      continue;
    }

    out.push({
      file,
      line: lineNumber,
      column: columnNumber,
      severity,
      code,
      message: message.length > 400 ? `${message.slice(0, 397)}...` : message,
    });

    if (out.length >= limit) {
      truncated = true;
      break;
    }
  }

  return { diagnostics: out, truncated };
}
