import type { RoasterEventRecord, TaskBlocker, TaskItem, TaskItemStatus, TaskLedgerEventPayload, TaskSpec, TaskState } from "../types.js";

export const TASK_EVENT_TYPE = "task_event";
export const TASK_LEDGER_SCHEMA = "roaster.task.ledger.v1" as const;

type SpecSetEvent = Extract<TaskLedgerEventPayload, { kind: "spec_set" }>;
type CheckpointSetEvent = Extract<TaskLedgerEventPayload, { kind: "checkpoint_set" }>;
type ItemAddedEvent = Extract<TaskLedgerEventPayload, { kind: "item_added" }>;
type ItemUpdatedEvent = Extract<TaskLedgerEventPayload, { kind: "item_updated" }>;
type BlockerRecordedEvent = Extract<TaskLedgerEventPayload, { kind: "blocker_recorded" }>;
type BlockerResolvedEvent = Extract<TaskLedgerEventPayload, { kind: "blocker_resolved" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStatus(value: unknown): TaskItemStatus | undefined {
  if (value === "todo" || value === "doing" || value === "done" || value === "blocked") {
    return value;
  }
  return undefined;
}

export function createEmptyTaskState(): TaskState {
  return {
    items: [],
    blockers: [],
    updatedAt: null,
  };
}

export function isTaskLedgerPayload(value: unknown): value is TaskLedgerEventPayload {
  if (!isRecord(value)) return false;
  if (value.schema !== TASK_LEDGER_SCHEMA) return false;
  if (typeof value.kind !== "string") return false;
  return true;
}

export function reduceTaskState(state: TaskState, payload: TaskLedgerEventPayload, timestamp: number): TaskState {
  const updatedAt = Math.max(state.updatedAt ?? 0, timestamp);

  if (payload.kind === "spec_set") {
    return {
      ...state,
      spec: payload.spec,
      updatedAt,
    };
  }

  if (payload.kind === "checkpoint_set") {
    const nextUpdatedAt = Math.max(payload.state.updatedAt ?? 0, timestamp);
    return {
      spec: payload.state.spec,
      items: [...(payload.state.items ?? [])],
      blockers: [...(payload.state.blockers ?? [])],
      updatedAt: nextUpdatedAt,
    };
  }

  if (payload.kind === "item_added") {
    const id = payload.item.id;
    if (state.items.some((item) => item.id === id)) {
      return {
        ...state,
        updatedAt,
      };
    }
    const status = payload.item.status ?? "todo";
    const item: TaskItem = {
      id,
      text: payload.item.text,
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return {
      ...state,
      items: [...state.items, item],
      updatedAt,
    };
  }

  if (payload.kind === "item_updated") {
    const id = payload.item.id;
    const nextItems = state.items.map((item) => {
      if (item.id !== id) return item;
      return {
        ...item,
        text: payload.item.text ?? item.text,
        status: payload.item.status ?? item.status,
        updatedAt: timestamp,
      };
    });
    return {
      ...state,
      items: nextItems,
      updatedAt,
    };
  }

  if (payload.kind === "blocker_recorded") {
    const id = payload.blocker.id;
    const existing = state.blockers.find((blocker) => blocker.id === id);
    if (existing) {
      const nextMessage = payload.blocker.message;
      const nextSource = payload.blocker.source ?? existing.source;
      const changed = existing.message !== nextMessage || existing.source !== nextSource;
      return {
        ...state,
        blockers: changed
          ? state.blockers.map((blocker) =>
              blocker.id === id
                ? {
                    ...blocker,
                    message: nextMessage,
                    source: nextSource,
                  }
                : blocker,
            )
          : state.blockers,
        updatedAt,
      };
    }

    const blocker: TaskBlocker = { id, message: payload.blocker.message, createdAt: timestamp, source: payload.blocker.source };
    return {
      ...state,
      blockers: [...state.blockers, blocker],
      updatedAt,
    };
  }

  if (payload.kind === "blocker_resolved") {
    const blockers = state.blockers.filter((blocker) => blocker.id !== payload.blockerId);
    return {
      ...state,
      blockers,
      updatedAt,
    };
  }

  return {
    ...state,
    updatedAt,
  };
}

export function foldTaskLedgerEvents(events: RoasterEventRecord[]): TaskState {
  let state = createEmptyTaskState();
  for (const event of events) {
    const payload = coerceTaskLedgerPayload(event.payload);
    if (!payload) continue;
    state = reduceTaskState(state, payload, event.timestamp);
  }
  return state;
}

function buildId(prefix: string, now = Date.now()): string {
  return `${prefix}_${now}_${Math.random().toString(36).slice(2, 10)}`;
}

export function buildSpecSetEvent(spec: TaskSpec): SpecSetEvent {
  return {
    schema: TASK_LEDGER_SCHEMA,
    kind: "spec_set",
    spec,
  };
}

export function buildCheckpointSetEvent(state: TaskState): CheckpointSetEvent {
  return {
    schema: TASK_LEDGER_SCHEMA,
    kind: "checkpoint_set",
    state,
  };
}

export function buildItemAddedEvent(input: { id?: string; text: string; status?: TaskItemStatus }): ItemAddedEvent {
  return {
    schema: TASK_LEDGER_SCHEMA,
    kind: "item_added",
    item: {
      id: input.id ?? buildId("task"),
      text: input.text,
      status: input.status,
    },
  };
}

export function buildItemUpdatedEvent(input: { id: string; text?: string; status?: TaskItemStatus }): ItemUpdatedEvent {
  return {
    schema: TASK_LEDGER_SCHEMA,
    kind: "item_updated",
    item: {
      id: input.id,
      text: input.text,
      status: input.status,
    },
  };
}

export function buildBlockerRecordedEvent(input: { id?: string; message: string; source?: string }): BlockerRecordedEvent {
  return {
    schema: TASK_LEDGER_SCHEMA,
    kind: "blocker_recorded",
    blocker: {
      id: input.id ?? buildId("blocker"),
      message: input.message,
      source: input.source,
    },
  };
}

export function buildBlockerResolvedEvent(blockerId: string): BlockerResolvedEvent {
  return {
    schema: TASK_LEDGER_SCHEMA,
    kind: "blocker_resolved",
    blockerId,
  };
}

export function coerceTaskLedgerPayload(value: unknown): TaskLedgerEventPayload | null {
  if (!isRecord(value)) return null;
  if (value.schema !== TASK_LEDGER_SCHEMA) return null;
  const kind = value.kind;
  if (kind === "spec_set") {
    const spec = value.spec as unknown;
    if (!isRecord(spec) || spec.schema !== "roaster.task.v1" || typeof spec.goal !== "string") {
      return null;
    }
    return { schema: TASK_LEDGER_SCHEMA, kind, spec: spec as unknown as TaskSpec };
  }

  if (kind === "checkpoint_set") {
    const state = coerceTaskState(value.state as unknown);
    if (!state) return null;
    return {
      schema: TASK_LEDGER_SCHEMA,
      kind,
      state,
    };
  }

  if (kind === "item_added" || kind === "item_updated") {
    const item = value.item as unknown;
    if (!isRecord(item)) return null;
    const id = normalizeNonEmptyString(item.id);
    if (!id) return null;

    const text = normalizeNonEmptyString(item.text);
    const status = normalizeStatus(item.status);
    if (kind === "item_added") {
      if (!text) return null;
      return {
        schema: TASK_LEDGER_SCHEMA,
        kind,
        item: {
          id,
          text,
          status,
        },
      };
    }

    if (!text && !status) return null;
    return {
      schema: TASK_LEDGER_SCHEMA,
      kind,
      item: {
        id,
        text,
        status,
      },
    };
  }

  if (kind === "blocker_recorded") {
    const blocker = value.blocker as unknown;
    if (!isRecord(blocker)) return null;
    const id = normalizeNonEmptyString(blocker.id);
    const message = normalizeNonEmptyString(blocker.message);
    if (!id || !message) return null;
    const source = normalizeNonEmptyString(blocker.source);
    return {
      schema: TASK_LEDGER_SCHEMA,
      kind,
      blocker: {
        id,
        message,
        source,
      },
    };
  }

  if (kind === "blocker_resolved") {
    const blockerId = normalizeNonEmptyString(value.blockerId);
    if (!blockerId) return null;
    return {
      schema: TASK_LEDGER_SCHEMA,
      kind,
      blockerId,
    };
  }

  return null;
}

function coerceTaskState(value: unknown): TaskState | null {
  if (!isRecord(value)) return null;

  const specValue = value.spec as unknown;
  let spec: TaskSpec | undefined;
  if (isRecord(specValue) && specValue.schema === "roaster.task.v1" && typeof specValue.goal === "string") {
    spec = specValue as unknown as TaskSpec;
  }

  const itemsValue = value.items as unknown;
  if (!Array.isArray(itemsValue)) return null;
  const blockersValue = value.blockers as unknown;
  if (!Array.isArray(blockersValue)) return null;

  const items: TaskState["items"] = [];
  for (const raw of itemsValue) {
    if (!isRecord(raw)) continue;
    const id = normalizeNonEmptyString(raw.id);
    const text = normalizeNonEmptyString(raw.text);
    const status = normalizeStatus(raw.status) ?? "todo";
    const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : null;
    const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : null;
    if (!id || !text) continue;
    if (createdAt === null || updatedAt === null) continue;
    items.push({ id, text, status, createdAt, updatedAt });
  }

  const blockers: TaskState["blockers"] = [];
  for (const raw of blockersValue) {
    if (!isRecord(raw)) continue;
    const id = normalizeNonEmptyString(raw.id);
    const message = normalizeNonEmptyString(raw.message);
    const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : null;
    const source = normalizeNonEmptyString(raw.source);
    if (!id || !message) continue;
    if (createdAt === null) continue;
    blockers.push({ id, message, createdAt, source });
  }

  const updatedAtValue = value.updatedAt as unknown;
  const updatedAt = typeof updatedAtValue === "number" ? updatedAtValue : updatedAtValue === null ? null : null;

  return {
    spec,
    items,
    blockers,
    updatedAt,
  };
}
