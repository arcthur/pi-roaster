import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineTool } from "./utils/tool.js";

export function createSkillCompleteTool(options: BrewvaToolOptions): ToolDefinition {
  return defineTool({
    name: "skill_complete",
    label: "Skill Complete",
    description: "Validate skill outputs against contract and complete the active skill.",
    parameters: Type.Object({
      outputs: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const outputs = params.outputs;

      const completion = options.runtime.skills.validateOutputs(sessionId, outputs);
      if (!completion.ok) {
        return failTextResult(
          `Skill completion rejected. Missing required outputs: ${completion.missing.join(", ")}`,
          { ok: false, missing: completion.missing },
        );
      }

      const verification = await options.runtime.verification.verify(sessionId, undefined, {
        executeCommands: options.verification?.executeCommands,
        timeoutMs: options.verification?.timeoutMs,
      });

      if (!verification.passed) {
        return inconclusiveTextResult(
          `Verification gate blocked. Skill not completed: ${verification.missingEvidence.join(", ")}`,
          {
            ok: false,
            verification,
          },
        );
      }

      options.runtime.skills.complete(sessionId, outputs);
      const intent = options.runtime.skills.getCascadeIntent
        ? options.runtime.skills.getCascadeIntent(sessionId)
        : undefined;
      const nextStep = intent?.steps[intent.cursor];
      const hasNextStep =
        intent &&
        (intent.status === "pending" || intent.status === "paused") &&
        nextStep &&
        typeof nextStep.skill === "string" &&
        nextStep.skill.length > 0;
      const cascadeHint = hasNextStep
        ? ` Next cascade step: ${nextStep.skill} (use skill_load name=${nextStep.skill}).`
        : "";

      const message =
        (verification.readOnly
          ? "Skill completed (read-only, no verification needed)."
          : "Skill completed and verification gate passed.") + cascadeHint;
      return textResult(message, {
        ok: true,
        verification,
        cascade: intent
          ? {
              status: intent.status,
              cursor: intent.cursor,
              steps: intent.steps.length,
              nextSkill: hasNextStep ? nextStep.skill : null,
              intentId: intent.id,
              source: intent.source,
            }
          : null,
      });
    },
  });
}
