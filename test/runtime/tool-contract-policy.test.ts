import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaRuntime,
  getToolGovernanceDescriptor,
  registerToolGovernanceDescriptor,
  type SkillContractOverride,
  unregisterToolGovernanceDescriptor,
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

describe("effect governance policy modes", () => {
  test("standard mode warns on unauthorized effects and deduplicates the warning", () => {
    const workspace = createWorkspace("effect-governance-warn");
    const runtime = createRuntime(workspace, { security: { mode: "standard" } });
    const sessionId = "effect-governance-warn-1";

    expect(runtime.skills.activate(sessionId, "design").ok).toBe(true);

    expect(runtime.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(1);

    expect(runtime.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(1);
  });

  test("warning state survives restart without re-emitting duplicates", () => {
    const workspace = createWorkspace("effect-governance-warn-restart");
    const options = { security: { mode: "standard" as const } };
    const sessionId = "effect-governance-warn-restart-1";

    const runtime = createRuntime(workspace, options);
    runtime.context.onTurnStart(sessionId, 1);
    expect(runtime.skills.activate(sessionId, "design").ok).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(1);

    const reloaded = createRuntime(workspace, options);
    reloaded.context.onTurnStart(sessionId, 1);
    expect(reloaded.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(true);
    expect(reloaded.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(1);
  });

  test("denied effects stay blocked even in permissive mode", () => {
    const workspace = createWorkspace("effect-governance-permissive-denied");
    const runtime = createRuntime(workspace, {
      security: { mode: "permissive" },
      skillOverrides: {
        design: {
          effects: {
            deniedEffects: ["workspace_read"],
          },
        },
      },
    });
    const sessionId = "effect-governance-permissive-denied-1";

    expect(runtime.skills.activate(sessionId, "design").ok).toBe(true);

    const blocked = runtime.tools.checkAccess(sessionId, "grep");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("denied effects")).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_call_blocked" })).toHaveLength(1);
  });

  test("strict mode blocks unauthorized effects while control-plane tools stay allowed", () => {
    const workspace = createWorkspace("effect-governance-enforce");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "effect-governance-enforce-1";

    expect(runtime.skills.activate(sessionId, "design").ok).toBe(true);

    const blocked = runtime.tools.checkAccess(sessionId, "task_add_item");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("unauthorized effects")).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_call_blocked" })).toHaveLength(1);

    expect(runtime.tools.checkAccess(sessionId, "resource_lease").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "cost_view").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "tape_handoff").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "tape_info").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "tape_search").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "session_compact").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "rollback_last_patch").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "cognition_note").allowed).toBe(true);
  });

  test("standard mode with effect enforcement override blocks unauthorized effects", () => {
    const workspace = createWorkspace("effect-governance-standard-override");
    const runtime = createRuntime(workspace, {
      security: {
        mode: "standard",
        enforcement: {
          effectAuthorizationMode: "enforce",
          skillMaxTokensMode: "inherit",
          skillMaxToolCallsMode: "inherit",
          skillMaxParallelMode: "inherit",
        },
      },
    });
    const sessionId = "effect-governance-standard-override-1";

    expect(runtime.skills.activate(sessionId, "design").ok).toBe(true);
    const blocked = runtime.tools.checkAccess(sessionId, "task_add_item");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("unauthorized effects")).toBe(true);
  });

  test("strict mode warns but does not block unknown tools that lack governance metadata", () => {
    const workspace = createWorkspace("effect-governance-unknown-tool");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "effect-governance-unknown-tool-1";

    expect(runtime.skills.activate(sessionId, "design").ok).toBe(true);

    const access = runtime.tools.checkAccess(sessionId, "custom_tool");
    expect(access.allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_contract_warning" })).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "tool_call_blocked" })).toHaveLength(0);
  });

  test("custom governance descriptors let strict mode enforce third-party tools", () => {
    const workspace = createWorkspace("effect-governance-custom-descriptor");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "effect-governance-custom-descriptor-1";

    registerToolGovernanceDescriptor("custom_exec_tool", {
      effects: ["local_exec"],
      defaultRisk: "high",
    });
    try {
      expect(runtime.skills.activate(sessionId, "design").ok).toBe(true);
      const blocked = runtime.tools.checkAccess(sessionId, "custom_exec_tool");
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason?.includes("local_exec")).toBe(true);
    } finally {
      unregisterToolGovernanceDescriptor("custom_exec_tool");
    }
  });

  test("command heuristics no longer misclassify generic process_* tool names as local_exec", () => {
    expect(getToolGovernanceDescriptor("process")).toEqual({
      effects: ["local_exec"],
      defaultRisk: "medium",
    });
    expect(getToolGovernanceDescriptor("process_image")).toBeUndefined();
    expect(getToolGovernanceDescriptor("data_process")).toBeUndefined();
  });
});

