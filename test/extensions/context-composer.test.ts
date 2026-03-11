import { describe, expect, test } from "bun:test";
import { composeContextBlocks } from "@brewva/brewva-gateway/runtime-plugins";
import { CONTEXT_SOURCES, type ContextInjectionEntry } from "@brewva/brewva-runtime";

function makeEntry(
  source: string,
  id: string,
  content: string,
  estimatedTokens = 8,
): ContextInjectionEntry {
  return {
    source,
    id,
    content,
    estimatedTokens,
    timestamp: 1,
    oncePerSession: false,
    truncated: false,
  };
}

describe("context composer", () => {
  test("orders admitted context as narrative first and constraints second", () => {
    const result = composeContextBlocks({
      runtime: {
        events: {
          getTapeStatus: () => ({
            tapePressure: "low",
            totalEntries: 4,
            entriesSinceAnchor: 1,
            entriesSinceCheckpoint: 1,
            lastAnchor: null,
          }),
        },
      } as any,
      sessionId: "compose-1",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "low",
          usageRatio: 0.2,
          hardLimitRatio: 0.95,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: null,
        windowTurns: 4,
      },
      pendingCompactionReason: null,
      capabilityView: {
        block: "[CapabilityView]\nvisible_now: $skill_load",
        requested: [],
        expanded: [],
        missing: [],
      },
      injectionAccepted: true,
      admittedEntries: [
        makeEntry(CONTEXT_SOURCES.truthStatic, "truth-static", "[TruthLedger]\nrule: stable"),
        makeEntry(CONTEXT_SOURCES.taskState, "task-state", "[TaskState]\nstatus: active"),
        makeEntry(
          CONTEXT_SOURCES.projectionWorking,
          "projection",
          "[WorkingProjection]\nstep: patch",
        ),
      ],
    });

    expect(result.blocks.map((block) => block.category)).toEqual([
      "narrative",
      "narrative",
      "constraint",
      "constraint",
    ]);
    expect(result.content.indexOf("[TaskState]")).toBeLessThan(
      result.content.indexOf("[TruthLedger]"),
    );
    expect(result.metrics.narrativeRatio).toBeGreaterThan(0.4);
  });

  test("adds compact operational diagnostics only on anomaly or explicit diagnostic request", () => {
    const result = composeContextBlocks({
      runtime: {
        events: {
          getTapeStatus: () => ({
            tapePressure: "high",
            totalEntries: 32,
            entriesSinceAnchor: 18,
            entriesSinceCheckpoint: 7,
            lastAnchor: { id: "a-1", name: "handoff" },
          }),
        },
      } as any,
      sessionId: "compose-2",
      gateStatus: {
        required: true,
        reason: "hard_limit",
        pressure: {
          level: "critical",
          usageRatio: 0.97,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 9,
        windowTurns: 4,
      },
      pendingCompactionReason: "usage_threshold",
      capabilityView: {
        block: "[CapabilityView]\nvisible_now: $session_compact",
        requested: [],
        expanded: [],
        missing: [],
      },
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content.includes("[OperationalDiagnostics]")).toBe(true);
    expect(result.content.includes("[ContextCompactionGate]")).toBe(true);
    expect(result.content.includes("tape_pressure:")).toBe(false);
    expect(result.content.includes("tape_entries_since_anchor:")).toBe(false);
    expect(result.metrics.diagnosticTokens).toBeGreaterThan(0);
  });

  test("includes tape telemetry only when diagnostics are explicitly requested", () => {
    const result = composeContextBlocks({
      runtime: {
        events: {
          getTapeStatus: () => ({
            tapePressure: "high",
            totalEntries: 32,
            entriesSinceAnchor: 18,
            entriesSinceCheckpoint: 7,
            lastAnchor: { id: "a-1", name: "handoff" },
          }),
        },
      } as any,
      sessionId: "compose-3",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "medium",
          usageRatio: 0.62,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 2,
        windowTurns: 4,
      },
      pendingCompactionReason: null,
      capabilityView: {
        block: "[CapabilityView]\nvisible_now: $obs_query",
        requested: ["obs_query"],
        expanded: ["obs_query"],
        missing: [],
      },
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content.includes("[OperationalDiagnostics]")).toBe(true);
    expect(result.content.includes("requested_by: $obs_query")).toBe(true);
    expect(result.content.includes("tape_pressure: high")).toBe(true);
    expect(result.content.includes("tape_entries_since_anchor: 18")).toBe(true);
  });
});
