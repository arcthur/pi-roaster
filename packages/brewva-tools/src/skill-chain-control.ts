import type { SkillChainIntent } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const SkillChainControlActionSchema = Type.Union([
  Type.Literal("status"),
  Type.Literal("pause"),
  Type.Literal("resume"),
  Type.Literal("cancel"),
  Type.Literal("start"),
]);

function formatIntent(intent: SkillChainIntent): string {
  const lines = [
    "# Skill Cascade",
    `- id: ${intent.id}`,
    `- source: ${intent.source}`,
    `- status: ${intent.status}`,
    `- cursor: ${intent.cursor}/${intent.steps.length}`,
    `- retries: ${intent.retries}`,
    `- unresolved_consumes: ${
      intent.unresolvedConsumes.length > 0 ? intent.unresolvedConsumes.join(", ") : "(none)"
    }`,
    "- steps:",
  ];
  for (const [index, step] of intent.steps.entries()) {
    const marker = index === intent.cursor ? ">" : "-";
    const consumes = step.consumes.length > 0 ? step.consumes.join(", ") : "(none)";
    const produces = step.produces.length > 0 ? step.produces.join(", ") : "(none)";
    lines.push(
      `  ${marker} ${index + 1}. ${step.skill} (consumes=${consumes}; produces=${produces})`,
    );
  }
  return lines.join("\n");
}

export function createSkillChainControlTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "skill_chain_control",
    label: "Skill Chain Control",
    description:
      "Inspect or control skill cascade intent lifecycle (status, pause, resume, cancel, start explicit chain).",
    promptSnippet:
      "Inspect or control an active skill cascade when status, pause, resume, cancel, or explicit chaining is needed.",
    promptGuidelines: [
      "Use status before altering an unclear cascade state.",
      "Use start only for an explicit multi-step skill plan.",
    ],
    parameters: Type.Object({
      action: SkillChainControlActionSchema,
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      steps: Type.Optional(
        Type.Array(
          Type.Object({
            skill: Type.String({ minLength: 1, maxLength: 120 }),
            consumes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }))),
            produces: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }))),
            lane: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          }),
          { minItems: 1, maxItems: 64 },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const runtimeSkills = options.runtime.skills;

      if (!runtimeSkills.getCascadeIntent) {
        return failTextResult("Cascade control is not available in this runtime.", {
          ok: false,
          error: "cascade_unavailable",
        });
      }

      if (params.action === "status") {
        const intent = runtimeSkills.getCascadeIntent(sessionId);
        if (!intent) {
          return textResult("No active or historical skill cascade intent found.", {
            ok: true,
            status: "none",
          });
        }
        return textResult(formatIntent(intent), {
          ok: true,
          status: intent.status,
          intentId: intent.id,
        });
      }

      if (params.action === "pause") {
        if (!runtimeSkills.pauseCascade) {
          return failTextResult("Cascade pause is not available in this runtime.", {
            ok: false,
            error: "cascade_pause_unavailable",
          });
        }
        const result = runtimeSkills.pauseCascade(sessionId, params.reason);
        if (!result.ok) {
          return failTextResult(`Cascade pause rejected (${result.reason ?? "unknown"}).`, {
            ok: false,
            error: result.reason ?? "unknown",
          });
        }
        const intent = runtimeSkills.getCascadeIntent(sessionId);
        return textResult(intent ? formatIntent(intent) : "Cascade paused.", {
          ok: true,
          status: intent?.status ?? "paused",
        });
      }

      if (params.action === "resume") {
        if (!runtimeSkills.resumeCascade) {
          return failTextResult("Cascade resume is not available in this runtime.", {
            ok: false,
            error: "cascade_resume_unavailable",
          });
        }
        const result = runtimeSkills.resumeCascade(sessionId, params.reason);
        if (!result.ok) {
          return failTextResult(`Cascade resume rejected (${result.reason ?? "unknown"}).`, {
            ok: false,
            error: result.reason ?? "unknown",
          });
        }
        const intent = runtimeSkills.getCascadeIntent(sessionId);
        return textResult(intent ? formatIntent(intent) : "Cascade resumed.", {
          ok: true,
          status: intent?.status ?? "pending",
        });
      }

      if (params.action === "cancel") {
        if (!runtimeSkills.cancelCascade) {
          return failTextResult("Cascade cancel is not available in this runtime.", {
            ok: false,
            error: "cascade_cancel_unavailable",
          });
        }
        const result = runtimeSkills.cancelCascade(sessionId, params.reason);
        if (!result.ok) {
          return failTextResult(`Cascade cancel rejected (${result.reason ?? "unknown"}).`, {
            ok: false,
            error: result.reason ?? "unknown",
          });
        }
        const intent = runtimeSkills.getCascadeIntent(sessionId);
        return textResult(intent ? formatIntent(intent) : "Cascade cancelled.", {
          ok: true,
          status: intent?.status ?? "cancelled",
        });
      }

      if (!runtimeSkills.startCascade) {
        return failTextResult("Cascade start is not available in this runtime.", {
          ok: false,
          error: "cascade_start_unavailable",
        });
      }
      if (!params.steps || params.steps.length === 0) {
        return failTextResult("Cascade start rejected (missing_steps).", {
          ok: false,
          error: "missing_steps",
        });
      }
      const started = runtimeSkills.startCascade(sessionId, {
        steps: params.steps,
      });
      if (!started.ok) {
        return failTextResult(`Cascade start rejected (${started.reason ?? "unknown"}).`, {
          ok: false,
          error: started.reason ?? "unknown",
        });
      }
      const intent = runtimeSkills.getCascadeIntent(sessionId);
      return textResult(intent ? formatIntent(intent) : "Cascade started.", {
        ok: true,
        status: intent?.status ?? "pending",
      });
    },
  });
}
