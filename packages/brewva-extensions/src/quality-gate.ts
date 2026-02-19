import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";

export function registerQualityGate(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  pi.on("tool_call", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const access = runtime.checkToolAccess(sessionId, event.toolName);
    if (!access.allowed) {
      return {
        block: true,
        reason: access.reason ?? "Tool call blocked by skill contract policy.",
      };
    }

    runtime.markToolCall(sessionId, event.toolName);
    runtime.trackToolCallStart({
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.input as Record<string, unknown> | undefined,
    });
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
