import { getToolGovernanceDescriptor } from "../governance/tool-governance.js";
import { listSkillAllowedEffects, listSkillDeniedEffects } from "../skills/facets.js";
import type { SkillContract, ToolAccessResult, ToolEffectClass } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";

export interface ToolPolicyOptions {
  enforceDeniedEffects: boolean;
  effectAuthorizationMode: "off" | "warn" | "enforce";
  alwaysAllowedTools?: string[];
}

function normalizeToolList(tools: string[]): string[] {
  return tools.map((tool) => normalizeToolName(tool)).filter((tool) => tool.length > 0);
}

function setFromEffects(effects: ToolEffectClass[] | undefined): Set<ToolEffectClass> {
  return new Set((effects ?? []).filter((effect) => typeof effect === "string"));
}

function difference<T>(left: Iterable<T>, right: Set<T>): T[] {
  const missing: T[] = [];
  for (const value of left) {
    if (!right.has(value)) {
      missing.push(value);
    }
  }
  return missing;
}

export function checkToolAccess(
  contract: SkillContract | undefined,
  toolName: string,
  options: ToolPolicyOptions,
): ToolAccessResult {
  if (!contract) return { allowed: true };

  const normalized = normalizeToolName(toolName);
  if (!normalized) return { allowed: true };

  const alwaysAllowed = new Set(normalizeToolList(options.alwaysAllowedTools ?? []));
  if (alwaysAllowed.has(normalized)) {
    return { allowed: true };
  }

  const descriptor = getToolGovernanceDescriptor(normalized);
  if (!descriptor) {
    const warning = `Tool '${normalized}' is missing effect governance metadata; effect authorization cannot be enforced for it yet.`;
    return { allowed: true, warning };
  }

  const deniedEffects = setFromEffects(listSkillDeniedEffects(contract));
  const violatedDeniedEffects = descriptor.effects.filter((effect) => deniedEffects.has(effect));
  if (options.enforceDeniedEffects && violatedDeniedEffects.length > 0) {
    return {
      allowed: false,
      reason: `Tool '${normalized}' performs denied effects for skill '${contract.name}': ${violatedDeniedEffects.join(", ")}.`,
    };
  }

  if (options.effectAuthorizationMode === "off") {
    return { allowed: true };
  }

  const allowedEffects = setFromEffects(listSkillAllowedEffects(contract));
  const unauthorizedEffects = difference(descriptor.effects, allowedEffects);
  if (unauthorizedEffects.length > 0) {
    const reason = `Tool '${normalized}' requires unauthorized effects for skill '${contract.name}': ${unauthorizedEffects.join(", ")}.`;
    if (options.effectAuthorizationMode === "warn") {
      return { allowed: true, warning: reason };
    }
    return { allowed: false, reason };
  }
  return { allowed: true };
}
