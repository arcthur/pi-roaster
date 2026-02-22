import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  ParallelBudgetManager,
  BrewvaRuntime,
  TAPE_CHECKPOINT_EVENT_TYPE,
  tightenContract,
} from "@brewva/brewva-runtime";
import type { SkillContract } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("S-001 selector inject top-k and anti-tags", () => {
  test("selects candidates and excludes anti-tags", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const selected = runtime.selectSkills("debug failing test regression in typescript module");
    expect(selected.length).toBeGreaterThan(0);

    const docsSelected = runtime.selectSkills("implement a new feature and update docs");
    expect(docsSelected.some((skill) => skill.name === "debugging")).toBe(false);
  });
});

describe("S-002 denied tool gate", () => {
  test("blocks denied write for active patching skill", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s2";
    const activated = runtime.activateSkill(sessionId, "patching");
    expect(activated.ok).toBe(true);

    const access = runtime.checkToolAccess(sessionId, "write");
    expect(access.allowed).toBe(false);
  });

  test("allows denied tool when enforcement is disabled", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    runtime.config.security.enforceDeniedTools = false;

    const sessionId = "s2-disabled";
    const activated = runtime.activateSkill(sessionId, "patching");
    expect(activated.ok).toBe(true);

    const access = runtime.checkToolAccess(sessionId, "write");
    expect(access.allowed).toBe(true);
  });

  test("blocks removed bash/shell tools with migration hint", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s2-removed-tools";

    const bash = runtime.checkToolAccess(sessionId, "bash");
    expect(bash.allowed).toBe(false);
    expect(bash.reason?.includes("removed")).toBe(true);
    expect(bash.reason?.includes("exec")).toBe(true);
    expect(bash.reason?.includes("process")).toBe(true);

    const shell = runtime.checkToolAccess(sessionId, "shell");
    expect(shell.allowed).toBe(false);
    expect(shell.reason?.includes("removed")).toBe(true);
  });
});

describe("S-003 ledger write/query", () => {
  test("records and queries last entries", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s3";

    runtime.recordToolResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "PASS",
      success: true,
    });

    const text = runtime.queryLedger(sessionId, { last: 5 });
    expect(text.includes("exec")).toBe(true);
    expect(text.includes("PASS")).toBe(true);
  });
});

describe("S-004/S-005 verification gate", () => {
  test("blocks without evidence after write and passes with evidence", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s4";

    runtime.markToolCall(sessionId, "edit");
    const blocked = runtime.evaluateCompletion(sessionId);
    expect(blocked.passed).toBe(false);
    expect(blocked.missingEvidence).toContain("lsp_diagnostics");
    expect(blocked.missingEvidence).toContain("test_or_build");

    runtime.recordToolResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      success: true,
    });
    runtime.recordToolResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "All tests passed",
      success: true,
    });

    const passed = runtime.evaluateCompletion(sessionId);
    expect(passed.passed).toBe(true);
  });

  test("treats multi_edit as a mutation tool for verification gating", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s4-multi-edit";

    runtime.markToolCall(sessionId, "multi_edit");
    const blocked = runtime.evaluateCompletion(sessionId);
    expect(blocked.passed).toBe(false);
    expect(blocked.missingEvidence).toContain("lsp_diagnostics");
    expect(blocked.missingEvidence).toContain("test_or_build");
  });
});

