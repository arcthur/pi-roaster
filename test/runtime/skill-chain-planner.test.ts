import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  getSkillCostHint,
  listSkillAllowedEffects,
  listSkillFallbackTools,
  listSkillOutputs,
  listSkillPreferredTools,
  parseSkillDocument,
  planSkillChain,
  resolveSkillEffectLevel,
  type SkillCategory,
  type SkillsIndexEntry,
} from "@brewva/brewva-runtime";

function createEntry(
  input: Partial<SkillsIndexEntry> & Pick<SkillsIndexEntry, "name">,
): SkillsIndexEntry {
  const effectLevel = input.effectLevel ?? "read_only";
  const allowedEffects =
    input.allowedEffects ??
    (effectLevel === "mutation"
      ? ["workspace_read", "workspace_write"]
      : effectLevel === "execute"
        ? ["workspace_read", "local_exec"]
        : ["workspace_read"]);
  return {
    name: input.name,
    category: input.category ?? "core",
    description: input.description ?? `${input.name} skill`,
    outputs: input.outputs ?? [],
    preferredTools: input.preferredTools ?? [],
    fallbackTools: input.fallbackTools ?? [],
    allowedEffects,
    costHint: input.costHint ?? "medium",
    stability: input.stability ?? "stable",
    composableWith: input.composableWith ?? [],
    consumes: input.consumes ?? [],
    requires: input.requires ?? [],
    effectLevel,
    dispatch: input.dispatch ?? {
      suggestThreshold: 10,
      autoThreshold: 16,
    },
    routingScope: input.routingScope ?? "core",
  };
}

function repoRoot(): string {
  return process.cwd();
}

function loadEntry(relativePath: string, category: SkillCategory): SkillsIndexEntry {
  const skill = parseSkillDocument(join(repoRoot(), relativePath), category);
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
    composableWith: skill.contract.composableWith ?? [],
    consumes: skill.contract.consumes ?? [],
    requires: skill.contract.requires ?? [],
    effectLevel: resolveSkillEffectLevel(skill.contract),
    dispatch: skill.contract.dispatch,
    routingScope: skill.contract.routing?.scope,
  };
}

describe("skill chain planner", () => {
  test("inserts prerequisite producer for missing required inputs", () => {
    const primary = createEntry({
      name: "debugging",
      effectLevel: "execute",
      requires: ["repository_snapshot"],
    });
    const repositoryAnalysis = createEntry({
      name: "repository-analysis",
      outputs: ["repository_snapshot"],
      composableWith: ["debugging"],
    });

    const chain = planSkillChain({
      primary,
      index: [primary, repositoryAnalysis],
    });

    expect(chain.chain).toEqual(["repository-analysis", "debugging"]);
    expect(chain.unresolvedConsumes).toEqual([]);
  });

  test("does not insert mutation producers for read_only primary skills", () => {
    const review = createEntry({
      name: "review",
      effectLevel: "read_only",
      requires: ["change_set"],
    });
    const implementation = createEntry({
      name: "implementation",
      effectLevel: "mutation",
      outputs: ["change_set"],
    });

    const chain = planSkillChain({
      primary: review,
      index: [review, implementation],
    });

    expect(chain.chain).toEqual(["review"]);
    expect(chain.unresolvedConsumes).toEqual(["change_set"]);
  });

  test("recursively orders prerequisites before the skill that needs them", () => {
    const repositoryAnalysis = createEntry({
      name: "repository-analysis",
      outputs: ["repository_snapshot"],
    });
    const design = createEntry({
      name: "design",
      requires: ["repository_snapshot"],
      outputs: ["execution_plan"],
    });
    const implementation = createEntry({
      name: "implementation",
      requires: ["execution_plan"],
      outputs: ["change_set"],
      effectLevel: "mutation",
    });

    const chain = planSkillChain({
      primary: implementation,
      index: [repositoryAnalysis, design, implementation],
    });

    expect(chain.chain).toEqual(["repository-analysis", "design", "implementation"]);
    expect(chain.unresolvedConsumes).toEqual([]);
  });

  test("actual review contract stays standalone by default", () => {
    const review = loadEntry("skills/core/review/SKILL.md", "core");
    const design = loadEntry("skills/core/design/SKILL.md", "core");
    const implementation = loadEntry("skills/core/implementation/SKILL.md", "core");

    const chain = planSkillChain({
      primary: review,
      index: [review, design, implementation],
    });

    expect(chain.chain).toEqual(["review"]);
    expect(chain.unresolvedConsumes).toEqual([]);
  });

  test("project design overlay requires repository-analysis before design", () => {
    const repositoryAnalysis = loadEntry(
      "skills/project/overlays/repository-analysis/SKILL.md",
      "overlay",
    );
    const design = loadEntry("skills/project/overlays/design/SKILL.md", "overlay");

    const chain = planSkillChain({
      primary: design,
      index: [repositoryAnalysis, design],
    });

    expect(chain.chain).toEqual(["repository-analysis", "design"]);
    expect(chain.unresolvedConsumes).toEqual([]);
  });
});
