import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { ContextBudgetManager } from "../../packages/brewva-runtime/src/context/budget.js";
import { ContextPressureService } from "../../packages/brewva-runtime/src/services/context-pressure.js";
import type {
  BrewvaEventRecord,
  ContextBudgetUsage,
} from "../../packages/brewva-runtime/src/types.js";

function createUsage(percent: number): ContextBudgetUsage {
  return {
    tokens: Math.round(percent * 1_000),
    contextWindow: 1_000,
    percent,
  };
}

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });

  const repoRoot = resolve(import.meta.dirname, "../..");
  cpSync(resolve(repoRoot, "skills"), resolve(workspace, "skills"), { recursive: true });
  return workspace;
}

describe("ContextPressureService", () => {
  test("blocks tools on critical pressure and emits expected payload", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    config.infrastructure.contextBudget.hardLimitPercent = 0.8;
    config.infrastructure.contextBudget.compactionThresholdPercent = 0.7;

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: Record<string, unknown>;
    }> = [];

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("pressure-session", 12);

    const service = new ContextPressureService({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 12,
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    const usage = createUsage(0.9);
    service.observeContextUsage("pressure-session", usage);

    const gate = service.getContextCompactionGateStatus("pressure-session", usage);
    expect(gate.required).toBe(true);
    expect(gate.reason).toBe("hard_limit");

    const gateDecision = service.checkContextCompactionGate("pressure-session", "exec", usage);
    expect(gateDecision.allowed).toBe(false);

    const blocked = events.find((event) => event.type === "context_compaction_gate_blocked_tool");
    expect(blocked).toBeDefined();
    expect(blocked?.payload).toEqual(
      expect.objectContaining({
        blockedTool: "exec",
        reason: "critical_context_pressure_without_compaction",
        usagePercent: 0.9,
        hardLimitPercent: 0.8,
      }),
    );
  });

  test("deduplicates repeated hard_limit compaction request events", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: Record<string, unknown>;
    }> = [];

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("pressure-session", 7);

    const service = new ContextPressureService({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 7,
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    const highUsage = createUsage(0.95);
    service.requestCompaction("pressure-session", "hard_limit", highUsage);
    service.requestCompaction("pressure-session", "hard_limit", highUsage);

    const requestedEvents = events.filter((event) => event.type === "context_compaction_requested");
    expect(requestedEvents).toHaveLength(1);
    expect(requestedEvents[0]?.payload).toEqual(
      expect.objectContaining({
        reason: "hard_limit",
        usagePercent: 0.95,
        tokens: 950,
      }),
    );

    const gate = service.getContextCompactionGateStatus("pressure-session", highUsage);
    expect(gate.required).toBe(true);
    expect(gate.reason).toBe("hard_limit");
  });

  test("does not arm compaction gate from pending reason alone when pressure is below critical", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    config.infrastructure.contextBudget.hardLimitPercent = 0.8;
    config.infrastructure.contextBudget.compactionThresholdPercent = 0.7;

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("pressure-session", 9);

    const service = new ContextPressureService({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 9,
      recordEvent: () => undefined as BrewvaEventRecord | undefined,
    });

    service.requestCompaction("pressure-session", "hard_limit", createUsage(0.5));

    const mediumUsage = createUsage(0.75);
    const gate = service.getContextCompactionGateStatus("pressure-session", mediumUsage);
    expect(gate.pressure.level).toBe("high");
    expect(gate.required).toBe(false);
    expect(gate.reason).toBeNull();

    const decision = service.checkContextCompactionGate("pressure-session", "exec", mediumUsage);
    expect(decision.allowed).toBe(true);
  });

  test("allows control-plane tools during critical pressure when configured as always allowed", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    config.infrastructure.contextBudget.hardLimitPercent = 0.8;

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("pressure-session", 12);

    const service = new ContextPressureService({
      config,
      contextBudget: budget,
      alwaysAllowedTools: ["skill_complete", "skill_load", "session_compact"],
      getCurrentTurn: () => 12,
      recordEvent: () => undefined as BrewvaEventRecord | undefined,
    });

    const usage = createUsage(0.9);
    const controlDecision = service.checkContextCompactionGate(
      "pressure-session",
      "skill_complete",
      usage,
    );
    expect(controlDecision.allowed).toBe(true);

    const dataPlaneDecision = service.checkContextCompactionGate("pressure-session", "exec", usage);
    expect(dataPlaneDecision.allowed).toBe(false);
  });

  test("runtime wiring blocks diagnostic tools during critical pressure while allowing completion", () => {
    const workspace = createWorkspace("pressure-runtime-wiring");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    config.infrastructure.contextBudget.hardLimitPercent = 0.8;
    config.infrastructure.contextBudget.compactionThresholdPercent = 0.7;
    config.infrastructure.events.enabled = true;
    config.infrastructure.events.dir = ".orchestrator/events";
    config.ledger.path = ".orchestrator/ledger/evidence.jsonl";
    const runtime = new BrewvaRuntime({ cwd: workspace, config });

    const sessionId = "pressure-runtime-wiring-1";
    runtime.context.onTurnStart(sessionId, 1);
    const usage = createUsage(0.9);
    runtime.context.observeUsage(sessionId, usage);

    expect(runtime.context.checkCompactionGate(sessionId, "tape_info", usage).allowed).toBe(false);
    expect(runtime.context.checkCompactionGate(sessionId, "exec", usage).allowed).toBe(false);
    expect(runtime.context.checkCompactionGate(sessionId, "skill_complete", usage).allowed).toBe(
      true,
    );
    expect(runtime.context.checkCompactionGate(sessionId, "session_compact", usage).allowed).toBe(
      true,
    );
  });
});
