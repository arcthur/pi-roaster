import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  ParallelBudgetManager,
  BrewvaRuntime,
  TAPE_CHECKPOINT_EVENT_TYPE,
  buildTruthFactUpsertedEvent,
  tightenContract,
} from "@brewva/brewva-runtime";
import type { SkillContract } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("S-001 selector inject top-k and anti-tags", () => {
  test("selects candidates and excludes anti-tags", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const selected = runtime.skills.select("debug failing test regression in typescript module");
    expect(selected.length).toBeGreaterThan(0);

    const docsSelected = runtime.skills.select("implement a new feature and update docs");
    expect(docsSelected.some((skill) => skill.name === "debugging")).toBe(false);
  });
});

describe("S-002 denied tool gate", () => {
  test("blocks denied write for active patching skill", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s2";
    const activated = runtime.skills.activate(sessionId, "patching");
    expect(activated.ok).toBe(true);

    const access = runtime.tools.checkAccess(sessionId, "write");
    expect(access.allowed).toBe(false);
  });

  test("keeps denied tool enforcement in permissive mode", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    runtime.config.security.mode = "permissive";

    const sessionId = "s2-disabled";
    const activated = runtime.skills.activate(sessionId, "patching");
    expect(activated.ok).toBe(true);

    const access = runtime.tools.checkAccess(sessionId, "write");
    expect(access.allowed).toBe(false);
  });

  test("blocks removed bash/shell tools with migration hint", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s2-removed-tools";

    const bash = runtime.tools.checkAccess(sessionId, "bash");
    expect(bash.allowed).toBe(false);
    expect(bash.reason?.includes("removed")).toBe(true);
    expect(bash.reason?.includes("exec")).toBe(true);
    expect(bash.reason?.includes("process")).toBe(true);

    const shell = runtime.tools.checkAccess(sessionId, "shell");
    expect(shell.allowed).toBe(false);
    expect(shell.reason?.includes("removed")).toBe(true);
  });
});

describe("S-003 ledger write/query", () => {
  test("records and queries last entries", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s3";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "PASS",
      success: true,
    });

    const text = runtime.truth.queryLedger(sessionId, { last: 5 });
    expect(text.includes("exec")).toBe(true);
    expect(text.includes("PASS")).toBe(true);
  });
});

describe("S-004/S-005 verification gate", () => {
  test("blocks without evidence after write and passes with evidence", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s4";

    runtime.tools.markCall(sessionId, "edit");
    const blocked = runtime.verification.evaluate(sessionId);
    expect(blocked.passed).toBe(false);
    expect(blocked.missingEvidence).toContain("lsp_diagnostics");
    expect(blocked.missingEvidence).toContain("test_or_build");

    runtime.tools.recordResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      success: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "All tests passed",
      success: true,
    });

    const passed = runtime.verification.evaluate(sessionId);
    expect(passed.passed).toBe(true);
  });

  test("treats multi_edit as a mutation tool for verification gating", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s4-multi-edit";

    runtime.tools.markCall(sessionId, "multi_edit");
    const blocked = runtime.verification.evaluate(sessionId);
    expect(blocked.passed).toBe(false);
    expect(blocked.missingEvidence).toContain("lsp_diagnostics");
    expect(blocked.missingEvidence).toContain("test_or_build");
  });
});

