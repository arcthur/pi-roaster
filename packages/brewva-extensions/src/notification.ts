import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function buildActionableNotification(
  runtime: BrewvaRuntime,
  sessionId: string,
): string | undefined {
  const budget = runtime.getCostSummary(sessionId).budget;
  if (budget.blocked) {
    return "Brewva: cost budget is blocking tools in this session.";
  }

  const blockers = runtime.getTaskState(sessionId).blockers;
  if (blockers.length > 0) {
    return `Brewva: ${blockers.length} unresolved blocker(s) remain.`;
  }

  return undefined;
}

export function registerNotification(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  pi.on("agent_end", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const message = buildActionableNotification(runtime, sessionId);
    if (!message) return;
    ctx.ui.notify(message, "warning");
  });
}
