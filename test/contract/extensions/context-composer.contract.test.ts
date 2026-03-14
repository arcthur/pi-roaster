import { describe, expect, test } from "bun:test";
import {
  buildCapabilityView,
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
      capabilityView: buildCapabilityView({
        prompt: "continue",
        allTools: [
          {
            name: "skill_load",
            description: "Load a skill.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: ["skill_load"],
      }),
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
    expect(result.metrics.narrativeRatio).toBeGreaterThan(0.25);
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
      capabilityView: buildCapabilityView({
        prompt: "continue",
        allTools: [
          {
            name: "session_compact",
            description: "Compact session context.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: ["session_compact"],
      }),
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
      capabilityView: buildCapabilityView({
        prompt: "inspect $obs_query",
        allTools: [
          {
            name: "obs_query",
            description: "Query runtime events.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: ["obs_query"],
      }),
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).toContain("[OperationalDiagnostics]");
    expect(result.content).toContain("requested_by: $obs_query");
    expect(result.content).toContain("tape_pressure: high");
    expect(result.content).toContain("tape_entries_since_anchor: 18");
    expect(result.content).not.toContain("[CapabilityDetail:$obs_query]");
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
      capabilityView: buildCapabilityView({
        prompt: "inspect $obs_query",
        allTools: [
          {
            name: "session_compact",
            description: "Compact session context.",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "output_search",
            description: "Search persisted tool output.",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
          {
            name: "ledger_query",
            description: "Query session ledger.",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
          {
            name: "task_record_blocker",
            description: "Record a task blocker.",
            parameters: { type: "object", properties: { blocker: { type: "string" } } },
          },
          {
            name: "task_view_state",
            description: "View task state.",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "obs_query",
            description: "Query runtime events.",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "tape_search",
            description: "Search tape entries.",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
          {
            name: "skill_load",
            description: "Load a skill.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: [
          "session_compact",
          "output_search",
          "ledger_query",
          "task_record_blocker",
          "task_view_state",
          "obs_query",
          "tape_search",
          "skill_load",
        ],
      }),
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

    expect(result.content).toContain("[OperationalDiagnostics]");
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
      capabilityView: buildCapabilityView({
        prompt: "continue",
        allTools: [
          {
            name: "obs_query",
            description: "Query runtime events.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: ["obs_query"],
      }),
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).not.toContain("[ExplorationAdvisory]");
  });

  test("uses narrative ratio to compact capability sections before dropping explicit tool details", () => {
    const capabilityView = buildCapabilityView({
      prompt: "inspect $task_set_spec",
      allTools: [
        {
          name: "session_compact",
          description: "Compact session context.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "task_set_spec",
          description: "Set the task specification.",
          parameters: { type: "object", properties: { goal: { type: "string" } } },
        },
        {
          name: "tape_search",
          description: "Search tape entries.",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
        {
          name: "obs_query",
          description: "Query runtime events.",
          parameters: { type: "object", properties: {} },
        },
      ],
      activeToolNames: ["session_compact"],
    });

    const result = composeContextBlocks({
      runtime: createComposerRuntime("low", 1),
      sessionId: "compose-6",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "low",
          usageRatio: 0.18,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 1,
        windowTurns: 4,
      },
      pendingCompactionReason: null,
      capabilityView,
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).toContain("[CapabilityView]");
    expect(result.content).toContain("[CapabilityDetail:$task_set_spec]");
    expect(result.content).toContain("posture: reversible_mutate");
    expect(result.content).toContain("effects: memory_write");
    expect(result.content).not.toContain("description:");
    expect(result.content).not.toContain("surface_policy:");
    expect(result.content).not.toContain("posture_policy:");
    expect(result.content).not.toContain("hidden_skill_count:");
    expect(result.content).not.toContain("operator_hint:");
  });
});