describe("S-006 three-layer contract tightening", () => {
  test("project contract cannot relax base contract", async () => {
    const base: SkillContract = {
      name: "foo",
      tier: "base",
      tags: ["x"],
      tools: {
        required: ["read"],
        optional: ["edit"],
        denied: ["write"],
      },
      budget: {
        maxToolCalls: 50,
        maxTokens: 100000,
      },
    };

    const merged = tightenContract(base, {
      tools: {
        required: [],
        optional: ["write", "edit"],
        denied: ["exec"],
      },
      budget: {
        maxToolCalls: 10,
        maxTokens: 100000,
      },
    });

    expect(merged.tools.optional).toContain("edit");
    expect(merged.tools.optional).not.toContain("write");
    expect(merged.tools.denied).toContain("write");
    expect(merged.tools.denied).toContain("exec");
    expect(merged.budget.maxToolCalls).toBe(10);
  });

  test("higher tier keeps stricter contract when overriding", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-s6-"));
    mkdirSync(join(workspace, ".brewva"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify({
        skills: {
          packs: [],
          disabled: [],
          overrides: {},
          selector: { k: 4 },
        },
      }),
    );

    mkdirSync(join(workspace, ".brewva", "skills", "base", "foo"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/base/foo/SKILL.md"),
      `---\nname: foo\ndescription: base\ntags: [foo]\ntools:\n  required: [read]\n  optional: [edit]\n  denied: [write]\nbudget:\n  max_tool_calls: 50\n  max_tokens: 10000\n---\nbase`,
    );

    mkdirSync(join(workspace, ".brewva", "skills", "project", "foo"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/project/foo/SKILL.md"),
      `---\nname: foo\ndescription: project\ntags: [foo]\ntools:\n  required: []\n  optional: [write]\n  denied: [exec]\nbudget:\n  max_tool_calls: 30\n  max_tokens: 8000\n---\nproject`,
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const foo = runtime.skills.get("foo");
    expect(foo).toBeDefined();
    expect(foo!.contract.tools.denied).toContain("write");
    expect(foo!.contract.tools.denied).toContain("exec");
    expect(foo!.contract.tools.required).toContain("read");
  });
});

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

  test("buildContextInjection includes working memory after semantic events", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-injection-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `memory-injection-${Date.now()}`;

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Inject working memory into context",
      constraints: ["Use event tape as trace source"],
    });
    runtime.task.recordBlocker(sessionId, {
      message: "verification pending",
      source: "test",
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue implementation");
    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("[WorkingMemory]")).toBe(true);
  });

  test("memory can be disabled from config without changing baseline injection behavior", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-disabled-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.enabled = false;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = `memory-disabled-${Date.now()}`;
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "No memory block expected",
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue implementation");
    expect(injection.text.includes("[WorkingMemory]")).toBe(false);
  });

  test("dismissMemoryInsight dismisses open insight and emits event", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-dismiss-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `memory-dismiss-${Date.now()}`;

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Dismiss repeated memory insight",
    });
    runtime.task.recordBlocker(sessionId, {
      message: "verification may fail due missing fixtures",
      source: "test",
    });
    runtime.task.recordBlocker(sessionId, {
      message: "verification may fail due flaky network",
      source: "test",
    });
    await runtime.context.buildInjection(sessionId, "continue implementation");

    const insightsPath = join(workspace, ".orchestrator/memory/insights.jsonl");
    const rows = readFileSync(insightsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; status: string; updatedAt: number });
    const latestById = new Map<string, { id: string; status: string; updatedAt: number }>();
    for (const row of rows) {
      const current = latestById.get(row.id);
      if (!current || row.updatedAt >= current.updatedAt) {
        latestById.set(row.id, row);
      }
    }
    const openInsight = [...latestById.values()].find((row) => row.status === "open");
    expect(openInsight).toBeDefined();
    if (!openInsight) return;

    const dismissed = runtime.memory.dismissInsight(sessionId, openInsight.id);
    expect(dismissed).toEqual({ ok: true });
    const secondDismiss = runtime.memory.dismissInsight(sessionId, openInsight.id);
    expect(secondDismiss).toEqual({ ok: false, error: "not_found" });

    const dismissEvent = runtime.events.query(sessionId, {
      type: "memory_insight_dismissed",
      last: 1,
    })[0];
    expect(dismissEvent).toBeDefined();
    expect((dismissEvent?.payload as { insightId?: string } | undefined)?.insightId).toBe(
      openInsight.id,
    );
  });

  test("reviewMemoryEvolvesEdge accepts proposed edge and emits event", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-review-edge-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.evolvesMode = "shadow";
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = `memory-review-edge-${Date.now()}`;

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Use sqlite for current task.",
    });
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Use postgres instead of sqlite for current task.",
    });
    await runtime.context.buildInjection(sessionId, "continue implementation");

    const evolvesPath = join(workspace, ".orchestrator/memory/evolves.jsonl");
    const rows = readFileSync(evolvesPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            status: string;
            relation: string;
            sourceUnitId: string;
            targetUnitId: string;
            updatedAt: number;
          },
      );
    const latestById = new Map<
      string,
      {
        id: string;
        status: string;
        relation: string;
        sourceUnitId: string;
        targetUnitId: string;
        updatedAt: number;
      }
    >();
    for (const row of rows) {
      const current = latestById.get(row.id);
      if (!current || row.updatedAt >= current.updatedAt) {
        latestById.set(row.id, row);
      }
    }
    const proposed = [...latestById.values()].find((edge) => edge.status === "proposed");
    expect(proposed).toBeDefined();
    if (!proposed) return;

    const accepted = runtime.memory.reviewEvolvesEdge(sessionId, {
      edgeId: proposed.id,
      decision: "accept",
    });
    expect(accepted).toEqual({ ok: true });
    const second = runtime.memory.reviewEvolvesEdge(sessionId, {
      edgeId: proposed.id,
      decision: "accept",
    });
    expect(second).toEqual({ ok: false, error: "already_set" });

    const reviewEvent = runtime.events.query(sessionId, {
      type: "memory_evolves_edge_reviewed",
      last: 1,
    })[0];
    expect(reviewEvent).toBeDefined();
    expect((reviewEvent?.payload as { edgeId?: string } | undefined)?.edgeId).toBe(proposed.id);

    const unitsPath = join(workspace, ".orchestrator/memory/units.jsonl");
    const unitRows = readFileSync(unitsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; status: string; updatedAt: number });
    const unitsLatest = new Map<string, { id: string; status: string; updatedAt: number }>();
    for (const row of unitRows) {
      const existing = unitsLatest.get(row.id);
      if (!existing || row.updatedAt >= existing.updatedAt) {
        unitsLatest.set(row.id, row);
      }
    }
    expect(unitsLatest.get(proposed.targetUnitId)?.status).toBe("superseded");
    expect(unitsLatest.get(proposed.sourceUnitId)?.status).toBe("active");

    const insightsPath = join(workspace, ".orchestrator/memory/insights.jsonl");
    const insightRows = readFileSync(insightsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            kind?: string;
            status: string;
            edgeId?: string | null;
            updatedAt: number;
          },
      );
    const insightsLatest = new Map<
      string,
      { id: string; kind?: string; status: string; edgeId?: string | null; updatedAt: number }
    >();
    for (const row of insightRows) {
      const existing = insightsLatest.get(row.id);
      if (!existing || row.updatedAt >= existing.updatedAt) {
        insightsLatest.set(row.id, row);
      }
    }
    const evolvesInsight = [...insightsLatest.values()].find(
      (row) => row.kind === "evolves_pending" && row.edgeId === proposed.id,
    );
    expect(evolvesInsight).toBeDefined();
    expect(evolvesInsight?.status).toBe("dismissed");

    const supersedeEvent = runtime.events.query(sessionId, {
      type: "memory_unit_superseded",
      last: 1,
    })[0];
    expect(supersedeEvent).toBeDefined();
  });
});

