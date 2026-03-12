import type { SkillEffectLevel, SkillsIndexEntry } from "../types.js";
import { deriveSkillEffectLevel } from "./facets.js";

export interface SkillChainPlannerInput {
  primary: SkillsIndexEntry;
  index: SkillsIndexEntry[];
  availableOutputs?: Iterable<string>;
}

export interface SkillChainPlannerResult {
  chain: string[];
  prerequisites: string[];
  unresolvedConsumes: string[];
}

export interface SkillChainValidationInput {
  chain: string[];
  index: SkillsIndexEntry[];
  availableOutputs?: Iterable<string>;
}

export interface SkillChainValidationResult {
  valid: boolean;
  missing: string[];
}

const COST_RANK: Record<SkillsIndexEntry["costHint"], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const STABILITY_RANK: Record<SkillsIndexEntry["stability"], number> = {
  stable: 0,
  experimental: 1,
  deprecated: 2,
};

const EFFECT_RANK: Record<SkillEffectLevel, number> = {
  read_only: 0,
  execute: 1,
  mutation: 2,
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveCostHint(value: unknown): SkillsIndexEntry["costHint"] {
  if (value === "low" || value === "high" || value === "medium") {
    return value;
  }
  return "medium";
}

function resolveStability(value: unknown): SkillsIndexEntry["stability"] {
  if (value === "experimental" || value === "deprecated" || value === "stable") {
    return value;
  }
  return "stable";
}

function resolveEffectLevel(value: unknown): SkillEffectLevel {
  if (value === "read_only" || value === "execute" || value === "mutation") {
    return value;
  }
  return "read_only";
}

function resolveEntryEffectLevel(entry: SkillsIndexEntry): SkillEffectLevel {
  return entry.allowedEffects.length > 0
    ? deriveSkillEffectLevel(entry.allowedEffects)
    : resolveEffectLevel(entry.effectLevel);
}

function hasOutput(entry: SkillsIndexEntry, outputName: string): boolean {
  return normalizeStringArray(entry.outputs).some((value) => value === outputName);
}

function resolveRequiredInputs(entry: SkillsIndexEntry): string[] {
  return normalizeStringArray(entry.requires);
}

function resolveComposableRank(consumer: SkillsIndexEntry, candidate: SkillsIndexEntry): number {
  const consumerAllows = normalizeStringArray(consumer.composableWith).includes(candidate.name);
  if (consumerAllows) return 0;
  const candidateAllows = normalizeStringArray(candidate.composableWith).includes(consumer.name);
  if (candidateAllows) return 1;
  return 2;
}

function isProducerEffectCompatible(
  primary: SkillsIndexEntry,
  candidate: SkillsIndexEntry,
): boolean {
  return (
    EFFECT_RANK[resolveEntryEffectLevel(candidate)] <= EFFECT_RANK[resolveEntryEffectLevel(primary)]
  );
}

function compareProducer(
  consumer: SkillsIndexEntry,
  left: SkillsIndexEntry,
  right: SkillsIndexEntry,
): number {
  const composableRankDiff =
    resolveComposableRank(consumer, left) - resolveComposableRank(consumer, right);
  if (composableRankDiff !== 0) return composableRankDiff;

  const effectDiff =
    EFFECT_RANK[resolveEntryEffectLevel(left)] - EFFECT_RANK[resolveEntryEffectLevel(right)];
  if (effectDiff !== 0) return effectDiff;

  const costDiff =
    COST_RANK[resolveCostHint(left.costHint)] - COST_RANK[resolveCostHint(right.costHint)];
  if (costDiff !== 0) return costDiff;

  const stabilityDiff =
    STABILITY_RANK[resolveStability(left.stability)] -
    STABILITY_RANK[resolveStability(right.stability)];
  if (stabilityDiff !== 0) return stabilityDiff;

  return left.name.localeCompare(right.name);
}

function normalizeOutputSet(input?: Iterable<string>): Set<string> {
  const out = new Set<string>();
  if (!input) return out;
  for (const rawValue of input) {
    const normalized = rawValue.trim();
    if (!normalized) continue;
    out.add(normalized);
  }
  return out;
}

function addProducedOutputs(availableOutputs: Set<string>, entry: SkillsIndexEntry): void {
  for (const producedOutput of normalizeStringArray(entry.outputs)) {
    availableOutputs.add(producedOutput);
  }
}

function selectProducer(input: {
  primary: SkillsIndexEntry;
  consumer: SkillsIndexEntry;
  outputName: string;
  index: SkillsIndexEntry[];
  excludedNames: Set<string>;
}): SkillsIndexEntry | null {
  const producers = input.index
    .filter((entry) => !input.excludedNames.has(entry.name))
    .filter((entry) => hasOutput(entry, input.outputName))
    .filter((entry) => isProducerEffectCompatible(input.primary, entry))
    .toSorted((left, right) => compareProducer(input.consumer, left, right));
  return producers[0] ?? null;
}

interface ResolvePrerequisitesState {
  readonly primary: SkillsIndexEntry;
  readonly index: SkillsIndexEntry[];
  readonly availableOutputs: Set<string>;
  readonly plannedSkills: Set<string>;
  readonly inProgress: Set<string>;
  readonly prerequisites: string[];
  readonly unresolvedConsumes: Set<string>;
}

function resolvePrerequisites(consumer: SkillsIndexEntry, state: ResolvePrerequisitesState): void {
  for (const requiredInput of resolveRequiredInputs(consumer)) {
    if (state.availableOutputs.has(requiredInput)) {
      continue;
    }

    const producer = selectProducer({
      primary: state.primary,
      consumer,
      outputName: requiredInput,
      index: state.index,
      excludedNames: new Set([...state.plannedSkills, ...state.inProgress, consumer.name]),
    });
    if (!producer) {
      state.unresolvedConsumes.add(requiredInput);
      continue;
    }

    if (state.inProgress.has(producer.name)) {
      state.unresolvedConsumes.add(requiredInput);
      continue;
    }

    state.inProgress.add(producer.name);
    resolvePrerequisites(producer, state);
    state.inProgress.delete(producer.name);

    const producerReady = resolveRequiredInputs(producer).every((value) =>
      state.availableOutputs.has(value),
    );
    if (!producerReady) {
      state.unresolvedConsumes.add(requiredInput);
      continue;
    }

    if (!state.plannedSkills.has(producer.name)) {
      state.prerequisites.push(producer.name);
      state.plannedSkills.add(producer.name);
      addProducedOutputs(state.availableOutputs, producer);
    }

    if (!state.availableOutputs.has(requiredInput)) {
      state.unresolvedConsumes.add(requiredInput);
    }
  }
}

export function validateSkillChain(input: SkillChainValidationInput): SkillChainValidationResult {
  const entriesByName = new Map(input.index.map((entry) => [entry.name, entry] as const));
  const availableOutputs = normalizeOutputSet(input.availableOutputs);
  const missing = new Set<string>();

  for (const skillName of input.chain) {
    const entry = entriesByName.get(skillName);
    if (!entry) continue;
    for (const requiredInput of resolveRequiredInputs(entry)) {
      if (!availableOutputs.has(requiredInput)) {
        missing.add(requiredInput);
      }
    }
    addProducedOutputs(availableOutputs, entry);
  }

  return {
    valid: missing.size === 0,
    missing: [...missing].toSorted((left, right) => left.localeCompare(right)),
  };
}

export function planSkillChain(input: SkillChainPlannerInput): SkillChainPlannerResult {
  const availableOutputs = normalizeOutputSet(input.availableOutputs);
  const prerequisites: string[] = [];
  const state: ResolvePrerequisitesState = {
    primary: input.primary,
    index: input.index,
    availableOutputs,
    plannedSkills: new Set<string>(),
    inProgress: new Set<string>([input.primary.name]),
    prerequisites,
    unresolvedConsumes: new Set<string>(),
  };

  resolvePrerequisites(input.primary, state);

  return {
    chain: [...prerequisites, input.primary.name],
    prerequisites,
    unresolvedConsumes: [...state.unresolvedConsumes].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  };
}
