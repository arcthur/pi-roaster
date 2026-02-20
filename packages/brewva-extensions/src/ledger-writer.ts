import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function extractTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

export function registerLedgerWriter(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  pi.on("tool_result", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const outputText = extractTextContent(event.content as Array<{ type: string; text?: string }>);

    runtime.finishToolCall({
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.input,
      outputText,
      success: !event.isError,
      verdict: event.isError ? "fail" : "pass",
      metadata: {
        toolCallId: event.toolCallId,
        details: event.details as Record<string, unknown> | undefined,
      },
    });

    return undefined;
  });
}