describe("S-007 parallel budget control", () => {
  test("enforces maxConcurrent and maxTotal", async () => {
    const manager = new ParallelBudgetManager({
      enabled: true,
      maxConcurrent: 1,
    });

    expect(manager.acquire("s7", "run-a").accepted).toBe(true);
    const blocked = manager.acquire("s7", "run-b");
    expect(blocked.accepted).toBe(false);
    expect(blocked.reason).toBe("max_concurrent");

    manager.release("s7", "run-a");
    expect(manager.acquire("s7", "run-b").accepted).toBe(true);
    manager.release("s7", "run-b");
    for (let i = 0; i < 8; i += 1) {
      const runId = `run-extra-${i}`;
      expect(manager.acquire("s7", runId).accepted).toBe(true);
      manager.release("s7", runId);
    }
    const totalBlocked = manager.acquire("s7", "run-c");
    expect(totalBlocked.accepted).toBe(false);
    expect(totalBlocked.reason).toBe("max_total");
  });
});

describe("cost evidence separation in digest", () => {
  test("ledger digest excludes infrastructure entries from summary", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `cost-sep-${Date.now()}`;

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo hello" },
      outputText: "hello",
      success: true,
    });

    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.001,
    });

    const digest = runtime.truth.getLedgerDigest(sessionId);
    expect(digest).toContain("count=1");
    expect(digest).not.toContain("brewva_cost");
  });
});

