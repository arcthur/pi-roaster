import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

export type ToolResultVerdict = "pass" | "fail" | "inconclusive";

export function textResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function withVerdict<T extends Record<string, unknown>>(
  details: T,
  verdict?: ToolResultVerdict,
): T & { verdict?: ToolResultVerdict } {
  if (!verdict) {
    return details;
  }
  return {
    ...details,
    verdict,
  };
}

export function failTextResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return textResult(text, withVerdict(details, "fail"));
}

export function inconclusiveTextResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return textResult(text, withVerdict(details, "inconclusive"));
}
