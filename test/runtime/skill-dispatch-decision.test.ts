import { describe, expect, test } from "bun:test";
import { resolveSkillDispatchDecision, type SkillsIndexEntry } from "@brewva/brewva-runtime";

function createEntry(
  input: Partial<SkillsIndexEntry> & Pick<SkillsIndexEntry, "name">,
): SkillsIndexEntry {
  return {
    name: input.name,
    tier: input.tier ?? "base",
    description: input.description ?? `${input.name} skill`,
    tags: input.tags ?? [],
    antiTags: input.antiTags ?? [],
    outputs: input.outputs ?? [],
    toolsRequired: input.toolsRequired ?? [],
    costHint: input.costHint ?? "medium",
    stability: input.stability ?? "stable",
    composableWith: input.composableWith ?? [],
    consumes: input.consumes ?? [],
    dispatch: input.dispatch,
  };
}

describe("skill dispatch decision", () => {
  test("falls back to default dispatch thresholds when dispatch metadata is absent", () => {
    const decision = resolveSkillDispatchDecision({
      selected: [{ name: "review", score: 12, reason: "semantic:review", breakdown: [] }],
      index: [createEntry({ name: "review" })],
      turn: 5,
    });

    expect(decision.mode).toBe("gate");
    expect(decision.reason).toContain("gate_threshold(10)");
  });

  test("normalizes malformed dispatch metadata from external index entries", () => {
    const decision = resolveSkillDispatchDecision({
      selected: [{ name: "review", score: 0, reason: "none", breakdown: [] }],
      index: [
        createEntry({
          name: "review",
          dispatch: {
            gateThreshold: Number.NaN,
            autoThreshold: Number.NaN,
            defaultMode: "invalid-mode" as unknown as "suggest",
          },
        }),
      ],
      turn: 6,
    });

    expect(decision.mode).toBe("suggest");
    expect(decision.reason).toContain("gate_threshold(10)");
  });
});
