import { coerceContextBudgetUsage, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerQualityGate(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  pi.on("tool_call", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const usage = coerceContextBudgetUsage(
      typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined,
    );
    const started = runtime.startToolCall({
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.input as Record<string, unknown> | undefined,
      usage,
    });
    if (!started.allowed) {
      return {
        block: true,
        reason: started.reason ?? "Tool call blocked by runtime policy.",
      };
    }
    return undefined;
  });

  pi.on("input", (event) => {
    const sanitized = runtime.sanitizeInput(event.text);
    if (sanitized === event.text) {
      return { action: "continue" };
    }

    return {
      action: "transform",
      text: sanitized,
      images: event.images,
    };
  });
}
