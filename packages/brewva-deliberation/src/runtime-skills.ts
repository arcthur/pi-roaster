import {
  planSkillChain,
  type BrewvaRuntime,
  type SkillChainPlannerResult,
  type SkillDocument,
  type SkillsIndexEntry,
  getSkillCostHint,
  listSkillAllowedEffects,
  listSkillFallbackTools,
  listSkillOutputs,
  listSkillPreferredTools,
  resolveSkillEffectLevel,
} from "@brewva/brewva-runtime";

type SkillRuntime = Pick<BrewvaRuntime, "skills">;

export function toSkillsIndexEntry(skill: SkillDocument): SkillsIndexEntry {
  return {
    name: skill.name,
    category: skill.category,
    description: skill.description,
    outputs: listSkillOutputs(skill.contract),
    preferredTools: listSkillPreferredTools(skill.contract),
    fallbackTools: listSkillFallbackTools(skill.contract),
    allowedEffects: listSkillAllowedEffects(skill.contract),
    costHint: getSkillCostHint(skill.contract),
    stability: skill.contract.stability ?? "stable",
    composableWith: [...(skill.contract.composableWith ?? [])],
    consumes: [...(skill.contract.consumes ?? [])],
    requires: [...(skill.contract.requires ?? [])],
    effectLevel: resolveSkillEffectLevel(skill.contract),
    dispatch: skill.contract.dispatch,
    routingScope: skill.contract.routing?.scope,
  };
}

export function listAvailableOutputs(runtime: SkillRuntime, sessionId: string): string[] {
  const available = new Set<string>();
  for (const skill of runtime.skills.list()) {
    const outputs = runtime.skills.getOutputs(sessionId, skill.name);
    if (!outputs) continue;
    for (const key of Object.keys(outputs)) {
      const normalized = key.trim();
      if (normalized.length > 0) {
        available.add(normalized);
      }
    }
  }
  return [...available];
}

export function buildSkillsIndex(runtime: SkillRuntime): SkillsIndexEntry[] {
  return runtime.skills.list().map(toSkillsIndexEntry);
}

export function planChainForRuntimeSelection(input: {
  runtime: SkillRuntime;
  sessionId: string;
  primarySkillName: string;
}): {
  primary: SkillsIndexEntry;
  index: SkillsIndexEntry[];
  result: SkillChainPlannerResult;
} | null {
  const index = buildSkillsIndex(input.runtime);
  const primary = index.find((entry) => entry.name === input.primarySkillName);
  if (!primary) return null;
  return {
    primary,
    index,
    result: planSkillChain({
      primary,
      index,
      availableOutputs: listAvailableOutputs(input.runtime, input.sessionId),
    }),
  };
}
