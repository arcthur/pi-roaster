import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export function getSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}
