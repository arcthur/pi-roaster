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
    const completion = runtime.skills.complete(sessionId, {
      oracle_brief: "Investigate recent callback handler changes",
      oracle_synthesis: "Null guard is missing in callback parsing path",
      root_cause: "null ref in handler",
      fix_description: "added guard",
      evidence: "test passes",
      verification: "pass",
    });
    expect(completion).toEqual({ ok: true, missing: [] });

    const planningAvailable = runtime.skills.getConsumedOutputs(sessionId, "planning");
    expect(planningAvailable.root_cause).toBe("null ref in handler");
  });

  test("getAvailableConsumedOutputs returns empty for unknown skill", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const result = runtime.skills.getConsumedOutputs("any-session", "nonexistent");
    expect(result).toEqual({});
  });

  test("replays skill outputs from skill_completed events after runtime restart", async () => {
    const sessionId = `skill-output-replay-${Date.now()}`;
    const runtimeA = new BrewvaRuntime({ cwd: repoRoot() });
    runtimeA.skills.activate(sessionId, "exploration");
    runtimeA.skills.complete(sessionId, {
      architecture_map: "replayed module map",
      key_modules: "runtime",
      unknowns: "none",
    });

    const runtimeB = new BrewvaRuntime({ cwd: repoRoot() });
    runtimeB.context.onTurnStart(sessionId, 1);
    const replayed = runtimeB.skills.getConsumedOutputs(sessionId, "debugging");
    expect(replayed.architecture_map).toBe("replayed module map");
  });

  test("emits skill_completed event with outputs and output keys", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `skill-complete-event-${Date.now()}`;
    runtime.skills.activate(sessionId, "exploration");
    const outputs = {
      architecture_map: "map",
      unknowns: "none",
      key_modules: "runtime",
    };
    runtime.skills.complete(sessionId, outputs);

    const event = runtime.events.query(sessionId, { type: "skill_completed", last: 1 })[0];
    expect(event).toBeDefined();
    const payload = (event?.payload ?? {}) as {
      skillName?: string;
      outputKeys?: string[];
      outputs?: Record<string, unknown>;
    };
    expect(payload.skillName).toBe("exploration");
    expect(payload.outputKeys).toEqual(["architecture_map", "key_modules", "unknowns"]);
    expect(payload.outputs).toEqual(outputs);
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

  test("promotes task spec from compose outputs when task is still in align state", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `compose-task-promote-${Date.now()}`;

    runtime.skills.activate(sessionId, "compose");
    const completion = runtime.skills.complete(sessionId, {
      compose_analysis:
        "request_summary: Refactor verification routing and align fallback semantics",
      skill_sequence: [
        {
          step: 1,
          skill: "exploration",
          intent: "inspect current flow",
        },
      ],
      compose_plan: "Run exploration, then planning, then patching and verification.",
    });
    expect(completion).toEqual({ ok: true, missing: [] });

    const taskState = runtime.task.getState(sessionId);
    expect(taskState.spec?.goal).toContain("Refactor verification routing");
    expect(taskState.status?.phase).toBe("investigate");
    expect(taskState.status?.health).toBe("ok");
  });

  test("promotes task spec from task_spec output for non-compose skills", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `task-spec-output-${Date.now()}`;

    runtime.skills.activate(sessionId, "exploration");
    const completion = runtime.skills.complete(sessionId, {
      architecture_map: "runtime, tools, memory",
      key_modules: "verification, skill lifecycle",
      unknowns: "none",
      task_spec: {
        schema: "brewva.task.v1",
        goal: "Stabilize verification outcome semantics",
        constraints: ["Prefer deterministic events"],
      },
    });
    expect(completion).toEqual({ ok: true, missing: [] });

    const taskState = runtime.task.getState(sessionId);
    expect(taskState.spec?.goal).toBe("Stabilize verification outcome semantics");
    expect(taskState.spec?.constraints).toEqual(["Prefer deterministic events"]);
  });
});
