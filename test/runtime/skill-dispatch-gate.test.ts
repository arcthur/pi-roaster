import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-skill-dispatch-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function createConfig(mode: BrewvaConfig["security"]["mode"]): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.security.mode = mode;
  config.memory.enabled = false;
  config.infrastructure.toolFailureInjection.enabled = false;
  config.skills.overrides.review = {
    dispatch: {
      gateThreshold: 1,
      autoThreshold: 100,
      defaultMode: "gate",
    },
  };
  return config;
}

function prepareReviewDispatch(runtime: BrewvaRuntime, sessionId: string) {
  runtime.context.onTurnStart(sessionId, 1);
  runtime.skills.setNextSelection(sessionId, [
    {
      name: "review",
      score: 10,
      reason: "semantic:review request",
      breakdown: [{ signal: "semantic_match", term: "review", delta: 10 }],
    },
  ]);
  return runtime.skills.prepareDispatch(
    sessionId,
    "Review the project in depth and assess architecture risks against project philosophy",
  );
}

describe("skill dispatch gate", () => {
  test("strict mode blocks non-lifecycle tools while gate is pending", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("strict-block"),
      config: createConfig("strict"),
    });
    const sessionId = "skill-dispatch-strict-1";
    const dispatch = prepareReviewDispatch(runtime, sessionId);

    expect(dispatch.mode).toBe("gate");
    expect(dispatch.primary?.name).toBe("review");

    const blocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-blocked",
      toolName: "exec",
      args: { command: "echo blocked" },
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("skill_load")).toBe(true);

    const loadAllowed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-load",
      toolName: "skill_load",
      args: { name: "review" },
    });
    expect(loadAllowed.allowed).toBe(true);

    expect(runtime.skills.activate(sessionId, "review").ok).toBe(true);
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();

    const unblocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-after-load",
      toolName: "read",
      args: { filePath: "README.md" },
    });
    expect(unblocked.allowed).toBe(true);
    expect(
      runtime.events.query(sessionId, { type: "skill_routing_followed", last: 1 }),
    ).toHaveLength(1);
  });

  test("routing failure conservative gate blocks non-lifecycle tools in strict mode", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("strict-routing-failed"),
      config: createConfig("strict"),
    });
    const sessionId = "skill-dispatch-strict-failed-1";

    runtime.context.onTurnStart(sessionId, 1);
    runtime.skills.setNextSelection(sessionId, [], {
      routingOutcome: "failed",
    });

    const dispatch = runtime.skills.prepareDispatch(sessionId, "review architecture risks");
    expect(dispatch.mode).toBe("gate");
    expect(dispatch.primary).toBeNull();
    expect(dispatch.routingOutcome).toBe("failed");

    const blocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-failed-routing",
      toolName: "exec",
      args: { command: "echo blocked" },
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("skill_load")).toBe(true);

    const overrideAllowed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-override-after-failed-routing",
      toolName: "skill_route_override",
      args: { reason: "manual fallback" },
    });
    expect(overrideAllowed.allowed).toBe(true);
  });

  test("standard mode warns but does not block", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("standard-warn"),
      config: createConfig("standard"),
    });
    const sessionId = "skill-dispatch-standard-1";
    const dispatch = prepareReviewDispatch(runtime, sessionId);
    expect(dispatch.mode).toBe("gate");

    const allowed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-warn",
      toolName: "exec",
      args: { command: "echo warn" },
    });
    expect(allowed.allowed).toBe(true);
    expect(
      runtime.events.query(sessionId, { type: "skill_dispatch_gate_warning", last: 1 }),
    ).toHaveLength(1);
  });

  test("permissive mode neither blocks nor warns", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("permissive-off"),
      config: createConfig("permissive"),
    });
    const sessionId = "skill-dispatch-permissive-1";
    const dispatch = prepareReviewDispatch(runtime, sessionId);
    expect(dispatch.mode).toBe("gate");

    const allowed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-permissive",
      toolName: "exec",
      args: { command: "echo permissive" },
    });
    expect(allowed.allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "skill_dispatch_gate_warning" })).toHaveLength(
      0,
    );
    expect(
      runtime.events.query(sessionId, { type: "skill_dispatch_gate_blocked_tool" }),
    ).toHaveLength(0);
  });

  test("manual override clears pending dispatch and emits overridden event", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("override"),
      config: createConfig("strict"),
    });
    const sessionId = "skill-dispatch-override-1";
    prepareReviewDispatch(runtime, sessionId);

    const override = runtime.skills.overridePendingDispatch(sessionId, {
      reason: "human_operator_override",
      targetSkillName: "planning",
    });
    expect(override.ok).toBe(true);
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();

    const allowed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-after-override",
      toolName: "exec",
      args: { command: "echo after override" },
    });
    expect(allowed.allowed).toBe(true);
    expect(
      runtime.events.query(sessionId, { type: "skill_routing_overridden", last: 1 }),
    ).toHaveLength(1);
  });

  test("turn-end reconciliation emits ignored once and clears gate", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("ignored"),
      config: createConfig("strict"),
    });
    const sessionId = "skill-dispatch-ignored-1";
    prepareReviewDispatch(runtime, sessionId);

    runtime.skills.reconcilePendingDispatch(sessionId, 1);
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
    expect(
      runtime.events.query(sessionId, { type: "skill_routing_ignored", last: 1 }),
    ).toHaveLength(1);
  });

  test("routing decision is marked deferred while another skill is active", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("deferred"),
      config: createConfig("strict"),
    });
    const sessionId = "skill-dispatch-deferred-1";

    runtime.context.onTurnStart(sessionId, 1);
    expect(runtime.skills.activate(sessionId, "execution").ok).toBe(true);
    runtime.skills.setNextSelection(sessionId, [
      {
        name: "review",
        score: 10,
        reason: "semantic:review request",
        breakdown: [{ signal: "semantic_match", term: "review", delta: 10 }],
      },
    ]);
    runtime.skills.prepareDispatch(sessionId, "review the latest implementation");

    const deferred = runtime.events.query(sessionId, {
      type: "skill_routing_deferred",
      last: 1,
    })[0];
    expect(deferred).toBeDefined();
    expect((deferred?.payload as { deferredBy?: string } | undefined)?.deferredBy).toBe(
      "execution",
    );
  });

  test("turn-end reconciliation uses current session turn when event turn lags behind", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("ignored-lagging-turn"),
      config: createConfig("strict"),
    });
    const sessionId = "skill-dispatch-ignored-lagging-1";
    runtime.context.onTurnStart(sessionId, 2);
    runtime.skills.setNextSelection(sessionId, [
      {
        name: "review",
        score: 10,
        reason: "semantic:review request",
        breakdown: [{ signal: "semantic_match", term: "review", delta: 10 }],
      },
    ]);
    const dispatch = runtime.skills.prepareDispatch(
      sessionId,
      "Review architecture boundaries and identify high-risk regressions",
    );
    expect(dispatch.turn).toBe(2);
    expect(runtime.skills.getPendingDispatch(sessionId)?.turn).toBe(2);

    runtime.skills.reconcilePendingDispatch(sessionId, 1);

    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
    expect(
      runtime.events.query(sessionId, { type: "skill_routing_ignored", last: 1 }),
    ).toHaveLength(1);
  });
});
