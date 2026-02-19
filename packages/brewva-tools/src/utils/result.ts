import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

export function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}