describe("S-006 three-layer contract tightening", () => {
  test("project contract cannot relax base contract", () => {
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

  test("higher tier keeps stricter contract when overriding", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-s6-"));
    mkdirSync(join(workspace, ".brewva"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify({
        skills: {
          packs: [],
          disabled: [],
          overrides: {},
          selector: { k: 4, maxDigestTokens: 1200 },
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
    const foo = runtime.getSkill("foo");
    expect(foo).toBeDefined();
    expect(foo!.contract.tools.denied).toContain("write");
    expect(foo!.contract.tools.denied).toContain("exec");
    expect(foo!.contract.tools.required).toContain("read");
  });
});

describe("skill output registry", () => {
  test("completed skill outputs are queryable by subsequent skills", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "output-reg-1";

    runtime.activateSkill(sessionId, "exploration");
    const outputs = {
      architecture_map: "monorepo with 4 packages",
      key_modules: "runtime, tools, extensions, cli",
      unknowns: "none",
    };
    runtime.completeSkill(sessionId, outputs);

    const stored = runtime.getSkillOutputs(sessionId, "exploration");
    expect(stored).toBeDefined();
    expect(stored!.architecture_map).toBe("monorepo with 4 packages");
  });

  test("getAvailableConsumedOutputs returns matching outputs for skill consumes", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "output-reg-2";

    // debugging consumes: [architecture_map, execution_steps]
    // exploration outputs architecture_map — IS in debugging's consumes
    // but first test with no matching outputs
    runtime.activateSkill(sessionId, "exploration");
    runtime.completeSkill(sessionId, {
      architecture_map: "module map here",
      key_modules: "runtime",
      unknowns: "none",
    });

    // exploration produces architecture_map which debugging consumes — should match
    const available = runtime.getAvailableConsumedOutputs(sessionId, "debugging");
    expect(available.architecture_map).toBe("module map here");

    // planning consumes: [architecture_map, key_modules, unknowns, root_cause]
    // debugging produces root_cause — IS a match
    runtime.activateSkill(sessionId, "debugging");
    runtime.completeSkill(sessionId, {
      root_cause: "null ref in handler",
      fix_description: "added guard",
      evidence: "test passes",
      verification: "pass",
    });

    const planningAvailable = runtime.getAvailableConsumedOutputs(sessionId, "planning");
    expect(planningAvailable.root_cause).toBe("null ref in handler");
  });

  test("getAvailableConsumedOutputs returns empty for unknown skill", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const result = runtime.getAvailableConsumedOutputs("any-session", "nonexistent");
    expect(result).toEqual({});
  });

  test("emits skill_completed event with output keys", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `skill-complete-event-${Date.now()}`;
    runtime.activateSkill(sessionId, "exploration");
    runtime.completeSkill(sessionId, {
      architecture_map: "map",
      unknowns: "none",
      key_modules: "runtime",
    });

    const event = runtime.queryEvents(sessionId, { type: "skill_completed", last: 1 })[0];
    expect(event).toBeDefined();
    const payload = (event?.payload ?? {}) as {
      skillName?: string;
      outputKeys?: string[];
    };
    expect(payload.skillName).toBe("exploration");
    expect(payload.outputKeys).toEqual(["architecture_map", "key_modules", "unknowns"]);
  });

  test("buildContextInjection includes working memory after semantic events", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-injection-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `memory-injection-${Date.now()}`;

    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Inject working memory into context",
      constraints: ["Use event tape as trace source"],
    });
    runtime.recordTaskBlocker(sessionId, {
      message: "verification pending",
      source: "test",
    });

    const injection = runtime.buildContextInjection(sessionId, "continue implementation");
    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("[WorkingMemory]")).toBe(true);
  });

  test("memory can be disabled from config without changing baseline injection behavior", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-disabled-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.enabled = false;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = `memory-disabled-${Date.now()}`;
    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "No memory block expected",
    });

    const injection = runtime.buildContextInjection(sessionId, "continue implementation");
    expect(injection.text.includes("[WorkingMemory]")).toBe(false);
  });

  test("dismissMemoryInsight dismisses open insight and emits event", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-dismiss-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `memory-dismiss-${Date.now()}`;

    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Dismiss repeated memory insight",
    });
    runtime.recordTaskBlocker(sessionId, {
      message: "verification may fail due missing fixtures",
      source: "test",
    });
    runtime.recordTaskBlocker(sessionId, {
      message: "verification may fail due flaky network",
      source: "test",
    });
    runtime.buildContextInjection(sessionId, "continue implementation");

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

    const dismissed = runtime.dismissMemoryInsight(sessionId, openInsight.id);
    expect(dismissed).toEqual({ ok: true });
    const secondDismiss = runtime.dismissMemoryInsight(sessionId, openInsight.id);
    expect(secondDismiss).toEqual({ ok: false, error: "not_found" });

    const dismissEvent = runtime.queryEvents(sessionId, {
      type: "memory_insight_dismissed",
      last: 1,
    })[0];
    expect(dismissEvent).toBeDefined();
    expect((dismissEvent?.payload as { insightId?: string } | undefined)?.insightId).toBe(
      openInsight.id,
    );
  });

  test("reviewMemoryEvolvesEdge accepts proposed edge and emits event", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-review-edge-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.evolvesMode = "shadow";
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = `memory-review-edge-${Date.now()}`;

    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Use sqlite for current task.",
    });
    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Use postgres instead of sqlite for current task.",
    });
    runtime.buildContextInjection(sessionId, "continue implementation");

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

    const accepted = runtime.reviewMemoryEvolvesEdge(sessionId, {
      edgeId: proposed.id,
      decision: "accept",
    });
    expect(accepted).toEqual({ ok: true });
    const second = runtime.reviewMemoryEvolvesEdge(sessionId, {
      edgeId: proposed.id,
      decision: "accept",
    });
    expect(second).toEqual({ ok: false, error: "already_set" });

    const reviewEvent = runtime.queryEvents(sessionId, {
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

    const supersedeEvent = runtime.queryEvents(sessionId, {
      type: "memory_unit_superseded",
      last: 1,
    })[0];
    expect(supersedeEvent).toBeDefined();
  });
});

