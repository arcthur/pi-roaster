import { describe, expect, test } from "bun:test";
import { resolveSkillDispatchDecision, type SkillsIndexEntry } from "@brewva/brewva-runtime";

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
    dispatch: input.dispatch,
    routingScope: input.routingScope ?? "core",
  };
}

describe("skill dispatch decision", () => {
  test("falls back to default dispatch thresholds when metadata is absent", () => {
    const decision = resolveSkillDispatchDecision({
      selected: [{ name: "review", score: 12, reason: "semantic:review", breakdown: [] }],
      index: [createEntry({ name: "review" })],
      turn: 5,
    });

    expect(decision.mode).toBe("suggest");
    expect(decision.reason).toContain("suggest_threshold(10)");
  });

  test("read_only skills do not auto-chain mutation producers", () => {
    const decision = resolveSkillDispatchDecision({
      selected: [{ name: "review", score: 22, reason: "semantic:review", breakdown: [] }],
      index: [
        createEntry({
          name: "review",
          requires: ["change_set"],
          effectLevel: "read_only",
        }),
        createEntry({
          name: "implementation",
          outputs: ["change_set"],
          effectLevel: "mutation",
        }),
      ],
      turn: 7,
    });

    expect(decision.chain).toEqual(["review"]);
    expect(decision.unresolvedConsumes).toEqual(["change_set"]);
  });

  test("collapses to the primary skill when prerequisite chain is still invalid", () => {
    const decision = resolveSkillDispatchDecision({
      selected: [
        { name: "implementation", score: 22, reason: "semantic:implementation", breakdown: [] },
      ],
      index: [
        createEntry({
          name: "implementation",
          requires: ["execution_plan"],
          effectLevel: "mutation",
        }),
        createEntry({
          name: "design",
          requires: ["repository_snapshot"],
          outputs: ["execution_plan"],
          effectLevel: "read_only",
        }),
      ],
      turn: 8,
    });

    expect(decision.chain).toEqual(["implementation"]);
    expect(decision.unresolvedConsumes).toEqual(
      expect.arrayContaining(["execution_plan", "repository_snapshot"]),
    );
  });
});