describe("skill resource budgets", () => {
  test("maxTokens warnings are deduplicated in standard mode", () => {
    const workspace = createWorkspace("skill-max-tokens-warn");
    const runtime = createRuntime(workspace, {
      security: { mode: "standard" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxToolCalls: 1_000_000, maxTokens: 10 },
          },
        },
      },
    });
    const sessionId = "skill-max-tokens-warn-1";

    expect(runtime.skills.activate(sessionId, "implementation").ok).toBe(true);

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

  test("strict mode blocks non-lifecycle tools when maxTokens is exceeded", () => {
    const workspace = createWorkspace("skill-max-tokens-enforce");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxToolCalls: 1_000_000, maxTokens: 10 },
          },
        },
      },
    });
    const sessionId = "skill-max-tokens-enforce-1";

    expect(runtime.skills.activate(sessionId, "implementation").ok).toBe(true);

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

    expect(runtime.tools.checkAccess(sessionId, "resource_lease").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "skill_complete").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "skill_load").allowed).toBe(true);
  });

  test("maxToolCalls warnings are deduplicated in standard mode", () => {
    const workspace = createWorkspace("skill-max-tool-calls-warn");
    const runtime = createRuntime(workspace, {
      security: { mode: "standard" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "skill-max-tool-calls-warn-1";

    expect(runtime.skills.activate(sessionId, "implementation").ok).toBe(true);
    runtime.tools.markCall(sessionId, "read");

    expect(runtime.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(1);

    expect(runtime.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "skill_budget_warning" })).toHaveLength(1);
  });

  test("strict mode blocks non-lifecycle tools when maxToolCalls is exceeded", () => {
    const workspace = createWorkspace("skill-max-tool-calls-enforce");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "skill-max-tool-calls-enforce-1";

    expect(runtime.skills.activate(sessionId, "implementation").ok).toBe(true);
    runtime.tools.markCall(sessionId, "read");

    const blocked = runtime.tools.checkAccess(sessionId, "grep");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("exceeded maxToolCalls")).toBe(true);
  });

  test("strict mode keeps lifecycle completion tools usable when maxToolCalls is exceeded", () => {
    const workspace = createWorkspace("skill-max-tool-calls-lifecycle");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "skill-max-tool-calls-lifecycle-1";

    expect(runtime.skills.activate(sessionId, "implementation").ok).toBe(true);
    runtime.tools.markCall(sessionId, "read");

    expect(runtime.tools.checkAccess(sessionId, "skill_complete").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "skill_load").allowed).toBe(true);
  });
});