describe("S-007 parallel budget control", () => {
  test("enforces maxConcurrent and maxTotal", () => {
    const manager = new ParallelBudgetManager({
      enabled: true,
      maxConcurrent: 1,
      maxTotal: 2,
    });

    expect(manager.acquire("s7", "run-a").accepted).toBe(true);
    const blocked = manager.acquire("s7", "run-b");
    expect(blocked.accepted).toBe(false);
    expect(blocked.reason).toBe("max_concurrent");

    manager.release("s7", "run-a");
    expect(manager.acquire("s7", "run-b").accepted).toBe(true);
    manager.release("s7", "run-b");
    const totalBlocked = manager.acquire("s7", "run-c");
    expect(totalBlocked.accepted).toBe(false);
    expect(totalBlocked.reason).toBe("max_total");
  });
});

describe("cost evidence separation in digest", () => {
  test("ledger digest excludes infrastructure entries from summary", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `cost-sep-${Date.now()}`;

    runtime.recordToolResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo hello" },
      outputText: "hello",
      success: true,
    });

    runtime.recordAssistantUsage({
      sessionId,
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.001,
    });

    const digest = runtime.getLedgerDigest(sessionId);
    expect(digest).toContain("count=1");
    expect(digest).not.toContain("brewva_cost");
  });
});

describe("compose plan validation", () => {
  test("validates a correct skill sequence", () => {
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

    const result = runtime.validateComposePlan(validPlan);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects unknown skill references", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    const invalidPlan = {
      steps: [{ skill: "nonexistent_skill", produces: ["foo"] }],
    };

    const result = runtime.validateComposePlan(invalidPlan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent_skill"))).toBe(true);
  });

  test("warns on consumed data not produced by any prior step", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    const plan = {
      steps: [{ skill: "patching", consumes: ["execution_steps"], produces: ["fix_description"] }],
    };

    const result = runtime.validateComposePlan(plan);
    expect(result.warnings.some((w) => w.includes("execution_steps"))).toBe(true);
  });

  test("no warnings when all consumed data is produced by prior steps", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    const plan = {
      steps: [
        { skill: "exploration", produces: ["execution_steps"] },
        { skill: "patching", consumes: ["execution_steps"], produces: ["fix_description"] },
      ],
    };

    const result = runtime.validateComposePlan(plan);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("session state cleanup", () => {
  test("clearSessionState releases in-memory per-session caches", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-session-clean-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "cleanup-state-1";

    runtime.onTurnStart(sessionId, 1);
    runtime.markToolCall(sessionId, "edit");
    runtime.observeContextUsage(sessionId, {
      tokens: 128,
      contextWindow: 4096,
      percent: 0.03125,
    });
    runtime.acquireParallelSlot(sessionId, "run-1");
    runtime.recordWorkerResult(sessionId, {
      workerId: "run-1",
      status: "ok",
      summary: "done",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "diff" }],
      },
    });
    runtime.recordToolResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo ok" },
      outputText: "ok",
      success: true,
    });
    runtime.getTaskState(sessionId);
    runtime.getTruthState(sessionId);
    runtime.recordAssistantUsage({
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
      ((runtime as any).verification.stateStore.sessions as Map<string, unknown>).has(sessionId),
    ).toBe(true);
    expect(((runtime as any).events.fileHasContent as Map<string, boolean>).size).toBe(1);
    expect((runtime as any).ledger.lastHashBySession.has(sessionId) as boolean).toBe(true);

    runtime.clearSessionState(sessionId);

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
      ((runtime as any).verification.stateStore.sessions as Map<string, unknown>).has(sessionId),
    ).toBe(false);
    expect(((runtime as any).parallel.sessions as Map<string, unknown>).has(sessionId)).toBe(false);
    expect(((runtime as any).parallelResults.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
    expect(((runtime as any).events.fileHasContent as Map<string, boolean>).size).toBe(0);
    expect((runtime as any).ledger.lastHashBySession.has(sessionId) as boolean).toBe(false);
  });

  test("invalidates replay cache on task events and rebuilds from tape", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-replay-view-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "replay-view-1";

    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Replay view should rebuild after new events",
    });
    runtime.getTaskState(sessionId);

    const turnReplay = (runtime as any).turnReplay as {
      hasSession: (session: string) => boolean;
    };
    expect(turnReplay.hasSession(sessionId)).toBe(true);

    runtime.addTaskItem(sessionId, { text: "item-1" });
    expect(turnReplay.hasSession(sessionId)).toBe(false);

    const updated = runtime.getTaskState(sessionId);
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]?.text).toBe("item-1");
    expect(turnReplay.hasSession(sessionId)).toBe(true);
  });
});

