import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseSkillDocument,
  planSkillChain,
  type SkillCategory,
  type SkillsIndexEntry,
} from "@brewva/brewva-runtime";

function createEntry(
  input: Partial<SkillsIndexEntry> & Pick<SkillsIndexEntry, "name">,
): SkillsIndexEntry {
  return {
    name: input.name,
    category: input.category ?? "core",
    description: input.description ?? `${input.name} skill`,
    outputs: input.outputs ?? [],
    toolsRequired: input.toolsRequired ?? [],
    costHint: input.costHint ?? "medium",
    stability: input.stability ?? "stable",
    composableWith: input.composableWith ?? [],
    consumes: input.consumes ?? [],
    requires: input.requires ?? [],
    effectLevel: input.effectLevel ?? "read_only",
    dispatch: input.dispatch ?? {
      gateThreshold: 10,
      autoThreshold: 16,
      defaultMode: "suggest",
    },
    routingScope: input.routingScope ?? "core",
    continuityRequired: input.continuityRequired ?? false,
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
    outputs: skill.contract.outputs ?? [],
    toolsRequired: skill.contract.tools.required,
    costHint: skill.contract.costHint ?? "medium",
    stability: skill.contract.stability ?? "stable",
    composableWith: skill.contract.composableWith ?? [],
    consumes: skill.contract.consumes ?? [],
    requires: skill.contract.requires ?? [],
    effectLevel: skill.contract.effectLevel ?? "read_only",
    dispatch: skill.contract.dispatch,
    routingScope: skill.contract.routing?.scope,
    continuityRequired: skill.contract.routing?.continuityRequired === true,
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
