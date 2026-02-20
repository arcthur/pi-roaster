import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerMemoryBridge(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  pi.on("agent_end", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    runtime.memory.refreshIfNeeded({ sessionId });
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    runtime.memory.clearSessionCache(sessionId);
    return undefined;
  });
}
