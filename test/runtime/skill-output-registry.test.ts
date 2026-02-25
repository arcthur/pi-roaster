import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("skill output registry", () => {
  test("completed skill outputs are queryable by subsequent skills", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "output-reg-1";

    runtime.skills.activate(sessionId, "exploration");
    const outputs = {
      architecture_map: "monorepo with 4 packages",
      key_modules: "runtime, tools, extensions, cli",
      unknowns: "none",
    };
    runtime.skills.complete(sessionId, outputs);

    const stored = runtime.skills.getOutputs(sessionId, "exploration");
    expect(stored).toBeDefined();
    expect(stored!.architecture_map).toBe("monorepo with 4 packages");
  });

  test("getAvailableConsumedOutputs returns matching outputs for skill consumes", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "output-reg-2";

    // debugging consumes: [architecture_map, execution_steps]
    // exploration outputs architecture_map — IS in debugging's consumes
    // but first test with no matching outputs
    runtime.skills.activate(sessionId, "exploration");
    runtime.skills.complete(sessionId, {
      architecture_map: "module map here",
      key_modules: "runtime",
      unknowns: "none",
    });

    // exploration produces architecture_map which debugging consumes — should match
    const available = runtime.skills.getConsumedOutputs(sessionId, "debugging");
    expect(available.architecture_map).toBe("module map here");

    // planning consumes: [architecture_map, key_modules, unknowns, root_cause]
    // debugging produces root_cause — IS a match
    runtime.skills.activate(sessionId, "debugging");
    runtime.skills.complete(sessionId, {
      root_cause: "null ref in handler",
      fix_description: "added guard",
      evidence: "test passes",
      verification: "pass",
    });

    const planningAvailable = runtime.skills.getConsumedOutputs(sessionId, "planning");
    expect(planningAvailable.root_cause).toBe("null ref in handler");
  });

  test("getAvailableConsumedOutputs returns empty for unknown skill", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const result = runtime.skills.getConsumedOutputs("any-session", "nonexistent");
    expect(result).toEqual({});
  });

  test("emits skill_completed event with output keys", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `skill-complete-event-${Date.now()}`;
    runtime.skills.activate(sessionId, "exploration");
    runtime.skills.complete(sessionId, {
      architecture_map: "map",
      unknowns: "none",
      key_modules: "runtime",
    });

    const event = runtime.events.query(sessionId, { type: "skill_completed", last: 1 })[0];
    expect(event).toBeDefined();
    const payload = (event?.payload ?? {}) as {
      skillName?: string;
      outputKeys?: string[];
    };
    expect(payload.skillName).toBe("exploration");
    expect(payload.outputKeys).toEqual(["architecture_map", "key_modules", "unknowns"]);
  });

  test("emits skill_activated event when a skill is loaded", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `skill-activated-event-${Date.now()}`;
    runtime.skills.activate(sessionId, "exploration");

    const event = runtime.events.query(sessionId, { type: "skill_activated", last: 1 })[0];
    expect(event).toBeDefined();
    const payload = (event?.payload ?? {}) as {
      skillName?: string;
    };
    expect(payload.skillName).toBe("exploration");
  });
});
