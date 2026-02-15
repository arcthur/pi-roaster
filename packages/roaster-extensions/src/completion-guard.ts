import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RoasterRuntime } from "@pi-roaster/roaster-runtime";

const MAX_NUDGES_PER_PROMPT = 2;

function formatGuardMessage(skillName: string, outputs: string[]): string {
  const required = outputs.length > 0 ? outputs.join(", ") : "(none)";
  return [
    "[Roaster Completion Guard]",
    `Active skill is still active: ${skillName}`,
    "",
    "You MUST complete the active skill before stopping.",
    "Call tool `skill_complete` with `outputs` that satisfy the contract.",
    "",
    `Required outputs: ${required}`,
    "Output values must be non-empty (string/array/object).",
  ].join("\n");
}

export function registerCompletionGuard(pi: ExtensionAPI, runtime: RoasterRuntime): void {
  const nudgeCounts = new Map<string, number>();

  pi.on("agent_end", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const active = runtime.getActiveSkill(sessionId);
    if (!active) {
      nudgeCounts.delete(sessionId);
      return undefined;
    }

    const count = (nudgeCounts.get(sessionId) ?? 0) + 1;
    nudgeCounts.set(sessionId, count);

    if (count > MAX_NUDGES_PER_PROMPT) {
      ctx.ui.notify(
        `Roaster guard: active skill '${active.name}' was not completed (missing skill_complete).`,
        "warning",
      );
      return undefined;
    }

    pi.sendMessage(
      {
        customType: "roaster-guard",
        content: formatGuardMessage(active.name, active.contract.outputs ?? []),
        display: true,
        details: { sessionId, skill: active.name, count },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );

    return undefined;
  });
}

