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
import type {
  BrewvaEventRecord,
  TaskState,
} from "@brewva/brewva-runtime";

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
      reason: "unit_test",
      basedOnEventId: "evt-prev",
    }) as unknown as BrewvaEventRecord["payload"],
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
    expect(view.taskState.items.some((item) => item.text === "stale-item")).toBe(
      false,
    );
    expect(view.truthState.facts.map((fact) => fact.id)).toEqual([
      "fact-checkpoint",
      "fact-new",
    ]);
  });
});
