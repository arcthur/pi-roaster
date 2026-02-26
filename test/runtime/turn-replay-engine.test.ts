import { describe, expect, test } from "bun:test";
import {
  TASK_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  TRUTH_EVENT_TYPE,
  TurnReplayEngine,
  buildItemAddedEvent,
  buildTapeCheckpointPayload,
  buildTruthFactUpsertedEvent,
} from "@brewva/brewva-runtime";
import type { BrewvaEventRecord, TaskState } from "@brewva/brewva-runtime";

function taskEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
  text: string;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: TASK_EVENT_TYPE,
    timestamp: input.timestamp,
    payload: buildItemAddedEvent({
      text: input.text,
      status: "todo",
    }) as BrewvaEventRecord["payload"],
  };
}

function truthEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
  factId: string;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: TRUTH_EVENT_TYPE,
    timestamp: input.timestamp,
    payload: buildTruthFactUpsertedEvent({
      id: input.factId,
      kind: "test_fact",
      status: "active",
      severity: "warn",
      summary: "fact-summary",
      evidenceIds: ["led-1"],
      firstSeenAt: input.timestamp,
      lastSeenAt: input.timestamp,
    }) as unknown as BrewvaEventRecord["payload"],
  };
}

function checkpointEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
  taskState: TaskState;
  truthState: {
    facts: Array<{
      id: string;
      kind: string;
      status: "active" | "resolved";
      severity: "info" | "warn" | "error";
      summary: string;
      evidenceIds: string[];
      firstSeenAt: number;
      lastSeenAt: number;
      resolvedAt?: number;
    }>;
    updatedAt: number | null;
  };
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: TAPE_CHECKPOINT_EVENT_TYPE,
    timestamp: input.timestamp,
    payload: buildTapeCheckpointPayload({
      taskState: input.taskState,
      truthState: input.truthState,
      costSummary: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        models: {},
        skills: {},
        tools: {},
        alerts: [],
        budget: {
          action: "warn",
          sessionExceeded: false,
          skillExceeded: false,
          blocked: false,
        },
      },
      evidenceState: {
        totalRecords: 0,
        failureRecords: 0,
        anchorEpoch: 0,
        recentFailures: [],
      },
      memoryState: {
        updatedAt: null,
        crystals: [],
      },
      reason: "unit_test",
      basedOnEventId: "evt-prev",
    }) as unknown as BrewvaEventRecord["payload"],
  };
}

function toolResultFailureEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
  turn?: number;
  toolName: string;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: "tool_result_recorded",
    timestamp: input.timestamp,
    turn: input.turn,
    payload: {
      toolName: input.toolName,
      verdict: "fail",
      success: false,
      failureContext: {
        args: {
          command: "bun test",
        },
        outputText: "Error: failed",
        turn: input.turn ?? 0,
      },
    } as BrewvaEventRecord["payload"],
  };
}

function anchorEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: "anchor",
    timestamp: input.timestamp,
    payload: {
      schema: "brewva.tape.anchor.v1",
      name: "phase",
      createdAt: input.timestamp,
    } as BrewvaEventRecord["payload"],
  };
}