describe("compose plan validation", () => {
  test("validates a correct skill sequence", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    const validPlan = {
      steps: [
        { skill: "exploration", produces: ["tree_summary"] },
        { skill: "planning", consumes: ["tree_summary"], produces: ["execution_steps"] },
        {
          skill: "patching",
          consumes: ["execution_steps"],
          produces: ["fix_description", "verification"],
        },
      ],
    };

    const result = runtime.skills.validateComposePlan(validPlan);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects unknown skill references", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    const invalidPlan = {
      steps: [{ skill: "nonexistent_skill", produces: ["foo"] }],
    };

    const result = runtime.skills.validateComposePlan(invalidPlan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent_skill"))).toBe(true);
  });

  test("warns on consumed data not produced by any prior step", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    const plan = {
      steps: [{ skill: "patching", consumes: ["execution_steps"], produces: ["fix_description"] }],
    };

    const result = runtime.skills.validateComposePlan(plan);
    expect(result.warnings.some((w) => w.includes("execution_steps"))).toBe(true);
  });

  test("no warnings when all consumed data is produced by prior steps", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    const plan = {
      steps: [
        { skill: "exploration", produces: ["execution_steps"] },
        { skill: "patching", consumes: ["execution_steps"], produces: ["fix_description"] },
      ],
    };

    const result = runtime.skills.validateComposePlan(plan);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("session state cleanup", () => {
  test("clearSessionState releases in-memory per-session caches", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-session-clean-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "cleanup-state-1";

    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "edit");
    runtime.context.observeUsage(sessionId, {
      tokens: 128,
      contextWindow: 4096,
      percent: 0.03125,
    });
    runtime.tools.acquireParallelSlot(sessionId, "run-1");
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "run-1",
      status: "ok",
      summary: "done",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "diff" }],
      },
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo ok" },
      outputText: "ok",
      success: true,
    });
    runtime.task.getState(sessionId);
    runtime.truth.getState(sessionId);
    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test-model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.0001,
    });

    const sessionState = (runtime as any).sessionState as {
      turnsBySession: Map<string, number>;
      toolCallsBySession: Map<string, number>;
    };
    expect(sessionState.turnsBySession.has(sessionId)).toBe(true);
    expect(sessionState.toolCallsBySession.has(sessionId)).toBe(true);
    expect(((runtime as any).contextBudget.sessions as Map<string, unknown>).has(sessionId)).toBe(
      true,
    );
    expect(((runtime as any).costTracker.sessions as Map<string, unknown>).has(sessionId)).toBe(
      true,
    );
    expect(
      ((runtime as any).verificationGate.stateStore.sessions as Map<string, unknown>).has(
        sessionId,
      ),
    ).toBe(true);
    expect(((runtime as any).eventStore.fileHasContent as Map<string, boolean>).size).toBe(1);
    expect((runtime as any).ledger.lastHashBySession.has(sessionId) as boolean).toBe(true);

    runtime.session.clearState(sessionId);

    expect(sessionState.turnsBySession.has(sessionId)).toBe(false);
    expect(sessionState.toolCallsBySession.has(sessionId)).toBe(false);
    expect((runtime as any).turnReplay.hasSession(sessionId)).toBe(false);
    expect(((runtime as any).contextBudget.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
    expect(((runtime as any).costTracker.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
    expect(
      ((runtime as any).verificationGate.stateStore.sessions as Map<string, unknown>).has(
        sessionId,
      ),
    ).toBe(false);
    expect(((runtime as any).parallel.sessions as Map<string, unknown>).has(sessionId)).toBe(false);
    expect(((runtime as any).parallelResults.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
    expect(((runtime as any).eventStore.fileHasContent as Map<string, boolean>).size).toBe(0);
    expect((runtime as any).ledger.lastHashBySession.has(sessionId) as boolean).toBe(false);
  });

  test("invalidates replay cache on task events and rebuilds from tape", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-replay-view-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "replay-view-1";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Replay view should rebuild after new events",
    });
    runtime.task.getState(sessionId);

    const turnReplay = (runtime as any).turnReplay as {
      hasSession: (session: string) => boolean;
    };
    expect(turnReplay.hasSession(sessionId)).toBe(true);

    runtime.task.addItem(sessionId, { text: "item-1" });
    expect(turnReplay.hasSession(sessionId)).toBe(false);

    const updated = runtime.task.getState(sessionId);
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]?.text).toBe("item-1");
    expect(turnReplay.hasSession(sessionId)).toBe(true);
  });

  test("keeps replay cache for non-folding events and invalidates for truth/task/checkpoint events", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-replay-filter-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "replay-filter-1";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Replay cache should ignore non-folding events",
    });
    runtime.task.getState(sessionId);

    const turnReplay = (runtime as any).turnReplay as {
      hasSession: (session: string) => boolean;
    };
    expect(turnReplay.hasSession(sessionId)).toBe(true);

    runtime.events.record({
      sessionId,
      type: "tool_call",
      payload: {
        toolCallId: "tc-1",
        toolName: "look_at",
      },
    });
    expect(turnReplay.hasSession(sessionId)).toBe(true);

    runtime.events.record({
      sessionId,
      type: "truth_event",
      payload: buildTruthFactUpsertedEvent({
        id: "truth-1",
        kind: "test",
        status: "active",
        severity: "warn",
        summary: "truth update",
        evidenceIds: ["led-1"],
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      }) as unknown as Record<string, unknown>,
    });
    expect(turnReplay.hasSession(sessionId)).toBe(false);

    runtime.truth.getState(sessionId);
    expect(turnReplay.hasSession(sessionId)).toBe(true);
  });
});

