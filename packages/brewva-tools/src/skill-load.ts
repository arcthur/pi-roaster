import type { SkillContract, SkillResourceSet, ToolEffectClass } from "@brewva/brewva-runtime";
import {
  getSkillCostHint,
  getSkillOutputContracts,
  listSkillAllowedEffects,
  listSkillDeniedEffects,
  listSkillFallbackTools,
  listSkillOutputs,
  listSkillPreferredTools,
  resolveSkillDefaultLease,
  resolveSkillEffectLevel,
  resolveSkillHardCeiling,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

function formatSkillOutput(input: {
  name: string;
  category: string;
  baseDir: string;
  markdown: string;
  contract: SkillContract;
  resources?: SkillResourceSet;
  availableConsumedOutputs?: Record<string, unknown>;
}): string {
  const outputsList = listSkillOutputs(input.contract);
  const outputs = outputsList.length > 0 ? outputsList.join(", ") : "(none)";
  const requires = input.contract.requires?.length ? input.contract.requires.join(", ") : "(none)";
  const consumes = input.contract.consumes?.length ? input.contract.consumes.join(", ") : "(none)";
  const outputContracts = getSkillOutputContracts(input.contract);
  const defaultLease = resolveSkillDefaultLease(input.contract);
  const hardCeiling = resolveSkillHardCeiling(input.contract);
  const preferredTools = listSkillPreferredTools(input.contract);
  const fallbackTools = listSkillFallbackTools(input.contract);
  const allowedEffects = listSkillAllowedEffects(input.contract);
  const deniedEffects = listSkillDeniedEffects(input.contract);

  const formatEffects = (effects: ToolEffectClass[]): string =>
    effects.length > 0 ? effects.join(", ") : "(none)";
  const formatBudget = (budget: typeof defaultLease): string =>
    budget
      ? [
          `max_tool_calls=${budget.maxToolCalls ?? "(unset)"}`,
          `max_tokens=${budget.maxTokens ?? "(unset)"}`,
          `max_parallel=${budget.maxParallel ?? "(unset)"}`,
        ].join(", ")
      : "(none)";

  const lines = [
    `# Skill Loaded: ${input.name}`,
    `Category: ${input.category}`,
    `Base directory: ${input.baseDir}`,
    "",
    "## Contract",
    `- effect level: ${resolveSkillEffectLevel(input.contract)}`,
    `- allowed effects: ${formatEffects(allowedEffects)}`,
    `- denied effects: ${formatEffects(deniedEffects)}`,
    `- preferred tools: ${preferredTools.join(", ") || "(none)"}`,
    `- fallback tools: ${fallbackTools.join(", ") || "(none)"}`,
    `- cost hint: ${getSkillCostHint(input.contract)}`,
    `- default lease: ${formatBudget(defaultLease)}`,
    `- hard ceiling: ${formatBudget(hardCeiling)}`,
    `- required outputs: ${outputs}`,
    `- output contracts: ${Object.keys(outputContracts).join(", ") || "(none)"}`,
    `- required inputs: ${requires}`,
    `- optional inputs: ${consumes}`,
    `- routing scope: ${input.contract.routing?.scope ?? "(not routable)"}`,
  ];

  if (input.resources) {
    lines.push("");
    lines.push("## Resources");
    lines.push(`- references: ${input.resources.references.join(", ") || "(none)"}`);
    lines.push(`- scripts: ${input.resources.scripts.join(", ") || "(none)"}`);
    lines.push(`- heuristics: ${input.resources.heuristics.join(", ") || "(none)"}`);
    lines.push(`- invariants: ${input.resources.invariants.join(", ") || "(none)"}`);
  }

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

export function createSkillLoadTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "skill_load",
    label: "Skill Load",
    description: "Load a skill by name, activate its contract, and return full skill instructions.",
    promptSnippet:
      "Load the selected skill contract and working instructions before executing the skill.",
    promptGuidelines: [
      "When a pending skill recommendation exists, load the selected skill before implementation.",
      "Use the exact selected skill name.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "Skill name from an accepted proposal or explicit operator choice",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.skills.activate(sessionId, params.name);
      if (!result.ok || !result.skill) {
        return failTextResult(`Error: ${result.reason ?? "Skill activation failed."}`, {
          ok: false,
        });
      }

      const availableConsumedOutputs = options.runtime.skills.getConsumedOutputs(
        sessionId,
        params.name,
      );

      return textResult(
        formatSkillOutput({
          name: result.skill.name,
          category: result.skill.category,
          baseDir: result.skill.baseDir,
          markdown: result.skill.markdown,
          contract: result.skill.contract,
          resources: result.skill.resources,
          availableConsumedOutputs,
        }),
        {
          ok: true,
          sessionId,
          skill: result.skill.name,
        },
      );
    },
  });
}
