import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { textResult } from "./utils/result.js";
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
        return textResult(
          `Skill completion rejected. Missing required outputs: ${completion.missing.join(", ")}`,
          { ok: false, missing: completion.missing },
        );
      }

      const verification = await options.runtime.verification.verify(sessionId, undefined, {
        executeCommands: options.verification?.executeCommands,
        timeoutMs: options.verification?.timeoutMs,
      });

      if (!verification.passed) {
        return textResult(
          `Verification gate blocked. Skill not completed: ${verification.missingEvidence.join(", ")}`,
          {
            ok: false,
            verification,
          },
        );
      }

      options.runtime.skills.complete(sessionId, outputs);
      return textResult("Skill completed and verification gate passed.", {
        ok: true,
        verification,
      });
    },
  });
}