describe("tape checkpoint automation", () => {
  test("writes checkpoint events by interval and replays consistent state after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-checkpoint-"));
    const sessionId = "tape-checkpoint-1";
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 3;

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "checkpoint consistency",
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth-1",
      kind: "test",
      severity: "warn",
      summary: "first fact",
    });
    runtime.task.addItem(sessionId, { text: "item-1", status: "todo" });
    runtime.task.addItem(sessionId, { text: "item-2", status: "doing" });

    const checkpoints = runtime.events.query(sessionId, {
      type: TAPE_CHECKPOINT_EVENT_TYPE,
    });
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    const checkpointPayload = (checkpoints.at(-1)?.payload ?? {}) as {
      schema?: string;
      state?: {
        task?: { items?: Array<{ text?: string }> };
        truth?: { facts?: Array<{ id?: string }> };
      };
    };
    expect(checkpointPayload.schema).toBe("brewva.tape.checkpoint.v1");
    expect(checkpointPayload.state?.task?.items?.some((item) => item.text === "item-1")).toBe(true);
    expect(checkpointPayload.state?.truth?.facts?.some((fact) => fact.id === "truth-1")).toBe(true);

    runtime.truth.upsertFact(sessionId, {
      id: "truth-2",
      kind: "test",
      severity: "error",
      summary: "second fact",
    });
    runtime.task.addItem(sessionId, { text: "item-3", status: "todo" });

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    const taskState = reloaded.task.getState(sessionId);
    const truthState = reloaded.truth.getState(sessionId);
    expect(taskState.items.map((item) => item.text)).toEqual(["item-1", "item-2", "item-3"]);
    expect(truthState.facts.some((fact) => fact.id === "truth-1")).toBe(true);
    expect(truthState.facts.some((fact) => fact.id === "truth-2")).toBe(true);
  });

  test("rehydrates active skill and tool-call budget state from tape after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-budget-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 0;
    config.security.mode = "strict";
    config.skills.roots = [join(repoRoot(), "skills")];
    const sessionId = "budget-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    const activated = runtime.skills.activate(sessionId, "exploration");
    expect(activated.ok).toBe(true);
    const maxToolCalls = activated.skill?.contract.budget.maxToolCalls ?? 0;
    const consumed = Math.max(1, maxToolCalls);
    for (let index = 0; index < consumed; index += 1) {
      runtime.tools.markCall(sessionId, "look_at");
    }
    const blockedBeforeRestart = runtime.tools.checkAccess(sessionId, "look_at");
    expect(blockedBeforeRestart.allowed).toBe(false);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    const blockedAfterRestart = reloaded.tools.checkAccess(sessionId, "look_at");
    expect(blockedAfterRestart.allowed).toBe(false);
    expect(blockedAfterRestart.reason?.includes("maxToolCalls")).toBe(true);
  });

  test("rehydrates session cost budget state from tape after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-cost-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.costTracking.actionOnExceed = "block_tools";
    config.infrastructure.costTracking.maxCostUsdPerSession = 0.001;
    const sessionId = "cost-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.002,
    });

    const blockedBeforeRestart = runtime.tools.checkAccess(sessionId, "look_at");
    expect(blockedBeforeRestart.allowed).toBe(false);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    const blockedAfterRestart = reloaded.tools.checkAccess(sessionId, "look_at");
    expect(blockedAfterRestart.allowed).toBe(false);
    expect(blockedAfterRestart.reason?.includes("Session cost exceeded")).toBe(true);
  });

  test("rehydrates ledger compaction cooldown turn from tape after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ledger-cooldown-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.ledger.checkpointEveryTurns = 1;
    const sessionId = "ledger-cooldown-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo first-a" },
      outputText: "ok",
      success: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo first-b" },
      outputText: "ok",
      success: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo first-c" },
      outputText: "ok",
      success: true,
    });
    expect(runtime.events.query(sessionId, { type: "ledger_compacted" })).toHaveLength(1);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    reloaded.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo second" },
      outputText: "ok",
      success: true,
    });
    expect(reloaded.events.query(sessionId, { type: "ledger_compacted" })).toHaveLength(1);
  });

  test("rebuilds memory projection from tape after memory files are removed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-rebuild-"));
    const sessionId = "memory-rebuild-1";

    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Recover memory projection from tape",
      constraints: ["rebuild projection when files are missing"],
    });
    runtime.task.recordBlocker(sessionId, {
      message: "projection rebuild validation",
      source: "test",
    });
    const before = await runtime.context.buildInjection(sessionId, "continue");
    expect(before.text.includes("[WorkingMemory]")).toBe(true);

    const memoryDir = join(workspace, ".orchestrator/memory");
    rmSync(join(memoryDir, "units.jsonl"), { force: true });
    rmSync(join(memoryDir, "crystals.jsonl"), { force: true });
    rmSync(join(memoryDir, "insights.jsonl"), { force: true });
    rmSync(join(memoryDir, "evolves.jsonl"), { force: true });
    rmSync(join(memoryDir, "state.json"), { force: true });
    rmSync(join(memoryDir, "working.md"), { force: true });

    const reloaded = new BrewvaRuntime({ cwd: workspace });
    reloaded.context.onTurnStart(sessionId, 2);
    const after = await reloaded.context.buildInjection(sessionId, "continue");
    expect(after.text.includes("[WorkingMemory]")).toBe(true);
    expect(after.text.includes("Recover memory projection from tape")).toBe(true);

    const unitsPath = join(memoryDir, "units.jsonl");
    expect(existsSync(unitsPath)).toBe(true);
    const lines = readFileSync(unitsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("rebuild replays memory review side-effects from tape snapshots", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-review-rebuild-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.evolvesMode = "shadow";
    const sessionId = "memory-review-rebuild-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Use sqlite for current task.",
    });
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Use postgres instead of sqlite for current task.",
    });
    await runtime.context.buildInjection(sessionId, "continue implementation");

    const evolvesPath = join(workspace, ".orchestrator/memory/evolves.jsonl");
    const evolvesRows = readFileSync(evolvesPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            status: string;
            relation: string;
            sourceUnitId: string;
            targetUnitId: string;
            updatedAt: number;
          },
      );
    const evolvesLatest = new Map<
      string,
      {
        id: string;
        status: string;
        relation: string;
        sourceUnitId: string;
        targetUnitId: string;
        updatedAt: number;
      }
    >();
    for (const row of evolvesRows) {
      const current = evolvesLatest.get(row.id);
      if (!current || row.updatedAt >= current.updatedAt) {
        evolvesLatest.set(row.id, row);
      }
    }
    const proposed = [...evolvesLatest.values()].find((edge) => edge.status === "proposed");
    expect(proposed).toBeDefined();
    if (!proposed) return;

    const accepted = runtime.memory.reviewEvolvesEdge(sessionId, {
      edgeId: proposed.id,
      decision: "accept",
    });
    expect(accepted).toEqual({ ok: true });

    const insightsPath = join(workspace, ".orchestrator/memory/insights.jsonl");
    const insightRowsBefore = readFileSync(insightsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            kind?: string;
            status: string;
            edgeId?: string | null;
            updatedAt: number;
          },
      );
    const insightsLatestBefore = new Map<
      string,
      { id: string; kind?: string; status: string; edgeId?: string | null; updatedAt: number }
    >();
    for (const row of insightRowsBefore) {
      const current = insightsLatestBefore.get(row.id);
      if (!current || row.updatedAt >= current.updatedAt) {
        insightsLatestBefore.set(row.id, row);
      }
    }
    const evolvesInsightBefore = [...insightsLatestBefore.values()].find(
      (row) => row.kind === "evolves_pending" && row.edgeId === proposed.id,
    );
    expect(evolvesInsightBefore).toBeDefined();
    expect(evolvesInsightBefore?.status).toBe("dismissed");
    if (!evolvesInsightBefore) return;

    const memoryDir = join(workspace, ".orchestrator/memory");
    rmSync(join(memoryDir, "units.jsonl"), { force: true });
    rmSync(join(memoryDir, "crystals.jsonl"), { force: true });
    rmSync(join(memoryDir, "insights.jsonl"), { force: true });
    rmSync(join(memoryDir, "evolves.jsonl"), { force: true });
    rmSync(join(memoryDir, "state.json"), { force: true });
    rmSync(join(memoryDir, "working.md"), { force: true });

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 2);
    await reloaded.context.buildInjection(sessionId, "continue implementation");

    const evolvesRowsAfter = readFileSync(evolvesPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            status: string;
            sourceUnitId: string;
            targetUnitId: string;
            updatedAt: number;
          },
      );
    const evolvesLatestAfter = new Map<
      string,
      { id: string; status: string; sourceUnitId: string; targetUnitId: string; updatedAt: number }
    >();
    for (const row of evolvesRowsAfter) {
      const current = evolvesLatestAfter.get(row.id);
      if (!current || row.updatedAt >= current.updatedAt) {
        evolvesLatestAfter.set(row.id, row);
      }
    }
    expect(evolvesLatestAfter.get(proposed.id)?.status).toBe("accepted");

    const unitsPath = join(workspace, ".orchestrator/memory/units.jsonl");
    const unitRowsAfter = readFileSync(unitsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; status: string; updatedAt: number });
    const unitsLatestAfter = new Map<string, { id: string; status: string; updatedAt: number }>();
    for (const row of unitRowsAfter) {
      const current = unitsLatestAfter.get(row.id);
      if (!current || row.updatedAt >= current.updatedAt) {
        unitsLatestAfter.set(row.id, row);
      }
    }
    expect(unitsLatestAfter.get(proposed.targetUnitId)?.status).toBe("superseded");

    const insightRowsAfter = readFileSync(insightsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            kind?: string;
            status: string;
            edgeId?: string | null;
            updatedAt: number;
          },
      );
    const insightsLatestAfter = new Map<
      string,
      { id: string; kind?: string; status: string; edgeId?: string | null; updatedAt: number }
    >();
    for (const row of insightRowsAfter) {
      const current = insightsLatestAfter.get(row.id);
      if (!current || row.updatedAt >= current.updatedAt) {
        insightsLatestAfter.set(row.id, row);
      }
    }
    expect(insightsLatestAfter.get(evolvesInsightBefore.id)?.status).toBe("dismissed");
  });
});