describe("tape checkpoint automation", () => {
  test("writes checkpoint events by interval and replays consistent state after restart", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-checkpoint-"));
    const sessionId = "tape-checkpoint-1";
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 3;

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "checkpoint consistency",
    });
    runtime.upsertTruthFact(sessionId, {
      id: "truth-1",
      kind: "test",
      severity: "warn",
      summary: "first fact",
    });
    runtime.addTaskItem(sessionId, { text: "item-1", status: "todo" });
    runtime.addTaskItem(sessionId, { text: "item-2", status: "doing" });

    const checkpoints = runtime.queryEvents(sessionId, {
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

    runtime.upsertTruthFact(sessionId, {
      id: "truth-2",
      kind: "test",
      severity: "error",
      summary: "second fact",
    });
    runtime.addTaskItem(sessionId, { text: "item-3", status: "todo" });

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    const taskState = reloaded.getTaskState(sessionId);
    const truthState = reloaded.getTruthState(sessionId);
    expect(taskState.items.map((item) => item.text)).toEqual(["item-1", "item-2", "item-3"]);
    expect(truthState.facts.some((fact) => fact.id === "truth-1")).toBe(true);
    expect(truthState.facts.some((fact) => fact.id === "truth-2")).toBe(true);
  });
});

describe("tape status and search", () => {
  test("recordTapeHandoff writes anchor and resets entriesSinceAnchor", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-status-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tape-status-1";

    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "status baseline",
    });
    runtime.addTaskItem(sessionId, { text: "before anchor" });

    const before = runtime.getTapeStatus(sessionId);
    expect(before.totalEntries).toBeGreaterThan(0);
    expect(before.entriesSinceAnchor).toBe(before.totalEntries);

    const handoff = runtime.recordTapeHandoff(sessionId, {
      name: "investigation-done",
      summary: "captured findings",
      nextSteps: "implement changes",
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.eventId).toBeDefined();

    const after = runtime.getTapeStatus(sessionId);
    expect(after.lastAnchor?.name).toBe("investigation-done");
    expect(after.entriesSinceAnchor).toBe(0);

    runtime.addTaskItem(sessionId, { text: "after anchor" });
    const afterMore = runtime.getTapeStatus(sessionId);
    expect(afterMore.entriesSinceAnchor).toBe(1);
  });

  test("searchTape scopes current phase by latest anchor", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-search-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tape-search-1";

    runtime.recordTapeHandoff(sessionId, {
      name: "phase-a",
      summary: "alpha baseline",
      nextSteps: "continue",
    });
    runtime.addTaskItem(sessionId, { text: "alpha task" });

    runtime.recordTapeHandoff(sessionId, {
      name: "phase-b",
      summary: "beta baseline",
      nextSteps: "continue",
    });
    runtime.addTaskItem(sessionId, { text: "beta task" });

    const allPhases = runtime.searchTape(sessionId, {
      query: "alpha",
      scope: "all_phases",
    });
    expect(allPhases.matches.length).toBeGreaterThan(0);

    const currentPhase = runtime.searchTape(sessionId, {
      query: "alpha",
      scope: "current_phase",
    });
    expect(currentPhase.matches).toHaveLength(0);

    const anchorOnly = runtime.searchTape(sessionId, {
      query: "phase-b",
      scope: "anchors_only",
    });
    expect(anchorOnly.matches.length).toBe(1);
    expect(anchorOnly.matches[0]?.type).toBe("anchor");
  });
});
