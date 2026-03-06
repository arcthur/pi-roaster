import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseSkillDocument,
  planSkillChain,
  type SkillTier,
  type SkillsIndexEntry,
} from "@brewva/brewva-runtime";

function createEntry(
  input: Partial<SkillsIndexEntry> & Pick<SkillsIndexEntry, "name">,
): SkillsIndexEntry {
  return {
    name: input.name,
    tier: input.tier ?? "base",
    description: input.description ?? `${input.name} skill`,
    outputs: input.outputs ?? [],
    toolsRequired: input.toolsRequired ?? [],
    costHint: input.costHint ?? "medium",
    stability: input.stability ?? "stable",
    composableWith: input.composableWith ?? [],
    consumes: input.consumes ?? [],
    dispatch: input.dispatch ?? {
      gateThreshold: 10,
      autoThreshold: 16,
      defaultMode: "suggest",
    },
  };
}

function repoRoot(): string {
  return process.cwd();
}

function loadEntry(relativePath: string, tier: SkillTier): SkillsIndexEntry {
  const skill = parseSkillDocument(join(repoRoot(), relativePath), tier);
  return {
    name: skill.name,
    tier: skill.tier,
    description: skill.description,
    outputs: skill.contract.outputs,
    toolsRequired: skill.contract.tools.required,
    costHint: skill.contract.costHint,
    stability: skill.contract.stability,
    composableWith: skill.contract.composableWith,
    consumes: skill.contract.consumes,
    dispatch: skill.contract.dispatch,
  };
}

describe("skill chain planner", () => {
  test("inserts prerequisite producer for missing consumed outputs", () => {
    const primary = createEntry({
      name: "review",
      consumes: ["change_summary"],
    });
    const planner = createEntry({
      name: "planning",
      outputs: ["change_summary"],
      composableWith: ["review"],
      costHint: "low",
    });

    const chain = planSkillChain({
      primary,
      index: [primary, planner],
    });

    expect(chain.chain).toEqual(["planning", "review"]);
    expect(chain.unresolvedConsumes).toEqual([]);
  });

  test("respects producer priority: composableWith, then cost/stability, then lexical", () => {
    const primary = createEntry({
      name: "review",
      consumes: ["verification"],
    });
    const expensiveProducer = createEntry({
      name: "verify-zeta",
      outputs: ["verification"],
      costHint: "high",
      stability: "deprecated",
    });
    const cheapProducer = createEntry({
      name: "verify-alpha",
      outputs: ["verification"],
      costHint: "low",
      stability: "stable",
    });
    const composableProducer = createEntry({
      name: "verify-chain",
      outputs: ["verification"],
      composableWith: ["review"],
      costHint: "high",
      stability: "deprecated",
    });

    const chain = planSkillChain({
      primary,
      index: [primary, expensiveProducer, cheapProducer, composableProducer],
    });

    expect(chain.prerequisites).toEqual(["verify-chain"]);
    expect(chain.chain).toEqual(["verify-chain", "review"]);
  });

  test("does not insert producer when consumed output is already available", () => {
    const primary = createEntry({
      name: "review",
      consumes: ["change_summary"],
    });
    const planner = createEntry({
      name: "planning",
      outputs: ["change_summary"],
    });

    const chain = planSkillChain({
      primary,
      index: [primary, planner],
      availableOutputs: ["change_summary"],
    });

    expect(chain.chain).toEqual(["review"]);
    expect(chain.prerequisites).toEqual([]);
    expect(chain.unresolvedConsumes).toEqual([]);
  });

  test("returns unresolved consumes when no producer exists", () => {
    const primary = createEntry({
      name: "review",
      consumes: ["unknown_output"],
    });

    const chain = planSkillChain({
      primary,
      index: [primary],
    });

    expect(chain.chain).toEqual(["review"]);
    expect(chain.unresolvedConsumes).toEqual(["unknown_output"]);
  });

  test("prefers goal-loop as the iteration_report producer for recovery", () => {
    const recovery = loadEntry("skills/base/recovery/SKILL.md", "base");
    const goalLoop = loadEntry("skills/packs/goal-loop/SKILL.md", "pack");
    const genericProducer = createEntry({
      name: "generic-iteration-producer",
      tier: "pack",
      outputs: ["iteration_report"],
      costHint: "low",
      stability: "stable",
    });

    const chain = planSkillChain({
      primary: recovery,
      index: [recovery, goalLoop, genericProducer],
      availableOutputs: ["failure_evidence", "current_plan", "constraints"],
    });

    expect(chain.prerequisites).toEqual(["goal-loop"]);
    expect(chain.chain).toEqual(["goal-loop", "recovery"]);
    expect(chain.unresolvedConsumes).toEqual([]);
  });
});