describe("tape status and search", () => {
  test("recordTapeHandoff writes anchor and resets entriesSinceAnchor", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-status-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tape-status-1";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "status baseline",
    });
    runtime.task.addItem(sessionId, { text: "before anchor" });

    const before = runtime.events.getTapeStatus(sessionId);
    expect(before.totalEntries).toBeGreaterThan(0);
    expect(before.entriesSinceAnchor).toBe(before.totalEntries);

    const handoff = runtime.events.recordTapeHandoff(sessionId, {
      name: "investigation-done",
      summary: "captured findings",
      nextSteps: "implement changes",
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.eventId).toBeDefined();

    const after = runtime.events.getTapeStatus(sessionId);
    expect(after.lastAnchor?.name).toBe("investigation-done");
    expect(after.entriesSinceAnchor).toBe(0);

    runtime.task.addItem(sessionId, { text: "after anchor" });
    const afterMore = runtime.events.getTapeStatus(sessionId);
    expect(afterMore.entriesSinceAnchor).toBe(1);
  });

  test("searchTape scopes current phase by latest anchor", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-search-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tape-search-1";

    runtime.events.recordTapeHandoff(sessionId, {
      name: "phase-a",
      summary: "alpha baseline",
      nextSteps: "continue",
    });
    runtime.task.addItem(sessionId, { text: "alpha task" });

    runtime.events.recordTapeHandoff(sessionId, {
      name: "phase-b",
      summary: "beta baseline",
      nextSteps: "continue",
    });
    runtime.task.addItem(sessionId, { text: "beta task" });

    const allPhases = runtime.events.searchTape(sessionId, {
      query: "alpha",
      scope: "all_phases",
    });
    expect(allPhases.matches.length).toBeGreaterThan(0);

    const currentPhase = runtime.events.searchTape(sessionId, {
      query: "alpha",
      scope: "current_phase",
    });
    expect(currentPhase.matches).toHaveLength(0);

    const anchorOnly = runtime.events.searchTape(sessionId, {
      query: "phase-b",
      scope: "anchors_only",
    });
    expect(anchorOnly.matches.length).toBe(1);
    expect(anchorOnly.matches[0]?.type).toBe("anchor");
  });
});
