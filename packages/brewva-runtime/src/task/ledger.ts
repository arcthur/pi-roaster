import type {
  BrewvaEventRecord,
  TaskBlocker,
  TaskHealth,
  TaskItem,
  TaskItemStatus,
  TaskLedgerEventPayload,
  TaskPhase,
  TaskSpec,
  TaskState,
  TaskStatus,
} from "../types.js";
import { isRecord, normalizeNonEmptyString, normalizeStringArray } from "../utils/coerce.js";

export const TASK_EVENT_TYPE = "task_event";
export const TASK_LEDGER_SCHEMA = "brewva.task.ledger.v1" as const;

type SpecSetEvent = Extract<TaskLedgerEventPayload, { kind: "spec_set" }>;
type CheckpointSetEvent = Extract<TaskLedgerEventPayload, { kind: "checkpoint_set" }>;
type StatusSetEvent = Extract<TaskLedgerEventPayload, { kind: "status_set" }>;
type ItemAddedEvent = Extract<TaskLedgerEventPayload, { kind: "item_added" }>;
type ItemUpdatedEvent = Extract<TaskLedgerEventPayload, { kind: "item_updated" }>;
type BlockerRecordedEvent = Extract<TaskLedgerEventPayload, { kind: "blocker_recorded" }>;
type BlockerResolvedEvent = Extract<TaskLedgerEventPayload, { kind: "blocker_resolved" }>;

function normalizeStatus(value: unknown): TaskItemStatus | undefined {
  if (value === "todo" || value === "doing" || value === "done" || value === "blocked") {
    return value;
  }
  return undefined;
}

function normalizePhase(value: unknown): TaskPhase | undefined {
  if (
    value === "align" ||
    value === "investigate" ||
    value === "execute" ||
    value === "verify" ||
    value === "blocked" ||
    value === "done"
  ) {
    return value;
  }
  return undefined;
}

