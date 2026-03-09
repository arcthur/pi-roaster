import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineTool } from "./utils/tool.js";

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function createSkillRouteOverrideTool(options: BrewvaToolOptions): ToolDefinition {
  return defineTool({
    name: "skill_route_override",
    label: "Skill Route Override",
    description: "Explicitly bypass pending skill dispatch gate when intentional.",
    parameters: Type.Object({
      reason: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 280,
          description: "Why bypassing the dispatch recommendation is intentional.",
        }),
      ),
      targetSkillName: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 120,
          description: "Optional skill name to follow after override.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.skills.overridePendingDispatch(sessionId, {
        reason: normalizeOptionalText(params.reason),
        targetSkillName: normalizeOptionalText(params.targetSkillName),
      });

      if (!result.ok) {
        return failTextResult(result.reason ?? "No pending skill dispatch to override.", {
          ok: false,
        });
      }

      const primary = result.decision?.primary?.name ?? "unknown";
      return textResult(`Skill dispatch override accepted. Previous primary was '${primary}'.`, {
        ok: true,
        primary,
        mode: result.decision?.mode ?? null,
      });
    },
  });
}
