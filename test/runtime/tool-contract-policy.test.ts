import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaRuntime,
  type SkillContractOverride,
} from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });

  const repoRoot = resolve(import.meta.dirname, "../..");
  cpSync(resolve(repoRoot, "skills"), resolve(workspace, "skills"), { recursive: true });
  return workspace;
}

function createRuntime(
  workspace: string,
  options: {
    security?: Partial<BrewvaRuntime["config"]["security"]>;
    skillOverrides?: Record<string, SkillContractOverride>;
  } = {},
): BrewvaRuntime {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.security = {
    ...config.security,
    ...options.security,
  };
  if (options.skillOverrides) {
    config.skills.overrides = {
      ...config.skills.overrides,
      ...options.skillOverrides,
    };
  }
  config.infrastructure.events.enabled = true;
  config.ledger.path = ".orchestrator/ledger/evidence.jsonl";
  config.infrastructure.events.dir = ".orchestrator/events";
  return new BrewvaRuntime({ cwd: workspace, config });
}

describe("tool contract policy modes", () => {
  test("given security mode standard, when disallowed tool is checked, then access is allowed and warning is deduplicated", () => {
    const workspace = createWorkspace("tool-contract-warn");
    const runtime = createRuntime(workspace, { security: { mode: "standard" } });
    const sessionId = "tool-contract-warn-1";

    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);

    expect(runtime.tools.checkAccess(sessionId, "look_at").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(1);

    expect(runtime.tools.checkAccess(sessionId, "look_at").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(1);

    expect(runtime.tools.checkAccess(sessionId, "ast_grep_search").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(2);
  });

  test("given warning already emitted before restart, when runtime reloads, then duplicate tool-contract warning is not re-emitted", () => {
    const workspace = createWorkspace("tool-contract-warn-restart");
    const options = { security: { mode: "standard" as const } };
    const sessionId = "tool-contract-warn-restart-1";

    const runtime = createRuntime(workspace, options);
    runtime.context.onTurnStart(sessionId, 1);
    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "look_at").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(1);

    const reloaded = createRuntime(workspace, options);
    reloaded.context.onTurnStart(sessionId, 1);
    expect(reloaded.tools.checkAccess(sessionId, "look_at").allowed).toBe(true);
    expect(reloaded.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(1);
  });

  test("given security mode strict, when disallowed tool is checked, then tool is blocked while lifecycle tools stay allowed", () => {
    const workspace = createWorkspace("tool-contract-enforce");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "tool-contract-enforce-1";

    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);

    const blocked = runtime.tools.checkAccess(sessionId, "look_at");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("not allowed")).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_call_blocked" })).toHaveLength(1);

    // Reserved tools should not deadlock skill lifecycle even if not declared.
    expect(runtime.tools.checkAccess(sessionId, "cost_view").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "tape_handoff").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "tape_info").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "tape_search").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "session_compact").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "rollback_last_patch").allowed).toBe(true);
  });
});

describe("skill maxTokens contract modes", () => {
  test("given maxTokens exceeded in standard mode, when checking access, then tool stays allowed and warning is deduplicated", () => {
    const workspace = createWorkspace("skill-max-tokens-warn");
    const runtime = createRuntime(workspace, {
      security: { mode: "standard" },
      skillOverrides: { patching: { budget: { maxToolCalls: 1_000_000, maxTokens: 10 } } },
    });
    const sessionId = "skill-max-tokens-warn-1";

    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);

    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 11,
      costUsd: 0,
    });

    expect(runtime.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(1);

    expect(runtime.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(1);
  });

  test("given maxTokens exceeded in strict mode, when checking access, then non-lifecycle tool is blocked and lifecycle tools are allowed", () => {
    const workspace = createWorkspace("skill-max-tokens-enforce");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: { patching: { budget: { maxToolCalls: 1_000_000, maxTokens: 10 } } },
    });
    const sessionId = "skill-max-tokens-enforce-1";

    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);

    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 11,
      costUsd: 0,
    });

    const blocked = runtime.tools.checkAccess(sessionId, "grep");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("exceeded maxTokens")).toBe(true);

    expect(runtime.tools.checkAccess(sessionId, "cost_view").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "tape_handoff").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "tape_info").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "tape_search").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "session_compact").allowed).toBe(true);
  });
});

