export interface ToolFailureEntry {
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  turn: number;
}

export interface BuildToolFailuresBlockOptions {
  maxEntries?: number;
  maxOutputChars?: number;
  maxArgsChars?: number;
}

const DEFAULT_MAX_ENTRIES = 3;
const DEFAULT_MAX_OUTPUT_CHARS = 300;
const DEFAULT_MAX_ARGS_CHARS = 140;

export function buildRecentToolFailuresBlock(
  failures: ToolFailureEntry[],
  options: BuildToolFailuresBlockOptions = {},
): string {
  if (failures.length === 0) return "";

  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const maxOutputChars = Math.max(
    32,
    Math.floor(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS),
  );
  const maxArgsChars = Math.max(16, Math.floor(options.maxArgsChars ?? DEFAULT_MAX_ARGS_CHARS));
  const recent = failures.slice(-maxEntries);

  const lines: string[] = ["[RecentToolFailures]"];
  for (const entry of recent) {
    const toolName = entry.toolName.trim() || "(unknown)";
    const turn = Number.isFinite(entry.turn) ? Math.max(0, Math.floor(entry.turn)) : 0;
    const argsSummary = summarizeArgs(entry.args, maxArgsChars);
    const outputSummary = truncate(compactWhitespace(entry.outputText), maxOutputChars) || "(none)";

    lines.push(`- tool=${toolName} turn=${turn} args=${argsSummary}`, `  output: ${outputSummary}`);
  }

  return lines.join("\n");
}

function summarizeArgs(args: Record<string, unknown>, maxChars: number): string {
  let text = "";
  try {
    text = JSON.stringify(args);
  } catch {
    text = "";
  }
  return truncate(compactWhitespace(text), maxChars) || "(none)";
}

function compactWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keep = Math.max(1, maxChars - 3);
  return `${value.slice(0, keep)}...`;
}