describe("skill parallel lease budgets", () => {
  test("maxParallel warnings are emitted once in standard mode", () => {
    const workspace = createWorkspace("skill-max-parallel-warn");
    const runtime = createRuntime(workspace, {
      security: { mode: "standard" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxParallel: 1 },
          },
        },
      },
    });
    const sessionId = "skill-max-parallel-warn-1";

    expect(runtime.skills.activate(sessionId, "implementation").ok).toBe(true);

    expect(runtime.tools.acquireParallelSlot(sessionId, "run-1").accepted).toBe(true);
    expect(runtime.tools.acquireParallelSlot(sessionId, "run-2").accepted).toBe(true);
    expect(runtime.events.query(sessionId, { type: "skill_parallel_warning" })).toHaveLength(1);
  });

  test("strict mode rejects parallel slots beyond the effective lease", () => {
    const workspace = createWorkspace("skill-max-parallel-enforce");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        implementation: {
          resources: {
            defaultLease: { maxParallel: 1 },
          },
        },
      },
    });
    const sessionId = "skill-max-parallel-enforce-1";

    expect(runtime.skills.activate(sessionId, "implementation").ok).toBe(true);

    expect(runtime.tools.acquireParallelSlot(sessionId, "run-1").accepted).toBe(true);
    const rejected = runtime.tools.acquireParallelSlot(sessionId, "run-2");
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe("skill_max_parallel");
  });
});

describe("resource lease negotiation", () => {
  test("resource leases require an active skill scope", () => {
    const workspace = createWorkspace("resource-lease-active-skill");
    const runtime = createRuntime(workspace, { security: { mode: "strict" } });
    const sessionId = "resource-lease-active-skill-1";

    const lease = runtime.tools.requestResourceLease(sessionId, {
      reason: "Need one extra read call.",
      budget: { maxToolCalls: 1 },
      ttlTurns: 1,
    });

    expect(lease.ok).toBe(false);
    if (!lease.ok) {
      expect(lease.error).toContain("active skill");
    }
    expect(runtime.tools.listResourceLeases(sessionId)).toHaveLength(0);
  });

  test("resource leases do not alter effect authorization", () => {
    const workspace = createWorkspace("resource-lease-effect");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        design: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
            hardCeiling: { maxToolCalls: 2, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "resource-lease-effect-1";

    expect(runtime.skills.activate(sessionId, "design").ok).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(false);

    const lease = runtime.tools.requestResourceLease(sessionId, {
      reason: "Need one more read call while staying within the design skill boundary.",
      budget: { maxToolCalls: 1 },
      ttlTurns: 2,
    });
    expect(lease.ok).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "task_add_item").allowed).toBe(false);
    expect(runtime.tools.listResourceLeases(sessionId)).toHaveLength(1);
  });

  test("resource leases can expand maxToolCalls within the hard ceiling", () => {
    const workspace = createWorkspace("resource-lease-budget");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        design: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
            hardCeiling: { maxToolCalls: 2, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "resource-lease-budget-1";

    expect(runtime.skills.activate(sessionId, "design").ok).toBe(true);
    runtime.tools.markCall(sessionId, "read");
    expect(runtime.tools.checkAccess(sessionId, "grep").allowed).toBe(false);

    const lease = runtime.tools.requestResourceLease(sessionId, {
      reason: "Need one more read tool call to finish inventory.",
      budget: { maxToolCalls: 1 },
      ttlTurns: 1,
    });
    expect(lease.ok).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "grep").allowed).toBe(true);
  });

  test("resource leases explain when hard ceilings leave no headroom", () => {
    const workspace = createWorkspace("resource-lease-no-headroom");
    const runtime = createRuntime(workspace, {
      security: { mode: "strict" },
      skillOverrides: {
        design: {
          resources: {
            defaultLease: { maxToolCalls: 1, maxTokens: 100000 },
            hardCeiling: { maxToolCalls: 1, maxTokens: 100000 },
          },
        },
      },
    });
    const sessionId = "resource-lease-no-headroom-1";

    expect(runtime.skills.activate(sessionId, "design").ok).toBe(true);
    const lease = runtime.tools.requestResourceLease(sessionId, {
      reason: "Need one more call.",
      budget: { maxToolCalls: 1 },
      ttlTurns: 1,
    });

    expect(lease.ok).toBe(false);
    if (!lease.ok) {
      expect(lease.error).toContain("hard_ceiling");
    }
  });
});
