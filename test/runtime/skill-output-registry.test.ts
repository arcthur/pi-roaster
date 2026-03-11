import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("skill output registry", () => {
  test("completed skill outputs are queryable by subsequent skills", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "output-reg-1";

    runtime.skills.activate(sessionId, "repository-analysis");
    const outputs = {
      repository_snapshot: "monorepo with runtime, tools, cli, gateway",
      impact_map: "routing, registry, docs",
      unknowns: "No blocking unknowns remain after the repository inventory pass.",
    };
    runtime.skills.complete(sessionId, outputs);

    const stored = runtime.skills.getOutputs(sessionId, "repository-analysis");
    expect(stored).toBeDefined();
    expect(stored?.repository_snapshot).toContain("monorepo");
  });

  test("getConsumedOutputs returns matching outputs for downstream skills", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "output-reg-2";

    runtime.skills.activate(sessionId, "repository-analysis");
    runtime.skills.complete(sessionId, {
      repository_snapshot: "module map here",
      impact_map: "routing and cascade",
      unknowns: "No blocking unknowns remain after validating the main code path.",
    });

    const debuggingAvailable = runtime.skills.getConsumedOutputs(sessionId, "debugging");
    expect(debuggingAvailable.repository_snapshot).toBe("module map here");
    expect(debuggingAvailable.impact_map).toBe("routing and cascade");

    runtime.skills.activate(sessionId, "debugging");
    const completion = runtime.skills.complete(sessionId, {
      root_cause: "continuity gate was missing",
      fix_strategy: "add continuity-aware filtering",
      failure_evidence: "repro + failing route selection",
    });
    expect(completion).toEqual({ ok: true, missing: [], invalid: [] });

    const implementationAvailable = runtime.skills.getConsumedOutputs(sessionId, "implementation");
    expect(implementationAvailable.root_cause).toBe("continuity gate was missing");
    expect(implementationAvailable.fix_strategy).toBe("add continuity-aware filtering");
  });

  test("getConsumedOutputs returns empty for unknown skill", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const result = runtime.skills.getConsumedOutputs("any-session", "nonexistent");
    expect(result).toEqual({});
  });

  test("replays skill outputs from skill_completed events after runtime restart", async () => {
    const sessionId = `skill-output-replay-${Date.now()}`;
    const runtimeA = new BrewvaRuntime({ cwd: repoRoot() });
    runtimeA.skills.activate(sessionId, "repository-analysis");
    runtimeA.skills.complete(sessionId, {
      repository_snapshot: "replayed module map",
      impact_map: "registry and router",
      unknowns: "No unresolved repository gaps remained at replay capture time.",
    });

    const runtimeB = new BrewvaRuntime({ cwd: repoRoot() });
    runtimeB.context.onTurnStart(sessionId, 1);
    const replayed = runtimeB.skills.getConsumedOutputs(sessionId, "debugging");
    expect(replayed.repository_snapshot).toBe("replayed module map");
  });

  test("emits skill_completed event with outputs and output keys", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `skill-complete-event-${Date.now()}`;
    runtime.skills.activate(sessionId, "repository-analysis");
    const outputs = {
      repository_snapshot: "repository layout for runtime, tools, and gateway modules",
      impact_map: "routing flow and registry boundaries touched by the change",
      unknowns: "No blocking repository blind spots remained after the analysis pass.",
    };
    runtime.skills.complete(sessionId, outputs);

    const event = runtime.events.query(sessionId, { type: "skill_completed", last: 1 })[0];
    expect(event).toBeDefined();
    const payload = (event?.payload ?? {}) as {
      skillName?: string;
      outputKeys?: string[];
      outputs?: Record<string, unknown>;
    };
    expect(payload.skillName).toBe("repository-analysis");
    expect(payload.outputKeys).toEqual(["impact_map", "repository_snapshot", "unknowns"]);
    expect(payload.outputs).toEqual(outputs);
  });

  test("emits skill_activated event when a skill is loaded", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `skill-activated-event-${Date.now()}`;
    runtime.skills.activate(sessionId, "repository-analysis");

    const event = runtime.events.query(sessionId, { type: "skill_activated", last: 1 })[0];
    expect(event).toBeDefined();
    const payload = (event?.payload ?? {}) as {
      skillName?: string;
    };
    expect(payload.skillName).toBe("repository-analysis");
  });

  test("promotes task spec from task_spec output", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `task-spec-output-${Date.now()}`;

    runtime.skills.activate(sessionId, "repository-analysis");
    const completion = runtime.skills.complete(sessionId, {
      repository_snapshot: "runtime, tools, projection",
      impact_map: "verification, skill lifecycle",
      unknowns: "No blocking unknowns remain after mapping runtime and projection ownership.",
      task_spec: {
        schema: "brewva.task.v1",
        goal: "Stabilize verification outcome semantics",
        constraints: ["Prefer deterministic events"],
      },
    });
    expect(completion).toEqual({ ok: true, missing: [], invalid: [] });

    const taskState = runtime.task.getState(sessionId);
    expect(taskState.spec?.goal).toBe("Stabilize verification outcome semantics");
    expect(taskState.spec?.constraints).toEqual(["Prefer deterministic events"]);
  });
});
