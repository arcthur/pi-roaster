import { listSkillOutputs, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_NUDGES_PER_PROMPT = 2;

function formatGuardMessage(skillName: string, outputs: string[]): string {
  const required = outputs.length > 0 ? outputs.join(", ") : "(none)";
  return [
    "[Brewva Completion Guard]",
    `Active skill is still active: ${skillName}`,
    "",
    "You MUST complete the active skill before stopping.",
    "Call tool `skill_complete` with `outputs` that satisfy the contract.",
    "",
    `Required outputs: ${required}`,
    "Output values must be non-empty (string/array/object).",
  ].join("\n");
}

export function registerCompletionGuard(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const hooks = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createCompletionGuardLifecycle(pi, runtime);
  hooks.on("agent_end", lifecycle.agentEnd);
  hooks.on("session_shutdown", lifecycle.sessionShutdown);
}

export interface CompletionGuardLifecycle {
  agentEnd: (event: unknown, ctx: unknown) => undefined;
  sessionShutdown: (event: unknown, ctx: unknown) => undefined;
}

export function createCompletionGuardLifecycle(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
): CompletionGuardLifecycle {
  const nudgeCounts = new Map<string, number>();

  return {
    agentEnd(_event, ctx) {
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      const active = runtime.skills.getActive(sessionId);
      if (!active) {
        nudgeCounts.delete(sessionId);
        return undefined;
      }

      const count = (nudgeCounts.get(sessionId) ?? 0) + 1;
      nudgeCounts.set(sessionId, count);

      if (count > MAX_NUDGES_PER_PROMPT) {
        (ctx as { ui: { notify: (message: string, level: string) => void } }).ui.notify(
          `Brewva guard: active skill '${active.name}' was not completed (missing skill_complete).`,
          "warning",
        );
        return undefined;
      }

      pi.sendMessage(
        {
          customType: "brewva-guard",
          content: formatGuardMessage(active.name, listSkillOutputs(active.contract)),
          display: true,
          details: { sessionId, skill: active.name, count },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );

      return undefined;
    },
    sessionShutdown(_event, ctx) {
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      nudgeCounts.delete(sessionId);
      return undefined;
    },
  };
}
