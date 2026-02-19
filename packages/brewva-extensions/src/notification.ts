import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerNotification(pi: ExtensionAPI): void {
  pi.on("agent_end", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.notify("Brewva: agent turn completed.", "info");
  });
}