describe("TurnReplayEngine", () => {
  test("replay is deterministic and state getters return defensive copies", () => {
    const sessionId = "replay-engine-deterministic";
    let turn = 3;
    const events: BrewvaEventRecord[] = [
      taskEvent({
        sessionId,
        id: "evt-task-1",
        timestamp: 1,
        text: "item-1",
      }),
      truthEvent({
        sessionId,
        id: "evt-truth-1",
        timestamp: 2,
        factId: "fact-1",
      }),
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => turn,
    });

    const first = engine.replay(sessionId);
    const second = engine.replay(sessionId);
    expect(second).toBe(first);

    const taskStateA = engine.getTaskState(sessionId);
    taskStateA.items[0]!.text = "mutated";
    const taskStateB = engine.getTaskState(sessionId);
    expect(taskStateB.items[0]?.text).toBe("item-1");

    const truthStateA = engine.getTruthState(sessionId);
    truthStateA.facts[0]!.evidenceIds.push("led-2");
    const truthStateB = engine.getTruthState(sessionId);
    expect(truthStateB.facts[0]?.evidenceIds).toEqual(["led-1"]);
  });

  test("new events are observed only after invalidate within the same turn", () => {
    const sessionId = "replay-engine-invalidate";
    const events: BrewvaEventRecord[] = [
      taskEvent({
        sessionId,
        id: "evt-task-1",
        timestamp: 1,
        text: "item-1",
      }),
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const first = engine.replay(sessionId);
    expect(first.taskState.items).toHaveLength(1);

    events.push(
      taskEvent({
        sessionId,
        id: "evt-task-2",
        timestamp: 2,
        text: "item-2",
      }),
    );

    const stale = engine.replay(sessionId);
    expect(stale.taskState.items).toHaveLength(1);

    engine.invalidate(sessionId);
    const refreshed = engine.replay(sessionId);
    expect(refreshed.taskState.items).toHaveLength(2);
  });

  test("advancing turn keeps cached state and updates replay view turn", () => {
    const sessionId = "replay-engine-turn";
    let turn = 1;
    const events: BrewvaEventRecord[] = [
      taskEvent({
        sessionId,
        id: "evt-task-1",
        timestamp: 1,
        text: "item-1",
      }),
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => turn,
    });

    const first = engine.replay(sessionId);
    expect(first.turn).toBe(1);

    turn = 2;
    const second = engine.replay(sessionId);
    expect(second.turn).toBe(2);
    expect(second.taskState).toBe(first.taskState);
    expect(second.truthState).toBe(first.truthState);
  });

  test("without checkpoint replays task events from tape start", () => {
    const sessionId = "replay-engine-no-checkpoint";
    const events: BrewvaEventRecord[] = [
      taskEvent({
        sessionId,
        id: "evt-task-1",
        timestamp: 2,
        text: "from-task-event",
      }),
      truthEvent({
        sessionId,
        id: "evt-truth-1",
        timestamp: 3,
        factId: "fact-1",
      }),
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const view = engine.replay(sessionId);
    expect(view.taskState.items).toHaveLength(1);
    expect(view.taskState.items[0]?.text).toBe("from-task-event");
    expect(view.truthState.facts).toHaveLength(1);
  });

  test("replays from latest tape checkpoint and ignores earlier events", () => {
    const sessionId = "replay-engine-checkpoint";
    const events: BrewvaEventRecord[] = [
      taskEvent({
        sessionId,
        id: "evt-task-old",
        timestamp: 1,
        text: "stale-item",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-checkpoint-1",
        timestamp: 2,
        taskState: {
          items: [
            {
              id: "item-checkpoint",
              text: "checkpoint-item",
              status: "todo",
              createdAt: 2,
              updatedAt: 2,
            },
          ],
          blockers: [],
          updatedAt: 2,
        },
        truthState: {
          facts: [
            {
              id: "fact-checkpoint",
              kind: "checkpoint_fact",
              status: "active",
              severity: "warn",
              summary: "checkpoint-fact",
              evidenceIds: ["led-cp"],
              firstSeenAt: 2,
              lastSeenAt: 2,
            },
          ],
          updatedAt: 2,
        },
      }),
      taskEvent({
        sessionId,
        id: "evt-task-new",
        timestamp: 3,
        text: "fresh-item",
      }),
      truthEvent({
        sessionId,
        id: "evt-truth-new",
        timestamp: 4,
        factId: "fact-new",
      }),
    ];

    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const view = engine.replay(sessionId);
    expect(view.taskState.items.map((item) => item.text)).toEqual([
      "checkpoint-item",
      "fresh-item",
    ]);
    expect(view.taskState.items.some((item) => item.text === "stale-item")).toBe(false);
    expect(view.truthState.facts.map((fact) => fact.id)).toEqual(["fact-checkpoint", "fact-new"]);
  });

  test("observeEvent incrementally updates cached view without invalidation", () => {
    const sessionId = "replay-engine-observe";
    const events: BrewvaEventRecord[] = [
      taskEvent({
        sessionId,
        id: "evt-task-1",
        timestamp: 1,
        text: "item-1",
      }),
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const first = engine.replay(sessionId);
    expect(first.taskState.items).toHaveLength(1);

    const next = taskEvent({
      sessionId,
      id: "evt-task-2",
      timestamp: 2,
      text: "item-2",
    });
    events.push(next);
    engine.observeEvent(next);

    const second = engine.replay(sessionId);
    expect(second).not.toBe(first);
    expect(second.taskState.items).toHaveLength(2);
    expect(second.taskState.items[1]?.text).toBe("item-2");
  });

  test("observeEvent applies checkpoint payload and resets folded slices", () => {
    const sessionId = "replay-engine-observe-checkpoint";
    const events: BrewvaEventRecord[] = [
      taskEvent({
        sessionId,
        id: "evt-task-before",
        timestamp: 1,
        text: "before",
      }),
      {
        id: "evt-cost-before",
        sessionId,
        type: "cost_update",
        timestamp: 2,
        turn: 1,
        payload: {
          model: "test/model",
          skill: "exploration",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15,
          costUsd: 0.001,
          budget: {
            action: "warn",
            sessionExceeded: false,
            skillExceeded: false,
            blocked: false,
          },
        } as BrewvaEventRecord["payload"],
      },
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const first = engine.replay(sessionId);
    expect(first.taskState.items.map((item) => item.text)).toEqual(["before"]);
    expect(first.costState.summary.totalTokens).toBe(15);

    const checkpoint = checkpointEvent({
      sessionId,
      id: "evt-checkpoint-new",
      timestamp: 3,
      taskState: {
        items: [
          {
            id: "item-after",
            text: "after",
            status: "todo",
            createdAt: 3,
            updatedAt: 3,
          },
        ],
        blockers: [],
        updatedAt: 3,
      },
      truthState: {
        facts: [],
        updatedAt: 3,
      },
    });
    const checkpointPayload = checkpoint.payload as {
      state?: {
        cost?: {
          totalTokens?: number;
        };
        evidence?: {
          totalRecords?: number;
        };
        memory?: {
          crystals?: Array<{
            id: string;
            topic: string;
            unitCount: number;
            confidence: number;
            updatedAt: number;
          }>;
        };
      };
    };
    if (
      !checkpointPayload.state?.cost ||
      !checkpointPayload.state.evidence ||
      !checkpointPayload.state.memory
    ) {
      throw new Error("expected checkpoint payload state");
    }
    checkpointPayload.state.cost.totalTokens = 7;
    checkpointPayload.state.evidence.totalRecords = 2;
    checkpointPayload.state.memory.crystals = [
      {
        id: "crystal-from-checkpoint",
        topic: "checkpoint-topic",
        unitCount: 1,
        confidence: 0.7,
        updatedAt: 3,
      },
    ];

    events.push(checkpoint);
    engine.observeEvent(checkpoint);

    const second = engine.replay(sessionId);
    expect(second.latestEventId).toBe("evt-checkpoint-new");
    expect(second.checkpointEventId).toBe("evt-checkpoint-new");
    expect(second.taskState.items.map((item) => item.text)).toEqual(["after"]);
    expect(second.costState.summary.totalTokens).toBe(7);
    expect(second.evidenceState.totalRecords).toBe(2);
    expect(second.memoryState.crystals[0]?.id).toBe("crystal-from-checkpoint");
  });

  test("folds cost/evidence/memory state and prunes stale failures after 3 anchors", () => {
    const sessionId = "replay-engine-folded-extended";
    const events: BrewvaEventRecord[] = [
      {
        id: "evt-cost-1",
        sessionId,
        type: "cost_update",
        timestamp: 1,
        turn: 1,
        payload: {
          model: "test/model",
          skill: "exploration",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15,
          costUsd: 0.001,
          budget: {
            action: "warn",
            sessionExceeded: false,
            skillExceeded: false,
            blocked: false,
          },
        } as BrewvaEventRecord["payload"],
      },
      toolResultFailureEvent({
        sessionId,
        id: "evt-tool-fail-1",
        timestamp: 2,
        turn: 1,
        toolName: "exec",
      }),
      {
        id: "evt-memory-crystal-1",
        sessionId,
        type: "memory_crystal_compiled",
        timestamp: 3,
        payload: {
          crystal: {
            id: "crystal-1",
            topic: "build",
            summary: "build summary",
            unitIds: ["u1", "u2"],
            confidence: 0.8,
            updatedAt: 3,
          },
        } as BrewvaEventRecord["payload"],
      },
      anchorEvent({
        sessionId,
        id: "evt-anchor-1",
        timestamp: 4,
      }),
      anchorEvent({
        sessionId,
        id: "evt-anchor-2",
        timestamp: 5,
      }),
      anchorEvent({
        sessionId,
        id: "evt-anchor-3",
        timestamp: 6,
      }),
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const view = engine.replay(sessionId);
    expect(view.costState.summary.totalTokens).toBe(15);
    expect(view.costState.summary.totalCostUsd).toBeCloseTo(0.001, 8);
    expect(view.memoryState.crystals).toHaveLength(1);
    expect(view.memoryState.crystals[0]?.id).toBe("crystal-1");
    expect(view.evidenceState.failureRecords).toBe(1);
    expect(view.evidenceState.recentFailures).toHaveLength(0);
  });

  test("folded cost turns count is deduplicated by turn", () => {
    const sessionId = "replay-engine-cost-turns";
    const events: BrewvaEventRecord[] = [
      {
        id: "evt-cost-same-turn-1",
        sessionId,
        type: "cost_update",
        timestamp: 1,
        turn: 2,
        payload: {
          model: "test/model",
          skill: "analysis",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15,
          costUsd: 0.001,
          budget: {
            action: "warn",
            sessionExceeded: false,
            skillExceeded: false,
            blocked: false,
          },
        } as BrewvaEventRecord["payload"],
      },
      {
        id: "evt-cost-same-turn-2",
        sessionId,
        type: "cost_update",
        timestamp: 2,
        turn: 2,
        payload: {
          model: "test/model",
          skill: "analysis",
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 30,
          costUsd: 0.002,
          budget: {
            action: "warn",
            sessionExceeded: false,
            skillExceeded: false,
            blocked: false,
          },
        } as BrewvaEventRecord["payload"],
      },
      {
        id: "evt-cost-next-turn",
        sessionId,
        type: "cost_update",
        timestamp: 3,
        turn: 3,
        payload: {
          model: "test/model",
          skill: "analysis",
          inputTokens: 5,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 10,
          costUsd: 0.0005,
          budget: {
            action: "warn",
            sessionExceeded: false,
            skillExceeded: false,
            blocked: false,
          },
        } as BrewvaEventRecord["payload"],
      },
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 3,
    });

    const view = engine.replay(sessionId);
    expect(view.costState.summary.skills.analysis?.usageCount).toBe(3);
    expect(view.costState.summary.skills.analysis?.turns).toBe(2);
  });

  test("checkpoint skill turn map prevents same-turn double count after checkpoint", () => {
    const sessionId = "replay-engine-checkpoint-cost-turn-map";
    const events: BrewvaEventRecord[] = [
      {
        id: "evt-checkpoint-cost",
        sessionId,
        type: TAPE_CHECKPOINT_EVENT_TYPE,
        timestamp: 1,
        turn: 1,
        payload: buildTapeCheckpointPayload({
          taskState: {
            items: [],
            blockers: [],
            updatedAt: 1,
          },
          truthState: {
            facts: [],
            updatedAt: 1,
          },
          costSummary: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            totalCostUsd: 0.001,
            models: {
              "test/model": {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 15,
                totalCostUsd: 0.001,
              },
            },
            skills: {
              analysis: {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 15,
                totalCostUsd: 0.001,
                usageCount: 1,
                turns: 1,
              },
            },
            tools: {},
            alerts: [],
            budget: {
              action: "warn",
              sessionExceeded: false,
              skillExceeded: false,
              blocked: false,
            },
          },
          costSkillLastTurnByName: {
            analysis: 1,
          },
          evidenceState: {
            totalRecords: 0,
            failureRecords: 0,
            anchorEpoch: 0,
            recentFailures: [],
          },
          memoryState: {
            updatedAt: null,
            crystals: [],
          },
          reason: "unit_test",
        }) as unknown as BrewvaEventRecord["payload"],
      },
      {
        id: "evt-cost-tail-same-turn",
        sessionId,
        type: "cost_update",
        timestamp: 2,
        turn: 1,
        payload: {
          model: "test/model",
          skill: "analysis",
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 30,
          costUsd: 0.002,
          budget: {
            action: "warn",
            sessionExceeded: false,
            skillExceeded: false,
            blocked: false,
          },
        } as BrewvaEventRecord["payload"],
      },
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const view = engine.replay(sessionId);
    expect(view.costState.summary.skills.analysis?.usageCount).toBe(2);
    expect(view.costState.summary.skills.analysis?.turns).toBe(1);
  });

  test("uses event timestamp for budget alert replay", () => {
    const sessionId = "replay-engine-budget-alert";
    const events: BrewvaEventRecord[] = [
      {
        id: "evt-budget-1",
        sessionId,
        type: "budget_alert",
        timestamp: 42,
        turn: 1,
        payload: {
          kind: "session_threshold",
          scope: "session",
          costUsd: 0.9,
          thresholdUsd: 0.8,
          action: "block_tools",
        } as BrewvaEventRecord["payload"],
      },
      {
        id: "evt-budget-2",
        sessionId,
        type: "budget_alert",
        timestamp: 43,
        turn: 1,
        payload: {
          kind: "session_cap",
          scope: "session",
          costUsd: 1.1,
          thresholdUsd: 1,
          action: "block_tools",
        } as BrewvaEventRecord["payload"],
      },
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const first = engine.replay(sessionId);
    expect(first.costState.summary.alerts[0]?.timestamp).toBe(42);
    expect(first.costState.summary.budget.action).toBe("block_tools");
    expect(first.costState.summary.budget.sessionExceeded).toBe(true);
    expect(first.costState.summary.budget.blocked).toBe(true);

    engine.invalidate(sessionId);
    const second = engine.replay(sessionId);
    expect(second.costState.summary.alerts[0]?.timestamp).toBe(42);
  });
});
