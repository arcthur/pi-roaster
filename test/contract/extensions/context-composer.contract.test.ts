import { describe, expect, test } from "bun:test";
import {
  composeContextBlocks,
  type ContextComposerInput,
} from "@brewva/brewva-gateway/runtime-plugins";
import { CONTEXT_SOURCES, type ContextInjectionEntry } from "@brewva/brewva-runtime";

function makeEntry(
  source: string,
  id: string,
  content: string,
  estimatedTokens = 8,
  category: ContextInjectionEntry["category"] = "narrative",
): ContextInjectionEntry {
  return {
    category,
    source,
    id,
    content,
    estimatedTokens,
    timestamp: 1,
    oncePerSession: false,
    truncated: false,
  };
}

function createComposerRuntime(
  tapePressure: "low" | "medium" | "high",
  entriesSinceAnchor: number,
  options: {
    advisoryPayload?: Record<string, unknown>;
    advisoryTimestamp?: number;
    resetTimestamp?: number;
  } = {},
): ContextComposerInput["runtime"] {
  return {
    events: {
      getTapeStatus: () => ({
        tapePressure,
        totalEntries: 32,
        entriesSinceAnchor,
        entriesSinceCheckpoint: 7,
        lastAnchor: tapePressure === "low" ? null : { id: "a-1", name: "handoff" },
      }),
      query: (_sessionId, query) =>
        query.type === "scan_convergence_advisory" && options.advisoryPayload
          ? [
              {
                timestamp: options.advisoryTimestamp ?? 1,
                payload: options.advisoryPayload,
              },
            ]
          : query.type === "scan_convergence_reset" && typeof options.resetTimestamp === "number"
            ? [
                {
                  timestamp: options.resetTimestamp,
                  payload: { reason: "input_reset" },
                },
              ]
            : [],
    },
  } as ContextComposerInput["runtime"];
}

describe("context composer", () => {
  test("orders admitted context as narrative first and constraints second", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("low", 1),
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
        makeEntry(
          CONTEXT_SOURCES.skillCascadeGate,
          "skill-cascade-gate",
          "[SkillCascadeGate]\nstatus: pending",
          8,
          "constraint",
        ),
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
      result.content.indexOf("[SkillCascadeGate]"),
    );
    expect(result.metrics.narrativeRatio).toBeGreaterThan(0.4);
  });

  test("keeps compaction constraints even when governance diagnostics are trimmed by the cap", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("high", 18),
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

    expect(result.content).toContain("[ContextCompactionGate]");
    expect(result.content).not.toContain("[OperationalDiagnostics]");
    expect(result.content).not.toContain("tape_pressure:");
    expect(result.content).not.toContain("tape_entries_since_anchor:");
    expect(result.metrics.diagnosticTokens).toBe(0);
  });

  test("includes tape telemetry only when diagnostics are explicitly requested", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("high", 18),
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

    expect(result.content).toContain("[OperationalDiagnostics]");
    expect(result.content).toContain("requested_by: $obs_query");
    expect(result.content).toContain("tape_pressure: high");
    expect(result.content).toContain("tape_entries_since_anchor: 18");
  });

  test("caps governance-heavy injections before they crowd out narrative blocks", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("medium", 6, {
        advisoryPayload: {
          message:
            "[ExplorationAdvisory]\nRepeated low-signal scanning is piling up. Switch strategy before broadening the scan.",
        },
      }),
      sessionId: "compose-4",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "medium",
          usageRatio: 0.72,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 3,
        windowTurns: 4,
      },
      pendingCompactionReason: "usage_threshold",
      capabilityView: {
        block:
          "[CapabilityView]\nvisible_now: $session_compact, $output_search, $ledger_query, $task_record_blocker, $task_view_state, $obs_query, $tape_search, $skill_load",
        requested: ["obs_query"],
        expanded: ["obs_query"],
        missing: [],
      },
      injectionAccepted: true,
      admittedEntries: [
        makeEntry(CONTEXT_SOURCES.taskState, "task-state", "[TaskState]\nstatus: active", 16),
        makeEntry(
          CONTEXT_SOURCES.projectionWorking,
          "projection",
          "[WorkingProjection]\nstep: patch\nstep: verify\nstep: summarize",
          18,
        ),
      ],
    });

    expect(result.content).not.toContain("[OperationalDiagnostics]");
    expect(result.content).not.toContain("[ExplorationAdvisory]");
    expect(result.content).toContain("[TaskState]");
    expect(result.metrics.narrativeRatio).toBeGreaterThan(0.15);
  });

  test("suppresses stale exploration advisories after a newer reset event", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("medium", 6, {
        advisoryPayload: {
          message:
            "[ExplorationAdvisory]\nRepeated low-signal scanning is piling up. Switch strategy before broadening the scan.",
        },
        advisoryTimestamp: 10,
        resetTimestamp: 11,
      }),
      sessionId: "compose-5",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "low",
          usageRatio: 0.4,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 1,
        windowTurns: 4,
      },
      pendingCompactionReason: null,
      capabilityView: {
        block: "[CapabilityView]\nvisible_now: $obs_query",
        requested: [],
        expanded: [],
        missing: [],
      },
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).not.toContain("[ExplorationAdvisory]");
  });
});
