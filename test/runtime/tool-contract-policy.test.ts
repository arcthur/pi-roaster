import { cpSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime, type SkillContract } from "@brewva/brewva-runtime";

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
    skillOverrides?: Record<string, Partial<SkillContract>>;
  } = {},
): BrewvaRuntime {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.security = {
    ...config.security,
    ...options.security,
    enforceDeniedTools: true,
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
  test("warn mode allows disallowed tools but emits deduped warnings", () => {
    const workspace = createWorkspace("tool-contract-warn");
    const runtime = createRuntime(workspace, { security: { allowedToolsMode: "warn" } });
    const sessionId = "tool-contract-warn-1";

    expect(runtime.activateSkill(sessionId, "patching").ok).toBe(true);

    expect(runtime.checkToolAccess(sessionId, "look_at").allowed).toBe(true);
    expect(runtime.queryEvents(sessionId, { type: "tool_contract_warning" })).toHaveLength(1);

    expect(runtime.checkToolAccess(sessionId, "look_at").allowed).toBe(true);
    expect(runtime.queryEvents(sessionId, { type: "tool_contract_warning" })).toHaveLength(1);

    expect(runtime.checkToolAccess(sessionId, "ast_grep_search").allowed).toBe(true);
    expect(runtime.queryEvents(sessionId, { type: "tool_contract_warning" })).toHaveLength(2);
  });

  test("enforce mode blocks disallowed tools but allows reserved lifecycle tools", () => {
    const workspace = createWorkspace("tool-contract-enforce");
    const runtime = createRuntime(workspace, { security: { allowedToolsMode: "enforce" } });
    const sessionId = "tool-contract-enforce-1";

    expect(runtime.activateSkill(sessionId, "patching").ok).toBe(true);

    const blocked = runtime.checkToolAccess(sessionId, "look_at");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("not allowed")).toBe(true);
    expect(runtime.queryEvents(sessionId, { type: "tool_call_blocked" })).toHaveLength(1);

    // Reserved tools should not deadlock skill lifecycle even if not declared.
    expect(runtime.checkToolAccess(sessionId, "cost_view").allowed).toBe(true);
    expect(runtime.checkToolAccess(sessionId, "tape_handoff").allowed).toBe(true);
    expect(runtime.checkToolAccess(sessionId, "tape_info").allowed).toBe(true);
    expect(runtime.checkToolAccess(sessionId, "tape_search").allowed).toBe(true);
    expect(runtime.checkToolAccess(sessionId, "session_compact").allowed).toBe(true);
    expect(runtime.checkToolAccess(sessionId, "rollback_last_patch").allowed).toBe(true);
  });
});

describe("skill maxTokens contract modes", () => {
  test("warn mode allows tools after token budget is exceeded but emits deduped warning", () => {
    const workspace = createWorkspace("skill-max-tokens-warn");
    const runtime = createRuntime(workspace, {
      security: { skillMaxTokensMode: "warn", allowedToolsMode: "off" },
      skillOverrides: { patching: { budget: { maxToolCalls: 1_000_000, maxTokens: 10 } } },
    });
    const sessionId = "skill-max-tokens-warn-1";

    expect(runtime.activateSkill(sessionId, "patching").ok).toBe(true);

    runtime.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 11,
      costUsd: 0,
    });

    expect(runtime.checkToolAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.queryEvents(sessionId, { type: "skill_budget_warning" })).toHaveLength(1);

    expect(runtime.checkToolAccess(sessionId, "grep").allowed).toBe(true);
    expect(runtime.queryEvents(sessionId, { type: "skill_budget_warning" })).toHaveLength(1);
  });

  test("enforce mode blocks tools after token budget is exceeded but allows reserved lifecycle tools", () => {
    const workspace = createWorkspace("skill-max-tokens-enforce");
    const runtime = createRuntime(workspace, {
      security: { skillMaxTokensMode: "enforce", allowedToolsMode: "off" },
      skillOverrides: { patching: { budget: { maxToolCalls: 1_000_000, maxTokens: 10 } } },
    });
    const sessionId = "skill-max-tokens-enforce-1";

    expect(runtime.activateSkill(sessionId, "patching").ok).toBe(true);

    runtime.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 11,
      costUsd: 0,
    });

    const blocked = runtime.checkToolAccess(sessionId, "grep");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("exceeded maxTokens")).toBe(true);

    expect(runtime.checkToolAccess(sessionId, "cost_view").allowed).toBe(true);
    expect(runtime.checkToolAccess(sessionId, "tape_handoff").allowed).toBe(true);
    expect(runtime.checkToolAccess(sessionId, "tape_info").allowed).toBe(true);
    expect(runtime.checkToolAccess(sessionId, "tape_search").allowed).toBe(true);
    expect(runtime.checkToolAccess(sessionId, "session_compact").allowed).toBe(true);
  });
});

describe("skill maxParallel contract modes", () => {
  test("warn mode allows acquiring slots beyond maxParallel but emits deduped warning", () => {
    const workspace = createWorkspace("skill-max-parallel-warn");
    const runtime = createRuntime(workspace, {
      security: { skillMaxParallelMode: "warn", allowedToolsMode: "off" },
      skillOverrides: { patching: { maxParallel: 1 } },
    });
    const sessionId = "skill-max-parallel-warn-1";

    expect(runtime.activateSkill(sessionId, "patching").ok).toBe(true);

    expect(runtime.acquireParallelSlot(sessionId, "run-1").accepted).toBe(true);
    expect(runtime.acquireParallelSlot(sessionId, "run-2").accepted).toBe(true);
    expect(runtime.queryEvents(sessionId, { type: "skill_parallel_warning" })).toHaveLength(1);
  });

  test("enforce mode rejects acquiring slots beyond maxParallel", () => {
    const workspace = createWorkspace("skill-max-parallel-enforce");
    const runtime = createRuntime(workspace, {
      security: { skillMaxParallelMode: "enforce", allowedToolsMode: "off" },
      skillOverrides: { patching: { maxParallel: 1 } },
    });
    const sessionId = "skill-max-parallel-enforce-1";

    expect(runtime.activateSkill(sessionId, "patching").ok).toBe(true);

    expect(runtime.acquireParallelSlot(sessionId, "run-1").accepted).toBe(true);
    const rejected = runtime.acquireParallelSlot(sessionId, "run-2");
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe("skill_max_parallel");
  });
});