describe("skill maxToolCalls contract modes", () => {
  test("given maxToolCalls exceeded in standard mode, when checking access, then tool stays allowed and warning is deduplicated", () => {
    const workspace = createWorkspace("skill-max-tool-calls-warn");
    const runtime = createRuntime(workspace, {
      security: { mode: "standard" },
      skillOverrides: { patching: { budget: { maxToolCalls: 1 } } },
    });
    const sessionId = "skill-max-tool-calls-warn-1";

    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);
    runtime.tools.markCall(sessionId, "read");

    expect(runtime.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(1);

    expect(runtime.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(1);
  });

  test("given maxToolCalls warning emitted before restart, when runtime reloads, then duplicate warning is not re-emitted", () => {
    const workspace = createWorkspace("skill-max-tool-calls-warn-restart");
    const options = {
      security: { mode: "standard" as const },
      skillOverrides: { patching: { budget: { maxToolCalls: 1 } } },
    };
    const sessionId = "skill-max-tool-calls-warn-restart-1";

    const runtime = createRuntime(workspace, options);
    runtime.context.onTurnStart(sessionId, 1);
    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);
    runtime.tools.markCall(sessionId, "read");
    expect(runtime.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(1);

    const reloaded = createRuntime(workspace, options);
    reloaded.context.onTurnStart(sessionId, 1);
    expect(reloaded.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(reloaded.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(1);
  });

  test("given maxToolCalls exceeded in strict mode, when non-lifecycle tool is checked, then access is blocked", () => {
    const workspace = createWorkspace("skill-max-tool-calls-enforce");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: { patching: { budget: { maxToolCalls: 1 } } },
    });
    const sessionId = "skill-max-tool-calls-enforce-1";

    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);
    runtime.tools.markCall(sessionId, "read");

    const blocked = runtime.tools.checkAccess(sessionId, "grep");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("exceeded maxToolCalls")).toBe(true);
  });

  test("given maxToolCalls exceeded in strict mode, when lifecycle completion tools are checked, then access is allowed", () => {
    const workspace = createWorkspace("skill-max-tool-calls-lifecycle");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: { patching: { budget: { maxToolCalls: 1 } } },
    });
    const sessionId = "skill-max-tool-calls-lifecycle-1";

    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);
    runtime.tools.markCall(sessionId, "read");

    expect(runtime.tools.checkAccess(sessionId, "skill_complete").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "skill_load").allowed).toBe(true);
  });
});

describe("skill maxParallel contract modes", () => {
  test("given maxParallel exceeded in standard mode, when acquiring slots, then acquisition is allowed and warning is emitted once", () => {
    const workspace = createWorkspace("skill-max-parallel-warn");
    const runtime = createRuntime(workspace, {
      security: { mode: "standard" },
      skillOverrides: { patching: { maxParallel: 1 } },
    });
    const sessionId = "skill-max-parallel-warn-1";

    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);

    expect(runtime.tools.acquireParallelSlot(sessionId, "run-1").accepted).toBe(true);
    expect(runtime.tools.acquireParallelSlot(sessionId, "run-2").accepted).toBe(true);
    expect(runtime.events.query(sessionId, { type: "skill_parallel_warning" })).toHaveLength(1);
  });

  test("given maxParallel exceeded in strict mode, when acquiring slot, then acquisition is rejected", () => {
    const workspace = createWorkspace("skill-max-parallel-enforce");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: { patching: { maxParallel: 1 } },
    });
    const sessionId = "skill-max-parallel-enforce-1";

    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);

    expect(runtime.tools.acquireParallelSlot(sessionId, "run-1").accepted).toBe(true);
    const rejected = runtime.tools.acquireParallelSlot(sessionId, "run-2");
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe("skill_max_parallel");
  });
});
