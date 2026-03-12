import type {
  SkillContract,
  SkillCostHint,
  SkillEffectLevel,
  SkillExecutionHints,
  SkillIntentContract,
  SkillOutputContract,
  SkillResourceBudget,
  ToolEffectClass,
} from "../types.js";

const READ_ONLY_EFFECTS: ToolEffectClass[] = ["workspace_read", "runtime_observe"];
const EXECUTE_EFFECTS = new Set<ToolEffectClass>(["local_exec", "external_network"]);
const MUTATION_EFFECTS = new Set<ToolEffectClass>([
  "workspace_write",
  "external_side_effect",
  "schedule_mutation",
  "memory_write",
]);

export function resolveSkillIntent(contract: SkillContract | undefined): SkillIntentContract {
  return contract?.intent ?? {};
}

export function listSkillOutputs(contract: SkillContract | undefined): string[] {
  return [...(resolveSkillIntent(contract).outputs ?? [])];
}

export function getSkillOutputContracts(
  contract: SkillContract | undefined,
): Record<string, SkillOutputContract> {
  return { ...resolveSkillIntent(contract).outputContracts };
}

export function deriveSkillEffectLevel(
  effects: Iterable<ToolEffectClass> | undefined,
): SkillEffectLevel {
  if (!effects) {
    return "read_only";
  }

  let level: SkillEffectLevel = "read_only";
  for (const effect of effects) {
    if (MUTATION_EFFECTS.has(effect)) {
      return "mutation";
    }
    if (EXECUTE_EFFECTS.has(effect)) {
      level = "execute";
    }
  }
  return level;
}

export function resolveSkillEffectLevel(contract: SkillContract | undefined): SkillEffectLevel {
  const explicit = contract?.effects?.allowedEffects;
  return deriveSkillEffectLevel(explicit !== undefined ? explicit : READ_ONLY_EFFECTS);
}

export function listSkillAllowedEffects(contract: SkillContract | undefined): ToolEffectClass[] {
  const explicit = contract?.effects?.allowedEffects;
  if (explicit !== undefined) {
    return [...explicit];
  }
  return [...READ_ONLY_EFFECTS];
}

export function listSkillDeniedEffects(contract: SkillContract | undefined): ToolEffectClass[] {
  return [...(contract?.effects?.deniedEffects ?? [])];
}

export function resolveSkillExecutionHints(
  contract: SkillContract | undefined,
): SkillExecutionHints {
  return contract?.executionHints ?? {};
}

export function listSkillPreferredTools(contract: SkillContract | undefined): string[] {
  return [...(resolveSkillExecutionHints(contract).preferredTools ?? [])];
}

export function listSkillFallbackTools(contract: SkillContract | undefined): string[] {
  return [...(resolveSkillExecutionHints(contract).fallbackTools ?? [])];
}

export function getSkillCostHint(contract: SkillContract | undefined): SkillCostHint {
  return resolveSkillExecutionHints(contract).costHint ?? "medium";
}

export function resolveSkillDefaultLease(
  contract: SkillContract | undefined,
): SkillResourceBudget | undefined {
  return contract?.resources?.defaultLease;
}

export function resolveSkillHardCeiling(
  contract: SkillContract | undefined,
): SkillResourceBudget | undefined {
  return contract?.resources?.hardCeiling;
}
