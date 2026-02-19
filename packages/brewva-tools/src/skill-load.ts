import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { BrewvaToolOptions } from "./types.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";

function formatSkillOutput(input: {
  name: string;
  baseDir: string;
  markdown: string;
  contract: {
    tools: { required: string[]; optional: string[]; denied: string[] };
    budget: { maxToolCalls: number; maxTokens: number };
    outputs?: string[];
    consumes?: string[];
  };
  availableConsumedOutputs?: Record<string, unknown>;
}): string {
  const outputs = input.contract.outputs?.length ? input.contract.outputs.join(", ") : "(none)";
  const consumes = input.contract.consumes?.length ? input.contract.consumes.join(", ") : "(none)";

  const lines = [
    `# Skill Loaded: ${input.name}`,
    `Base directory: ${input.baseDir}`,
    "",
    "## Contract",
    `- required tools: ${input.contract.tools.required.join(", ") || "(none)"}`,
    `- optional tools: ${input.contract.tools.optional.join(", ") || "(none)"}`,
    `- denied tools: ${input.contract.tools.denied.join(", ") || "(none)"}`,
    `- max tool calls: ${input.contract.budget.maxToolCalls}`,
    `- max tokens: ${input.contract.budget.maxTokens}`,
    `- required outputs: ${outputs}`,
    `- consumes: ${consumes}`,
  ];

  if (input.availableConsumedOutputs && Object.keys(input.availableConsumedOutputs).length > 0) {
    lines.push("");
    lines.push("## Available Data from Prior Skills");
    for (const [key, value] of Object.entries(input.availableConsumedOutputs)) {
      const valueStr = typeof value === "string" ? value : JSON.stringify(value);
      const truncated = valueStr.length > 500 ? `${valueStr.slice(0, 497)}...` : valueStr;
      lines.push(`- ${key}: ${truncated}`);
    }
  }

  lines.push("");
  lines.push("## Instructions");
  lines.push(input.markdown);

  return lines.join("\n");
}

export function createSkillLoadTool(options: BrewvaToolOptions): ToolDefinition<any> {
  return {
    name: "skill_load",
    label: "Skill Load",
    description: "Load a skill by name, activate its contract, and return full skill instructions.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name from selector candidates" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.activateSkill(sessionId, params.name);
      if (!result.ok || !result.skill) {
        return textResult(`Error: ${result.reason ?? "Skill activation failed."}`, { ok: false });
      }

      const availableConsumedOutputs = options.runtime.getAvailableConsumedOutputs(sessionId, params.name);

      return textResult(
        formatSkillOutput({
          name: result.skill.name,
          baseDir: result.skill.baseDir,
          markdown: result.skill.markdown,
          contract: result.skill.contract,
          availableConsumedOutputs,
        }),
        {
          ok: true,
          sessionId,
          skill: result.skill.name,
        },
      );
    },
  };
}
