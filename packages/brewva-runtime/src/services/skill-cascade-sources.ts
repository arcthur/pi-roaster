import { listSkillOutputs } from "../skills/facets.js";
import type { SkillRegistry } from "../skills/registry.js";
import type {
  SkillCascadeChainCandidate,
  SkillCascadeChainSource,
  SkillCascadeDispatchSourceInput,
  SkillCascadeExplicitSourceInput,
  SkillChainIntentStep,
} from "../types.js";

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeConsumeRef(input: string): string {
  const normalized = input.trim();
  if (!normalized) return "";
  const dotIndex = normalized.lastIndexOf(".");
  const terminal =
    dotIndex > 0 && dotIndex < normalized.length - 1
      ? normalized.slice(dotIndex + 1).trim()
      : normalized;
  if (!terminal) return "";
  return terminal;
}

function buildRegistryStep(
  skills: SkillRegistry,
  skillName: string,
  prefix: string,
): SkillChainIntentStep | null {
  const skill = skills.get(skillName);
  if (!skill) return null;
  return {
    id: `${prefix}:${skill.name}`,
    skill: skill.name,
    consumes: [...(skill.contract.requires ?? [])],
    produces: listSkillOutputs(skill.contract),
  };
}

export class DispatchSkillCascadeChainSource implements SkillCascadeChainSource {
  readonly source = "dispatch" as const;
  private readonly skills: SkillRegistry;

  constructor(skills: SkillRegistry) {
    this.skills = skills;
  }

  fromDispatch(input: SkillCascadeDispatchSourceInput): SkillCascadeChainCandidate | null {
    const unresolved: string[] = [];
    const seen = new Set<string>();
    const steps: SkillChainIntentStep[] = [];
    const candidateNames =
      input.decision.chain.length > 0
        ? input.decision.chain
        : input.decision.primary?.name
          ? [input.decision.primary.name]
          : [];
    for (const [index, skillName] of candidateNames.entries()) {
      if (steps.length >= input.maxStepsPerRun) {
        unresolved.push("max_steps_per_run");
        break;
      }
      const normalized = skillName.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const step = buildRegistryStep(this.skills, normalized, `dispatch-${index + 1}`);
      if (!step) {
        unresolved.push(`missing_skill:${normalized}`);
        continue;
      }
      steps.push(step);
    }
    if (steps.length === 0) return null;
    return {
      source: this.source,
      steps,
      unresolvedConsumes: unresolved,
    };
  }
}

export class ExplicitSkillCascadeChainSource implements SkillCascadeChainSource {
  readonly source = "explicit" as const;

  fromExplicit(input: SkillCascadeExplicitSourceInput): SkillCascadeChainCandidate | null {
    if (input.steps.length === 0) return null;
    const steps: SkillChainIntentStep[] = [];
    for (const [index, step] of input.steps.entries()) {
      const skill = step.skill.trim();
      if (!skill) continue;
      const consumes = normalizeStringArray(step.consumes)
        .map((item) => normalizeConsumeRef(item))
        .filter((item) => item.length > 0);
      const produces = normalizeStringArray(step.produces)
        .map((item) => normalizeConsumeRef(item))
        .filter((item) => item.length > 0);
      const lane =
        typeof step.lane === "string" && step.lane.trim().length > 0 ? step.lane.trim() : undefined;
      steps.push({
        id: `explicit-${index + 1}:${skill}`,
        skill,
        consumes,
        produces,
        lane,
      });
    }
    if (steps.length === 0) return null;
    return {
      source: this.source,
      steps,
      unresolvedConsumes: [],
    };
  }
}

export function createDefaultSkillCascadeChainSources(
  skills: SkillRegistry,
): SkillCascadeChainSource[] {
  return [new DispatchSkillCascadeChainSource(skills), new ExplicitSkillCascadeChainSource()];
}
