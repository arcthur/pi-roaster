import type { RoasterEventRecord, TaskState, TruthState } from "../types.js";
import {
  TASK_EVENT_TYPE,
  coerceTaskLedgerPayload,
  createEmptyTaskState,
  reduceTaskState,
} from "../task/ledger.js";
import {
  TRUTH_EVENT_TYPE,
  coerceTruthLedgerPayload,
  createEmptyTruthState,
  reduceTruthState,
} from "../truth/ledger.js";
import {
  TAPE_CHECKPOINT_EVENT_TYPE,
  coerceTapeCheckpointPayload,
} from "./events.js";

export interface TurnReplayView {
  turn: number;
  latestEventId: string | null;
  taskState: TaskState;
  truthState: TruthState;
}

interface TurnReplayEngineOptions {
  listEvents: (sessionId: string) => RoasterEventRecord[];
  getTurn: (sessionId: string) => number;
}

function cloneTaskState(state: TaskState): TaskState {
  const spec = state.spec
    ? {
        ...state.spec,
        targets: state.spec.targets
          ? {
              files: state.spec.targets.files
                ? [...state.spec.targets.files]
                : undefined,
              symbols: state.spec.targets.symbols
                ? [...state.spec.targets.symbols]
                : undefined,
            }
          : undefined,
        constraints: state.spec.constraints
          ? [...state.spec.constraints]
          : undefined,
        verification: state.spec.verification
          ? {
              level: state.spec.verification.level,
              commands: state.spec.verification.commands
                ? [...state.spec.verification.commands]
                : undefined,
            }
          : undefined,
      }
    : undefined;

  return {
    spec,
    status: state.status
      ? {
          ...state.status,
          truthFactIds: state.status.truthFactIds
            ? [...state.status.truthFactIds]
            : undefined,
        }
      : undefined,
    items: state.items.map((item) => ({ ...item })),
    blockers: state.blockers.map((blocker) => ({ ...blocker })),
    updatedAt: state.updatedAt,
  };
}

function cloneTruthState(state: TruthState): TruthState {
  const cloneDetails = (
    details: TruthState["facts"][number]["details"] | undefined,
  ): TruthState["facts"][number]["details"] =>
    details
      ? (JSON.parse(JSON.stringify(details)) as TruthState["facts"][number]["details"])
      : undefined;

  return {
    facts: state.facts.map((fact) => ({
      ...fact,
      evidenceIds: [...fact.evidenceIds],
      details: cloneDetails(fact.details),
    })),
    updatedAt: state.updatedAt,
  };
}

export class TurnReplayEngine {
  private readonly listEvents: (sessionId: string) => RoasterEventRecord[];
  private readonly getTurn: (sessionId: string) => number;
  private readonly viewBySession = new Map<string, TurnReplayView>();

  constructor(options: TurnReplayEngineOptions) {
    this.listEvents = options.listEvents;
    this.getTurn = options.getTurn;
  }

  replay(sessionId: string): TurnReplayView {
    const turn = this.getTurn(sessionId);
    const cached = this.viewBySession.get(sessionId);
    if (cached) {
      if (cached.turn === turn) {
        return cached;
      }
      const withTurn = { ...cached, turn };
      this.viewBySession.set(sessionId, withTurn);
      return withTurn;
    }

    const view = this.buildView(sessionId);
    this.viewBySession.set(sessionId, view);
    return view;
  }

  getTaskState(sessionId: string): TaskState {
    return cloneTaskState(this.replay(sessionId).taskState);
  }

  getTruthState(sessionId: string): TruthState {
    return cloneTruthState(this.replay(sessionId).truthState);
  }

  invalidate(sessionId: string): void {
    this.viewBySession.delete(sessionId);
  }

  clear(sessionId: string): void {
    this.invalidate(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.viewBySession.has(sessionId);
  }

  private buildView(sessionId: string): TurnReplayView {
    const events = this.listEvents(sessionId);
    let checkpointIndex = -1;
    let checkpointTaskState: TaskState | null = null;
    let checkpointTruthState: TruthState | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== TAPE_CHECKPOINT_EVENT_TYPE) continue;
      const payload = coerceTapeCheckpointPayload(event.payload);
      if (!payload) continue;
      checkpointIndex = index;
      checkpointTaskState = cloneTaskState(payload.state.task);
      checkpointTruthState = cloneTruthState(payload.state.truth);
      break;
    }

    let taskState =
      checkpointTaskState ??
      createEmptyTaskState();
    let truthState = checkpointTruthState ?? createEmptyTruthState();

    const replayStartIndex = checkpointIndex >= 0 ? checkpointIndex + 1 : 0;
    for (let index = replayStartIndex; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
      if (event.type === TASK_EVENT_TYPE) {
        const payload = coerceTaskLedgerPayload(event.payload);
        if (!payload) continue;
        taskState = reduceTaskState(taskState, payload, event.timestamp);
        continue;
      }
      if (event.type === TRUTH_EVENT_TYPE) {
        const payload = coerceTruthLedgerPayload(event.payload);
        if (!payload) continue;
        truthState = reduceTruthState(truthState, payload, event.timestamp);
      }
    }

    return {
      turn: this.getTurn(sessionId),
      latestEventId: events[events.length - 1]?.id ?? null,
      taskState,
      truthState,
    };
  }
}
