import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("S-001 semantic skill selection input", () => {
  test("prepareDispatch consumes semantic preselection", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "semantic-preselect-1";

    runtime.skills.setNextSelection(sessionId, [
      {
        name: "review",
        score: 20,
        reason: "semantic:review request",
        breakdown: [{ signal: "semantic_match", term: "semantic", delta: 20 }],
      },
    ]);

    const decision = runtime.skills.prepareDispatch(
      sessionId,
      "this text should not trigger lexical routing",
    );

    expect(decision.primary?.name).toBe("review");
    expect(decision.selected.length).toBe(1);
    expect(decision.mode).toBe("auto");
  });

  test("prepareDispatch is empty when semantic preselection is absent", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "semantic-preselect-2";

    const decision = runtime.skills.prepareDispatch(sessionId, "review architecture risks");
    expect(decision.mode).toBe("none");
    expect(decision.selected).toEqual([]);
  });
});
