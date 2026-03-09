import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerScanConvergenceGuard(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  pi.on("turn_end", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    runtime.context.onTurnEnd(sessionId);
    return undefined;
  });
}