function normalizeHealth(value: unknown): TaskHealth | undefined {
  if (
    value === "ok" ||
    value === "needs_spec" ||
    value === "blocked" ||
    value === "verification_failed" ||
    value === "budget_pressure" ||
    value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

function coerceTaskStatus(value: unknown): TaskStatus | null {
  if (!isRecord(value)) return null;
  const phase = normalizePhase(value.phase);
  const health = normalizeHealth(value.health);
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : null;
  if (!phase || !health || updatedAt === null) return null;

  const truthFactIds = normalizeStringArray(value.truthFactIds);

  return {
    phase,
    health,
    reason: normalizeNonEmptyString(value.reason),
    updatedAt,
    truthFactIds,
  };
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

  if (payload.kind === "status_set") {
    return {
      ...state,
      status: payload.status,
      updatedAt,
    };
  }

  if (payload.kind === "checkpoint_set") {
    const nextUpdatedAt = Math.max(payload.state.updatedAt ?? 0, timestamp);
    return {
      spec: payload.state.spec,
      status: payload.state.status,
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
      const nextTruth = payload.blocker.truthFactId ?? existing.truthFactId;
      const changed = existing.message !== nextMessage || existing.source !== nextSource || existing.truthFactId !== nextTruth;
      return {
        ...state,
        blockers: changed
          ? state.blockers.map((blocker) =>
              blocker.id === id
                ? {
                    ...blocker,
                    message: nextMessage,
                    source: nextSource,
                    truthFactId: nextTruth,
                  }
                : blocker,
            )
          : state.blockers,
        updatedAt,
      };
    }

    const blocker: TaskBlocker = {
      id,
      message: payload.blocker.message,
      createdAt: timestamp,
      source: payload.blocker.source,
      truthFactId: payload.blocker.truthFactId,
    };
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

export function foldTaskLedgerEvents(events: BrewvaEventRecord[]): TaskState {
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

export function buildStatusSetEvent(status: TaskStatus): StatusSetEvent {
  return {
    schema: TASK_LEDGER_SCHEMA,
    kind: "status_set",
    status,
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

export function buildBlockerRecordedEvent(input: {
  id?: string;
  message: string;
  source?: string;
  truthFactId?: string;
}): BlockerRecordedEvent {
  return {
    schema: TASK_LEDGER_SCHEMA,
    kind: "blocker_recorded",
    blocker: {
      id: input.id ?? buildId("blocker"),
      message: input.message,
      source: input.source,
      truthFactId: input.truthFactId,
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
    if (!isRecord(spec) || spec.schema !== "brewva.task.v1" || typeof spec.goal !== "string") {
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

  if (kind === "status_set") {
    const status = coerceTaskStatus(value.status as unknown);
    if (!status) return null;
    return {
      schema: TASK_LEDGER_SCHEMA,
      kind,
      status,
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
    const truthFactId = normalizeNonEmptyString(blocker.truthFactId);
    return {
      schema: TASK_LEDGER_SCHEMA,
      kind,
      blocker: {
        id,
        message,
        source,
        truthFactId,
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

export function formatTaskStateBlock(state: TaskState): string {
  const hasAny =
    Boolean(state.spec) || Boolean(state.status) || (state.items?.length ?? 0) > 0 || (state.blockers?.length ?? 0) > 0;
  if (!hasAny) return "";

  const spec = state.spec;
  const lines: string[] = ["[TaskLedger]"];
  if (spec) {
    lines.push(`goal=${spec.goal}`);
    if (spec.expectedBehavior) {
      lines.push(`expectedBehavior=${spec.expectedBehavior}`);
    }

    const files = spec.targets?.files ?? [];
    const symbols = spec.targets?.symbols ?? [];
    if (files.length > 0) {
      lines.push("targets.files:");
      for (const file of files.slice(0, 8)) {
        lines.push(`- ${file}`);
      }
    }
    if (symbols.length > 0) {
      lines.push("targets.symbols:");
      for (const symbol of symbols.slice(0, 8)) {
        lines.push(`- ${symbol}`);
      }
    }

    const constraints = spec.constraints ?? [];
    if (constraints.length > 0) {
      lines.push("constraints:");
      for (const constraint of constraints.slice(0, 8)) {
        lines.push(`- ${constraint}`);
      }
    }
  }

  const status = state.status;
  if (status) {
    lines.push(`status.phase=${status.phase}`);
    lines.push(`status.health=${status.health}`);
    if (status.reason) {
      lines.push(`status.reason=${status.reason}`);
    }
    const truthFactIds = status.truthFactIds ?? [];
    if (truthFactIds.length > 0) {
      lines.push("status.truthFacts:");
      for (const truthFactId of truthFactIds.slice(0, 6)) {
        lines.push(`- ${truthFactId}`);
      }
    }
  }

  const blockers = state.blockers ?? [];
  if (blockers.length > 0) {
    lines.push("blockers:");
    for (const blocker of blockers.slice(0, 4)) {
      const source = blocker.source ? ` source=${blocker.source}` : "";
      const truth = blocker.truthFactId ? ` truth=${blocker.truthFactId}` : "";
      const messageLines = blocker.message.split("\n");
      const firstLine = messageLines[0] ?? "";
      lines.push(`- [${blocker.id}] ${firstLine}${source}${truth}`.trim());
      for (const line of messageLines.slice(1)) {
        lines.push(`  ${line}`);
      }
    }
  }

  const items = state.items ?? [];
  const open = items.filter((item) => item.status !== "done").slice(0, 6);
  if (open.length > 0) {
    lines.push("openItems:");
    for (const item of open) {
      lines.push(`- [${item.status}] ${item.text}`);
    }
  }

  const verification = spec?.verification;
  if (verification?.level) {
    lines.push(`verification.level=${verification.level}`);
  }
  if (verification?.commands && verification.commands.length > 0) {
    lines.push("verification.commands:");
    for (const command of verification.commands.slice(0, 4)) {
      lines.push(`- ${command}`);
    }
  }

  return lines.join("\n");
}

function coerceTaskState(value: unknown): TaskState | null {
  if (!isRecord(value)) return null;

  const specValue = value.spec as unknown;
  let spec: TaskSpec | undefined;
  if (isRecord(specValue) && specValue.schema === "brewva.task.v1" && typeof specValue.goal === "string") {
    spec = specValue as unknown as TaskSpec;
  }

  const statusValue = value.status as unknown;
  const status = statusValue ? coerceTaskStatus(statusValue) ?? undefined : undefined;

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
    const truthFactId = normalizeNonEmptyString(raw.truthFactId);
    if (!id || !message) continue;
    if (createdAt === null) continue;
    blockers.push({ id, message, createdAt, source, truthFactId });
  }

  const updatedAtValue = value.updatedAt as unknown;
  const updatedAt = typeof updatedAtValue === "number" ? updatedAtValue : updatedAtValue === null ? null : null;

  return {
    spec,
    status,
    items,
    blockers,
    updatedAt,
  };
}
