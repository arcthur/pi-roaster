import type { TaskState, TruthState } from "../types.js";
import { isRecord, normalizeNonEmptyString } from "../utils/coerce.js";

export const TAPE_ANCHOR_EVENT_TYPE = "anchor";
export const TAPE_CHECKPOINT_EVENT_TYPE = "checkpoint";

export const TAPE_ANCHOR_SCHEMA = "roaster.tape.anchor.v1" as const;
export const TAPE_CHECKPOINT_SCHEMA = "roaster.tape.checkpoint.v1" as const;

export interface TapeAnchorPayload {
  schema: typeof TAPE_ANCHOR_SCHEMA;
  name: string;
  summary?: string;
  nextSteps?: string;
  createdAt: number;
}

export interface TapeCheckpointPayload {
  schema: typeof TAPE_CHECKPOINT_SCHEMA;
  state: {
    task: TaskState;
    truth: TruthState;
  };
  basedOnEventId?: string;
  latestAnchorEventId?: string;
  reason: string;
  createdAt: number;
}

export function buildTapeAnchorPayload(input: {
  name: string;
  summary?: string;
  nextSteps?: string;
  createdAt?: number;
}): TapeAnchorPayload {
  return {
    schema: TAPE_ANCHOR_SCHEMA,
    name: input.name,
    summary: input.summary,
    nextSteps: input.nextSteps,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function buildTapeCheckpointPayload(input: {
  taskState: TaskState;
  truthState: TruthState;
  basedOnEventId?: string;
  latestAnchorEventId?: string;
  reason: string;
  createdAt?: number;
}): TapeCheckpointPayload {
  return {
    schema: TAPE_CHECKPOINT_SCHEMA,
    state: {
      task: input.taskState,
      truth: input.truthState,
    },
    basedOnEventId: input.basedOnEventId,
    latestAnchorEventId: input.latestAnchorEventId,
    reason: input.reason,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function coerceTapeAnchorPayload(value: unknown): TapeAnchorPayload | null {
  if (!isRecord(value)) return null;
  if (value.schema !== TAPE_ANCHOR_SCHEMA) return null;
  const name = normalizeNonEmptyString(value.name);
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : null;
  if (!name || createdAt === null) return null;
  const summary = normalizeNonEmptyString(value.summary);
  const nextSteps = normalizeNonEmptyString(value.nextSteps);
  return {
    schema: TAPE_ANCHOR_SCHEMA,
    name,
    summary,
    nextSteps,
    createdAt,
  };
}

export function coerceTapeCheckpointPayload(
  value: unknown,
): TapeCheckpointPayload | null {
  if (!isRecord(value)) return null;
  if (value.schema !== TAPE_CHECKPOINT_SCHEMA) return null;
  if (!isRecord(value.state)) return null;
  const task = value.state.task;
  const truth = value.state.truth;
  if (!isRecord(task) || !isRecord(truth)) return null;

  const reason = normalizeNonEmptyString(value.reason);
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : null;
  if (!reason || createdAt === null) return null;

  const basedOnEventId = normalizeNonEmptyString(value.basedOnEventId);
  const latestAnchorEventId = normalizeNonEmptyString(value.latestAnchorEventId);

  return {
    schema: TAPE_CHECKPOINT_SCHEMA,
    state: {
      task: task as unknown as TaskState,
      truth: truth as unknown as TruthState,
    },
    basedOnEventId,
    latestAnchorEventId,
    reason,
    createdAt,
  };
}
