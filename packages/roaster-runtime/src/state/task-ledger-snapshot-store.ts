import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RoasterEventRecord, RoasterConfig, TaskState } from "../types.js";
import { ensureDir, writeFileAtomic } from "../utils/fs.js";
import { normalizeJsonRecord } from "../utils/json.js";
import {
  TASK_EVENT_TYPE,
  TASK_LEDGER_SCHEMA,
  buildCheckpointSetEvent,
  coerceTaskLedgerPayload,
  createEmptyTaskState,
  reduceTaskState,
} from "../task/ledger.js";

const COMPACT_COOLDOWN_MS = 60_000;
const COMPACT_MIN_BYTES = 64_000;
const COMPACT_MAX_BYTES = 50 * 1024 * 1024;
const COMPACT_KEEP_LAST_TASK_EVENTS = 80;
const COMPACT_MIN_TASK_EVENTS = 220;

export interface TaskLedgerSnapshot {
  version: 1;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  logOffsetBytes: number;
  state: TaskState;
}

export interface TaskLedgerCompactionResult {
  sessionId: string;
  compacted: number;
  kept: number;
  bytesBefore: number;
  bytesAfter: number;
  durationMs: number;
  checkpointEventId: string;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

function isTaskLedgerSnapshot(value: unknown): value is TaskLedgerSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  if (typeof record.sessionId !== "string") return false;
  if (typeof record.createdAt !== "number") return false;
  if (typeof record.updatedAt !== "number") return false;
  if (typeof record.logOffsetBytes !== "number") return false;
  if (!record.state || typeof record.state !== "object" || Array.isArray(record.state)) return false;
  return true;
}

function parseEventLine(line: string): RoasterEventRecord | undefined {
  try {
    const value = JSON.parse(line) as RoasterEventRecord;
    if (!value || typeof value.id !== "string" || typeof value.type !== "string" || typeof value.sessionId !== "string") {
      return undefined;
    }
    if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function buildEventId(prefix: string, timestamp: number): string {
  return `${prefix}_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
}

function applyTaskEventsFromOffset(input: {
  filePath: string;
  sessionId: string;
  offsetBytes: number;
  baseState: TaskState;
}): { state: TaskState; endOffsetBytes: number; changed: boolean } {
  if (!existsSync(input.filePath)) {
    return { state: input.baseState, endOffsetBytes: input.offsetBytes, changed: false };
  }

  let size = 0;
  try {
    size = statSync(input.filePath).size;
  } catch {
    return { state: input.baseState, endOffsetBytes: input.offsetBytes, changed: false };
  }

  const start = Math.max(0, Math.floor(input.offsetBytes));
  if (size <= start) {
    return { state: input.baseState, endOffsetBytes: size, changed: false };
  }

  const fd = openSync(input.filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let position = start;
    let carry = "";
    let state = input.baseState;
    let changed = false;

    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;

      const chunk = carry + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = chunk.split("\n");
      carry = lines.pop() ?? "";

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        const event = parseEventLine(trimmed);
        if (!event) continue;
        if (event.sessionId !== input.sessionId) continue;
        if (event.type !== TASK_EVENT_TYPE) continue;
        const payload = coerceTaskLedgerPayload(event.payload);
        if (!payload) continue;
        state = reduceTaskState(state, payload, event.timestamp);
        changed = true;
      }
    }

    const tail = carry.trim();
    if (tail.length > 0) {
      const event = parseEventLine(tail);
      if (event && event.sessionId === input.sessionId && event.type === TASK_EVENT_TYPE) {
        const payload = coerceTaskLedgerPayload(event.payload);
        if (payload) {
          state = reduceTaskState(state, payload, event.timestamp);
          changed = true;
        }
      }
    }

    return { state, endOffsetBytes: position, changed };
  } finally {
    closeSync(fd);
  }
}

export class TaskLedgerSnapshotStore {
  private readonly enabled: boolean;
  private readonly snapshotsDir: string;
  private readonly archiveDir: string;
  private readonly eventsDir: string;
  private lastCompactionAtBySession = new Map<string, number>();

  constructor(
    config: { enabled: boolean; snapshotsDir: string; eventsDir: string },
    cwd: string,
  ) {
    this.enabled = config.enabled;
    const resolvedCwd = resolve(cwd);
    this.snapshotsDir = resolve(resolvedCwd, config.snapshotsDir, "task-ledger");
    this.archiveDir = resolve(this.snapshotsDir, "archive");
    this.eventsDir = resolve(resolvedCwd, config.eventsDir);
    if (this.enabled) {
      ensureDir(this.snapshotsDir);
      ensureDir(this.archiveDir);
    }
  }

  hydrate(sessionId: string): TaskState | undefined {
    if (!this.enabled) return undefined;
    const normalizedSession = sanitizeSessionId(sessionId);
    const snapshotPath = resolve(this.snapshotsDir, `${normalizedSession}.json`);
    if (!existsSync(snapshotPath)) return undefined;

    let parsed: TaskLedgerSnapshot | undefined;
    try {
      parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as TaskLedgerSnapshot;
    } catch {
      return undefined;
    }
    if (!isTaskLedgerSnapshot(parsed)) return undefined;
    if (parsed.sessionId !== sessionId) return undefined;

    const eventsPath = resolve(this.eventsDir, `${normalizedSession}.jsonl`);
    if (!existsSync(eventsPath)) {
      return parsed.state;
    }

    let currentSize = 0;
    try {
      currentSize = statSync(eventsPath).size;
    } catch {
      return parsed.state;
    }

    if (currentSize < parsed.logOffsetBytes) {
      return undefined;
    }

    if (currentSize === parsed.logOffsetBytes) {
      return parsed.state;
    }

    const catchUp = applyTaskEventsFromOffset({
      filePath: eventsPath,
      sessionId,
      offsetBytes: parsed.logOffsetBytes,
      baseState: parsed.state,
    });

    if (catchUp.endOffsetBytes > parsed.logOffsetBytes) {
      const now = Date.now();
      const nextSnapshot: TaskLedgerSnapshot = {
        version: 1,
        sessionId,
        createdAt: parsed.createdAt,
        updatedAt: now,
        logOffsetBytes: catchUp.endOffsetBytes,
        state: catchUp.state,
      };
      writeFileAtomic(snapshotPath, JSON.stringify(nextSnapshot, null, 2));
    }

    return catchUp.state;
  }

  save(sessionId: string, state: TaskState): void {
    if (!this.enabled) return;
    const normalizedSession = sanitizeSessionId(sessionId);
    const snapshotPath = resolve(this.snapshotsDir, `${normalizedSession}.json`);
    const eventsPath = resolve(this.eventsDir, `${normalizedSession}.jsonl`);

    let offsetBytes = 0;
    if (existsSync(eventsPath)) {
      try {
        offsetBytes = statSync(eventsPath).size;
      } catch {
        offsetBytes = 0;
      }
    }

    const now = Date.now();
    let createdAt = now;
    if (existsSync(snapshotPath)) {
      try {
        const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as TaskLedgerSnapshot;
        if (isTaskLedgerSnapshot(parsed) && parsed.sessionId === sessionId) {
          createdAt = parsed.createdAt;
        }
      } catch {
        // ignore
      }
    }

    const snapshot: TaskLedgerSnapshot = {
      version: 1,
      sessionId,
      createdAt,
      updatedAt: now,
      logOffsetBytes: offsetBytes,
      state,
    };
    writeFileAtomic(snapshotPath, JSON.stringify(snapshot, null, 2));
  }

  maybeCompact(sessionId: string, state: TaskState): TaskLedgerCompactionResult | undefined {
    if (!this.enabled) return undefined;

    const startMs = Date.now();
    const lastCompactAt = this.lastCompactionAtBySession.get(sessionId) ?? 0;
    if (startMs - lastCompactAt < COMPACT_COOLDOWN_MS) return undefined;

    const normalizedSession = sanitizeSessionId(sessionId);
    const eventsPath = resolve(this.eventsDir, `${normalizedSession}.jsonl`);
    if (!existsSync(eventsPath)) return undefined;

    let size = 0;
    try {
      size = statSync(eventsPath).size;
    } catch {
      return undefined;
    }
    if (size < COMPACT_MIN_BYTES) return undefined;
    if (size > COMPACT_MAX_BYTES) return undefined;
    const bytesBefore = size;

    const raw = readFileSync(eventsPath, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const events: RoasterEventRecord[] = [];
    const taskPositions: number[] = [];
    for (const line of lines) {
      const event = parseEventLine(line);
      if (!event) continue;
      events.push(event);
      if (event.type === TASK_EVENT_TYPE) {
        taskPositions.push(events.length - 1);
      }
    }

    if (taskPositions.length < COMPACT_MIN_TASK_EVENTS) return undefined;

    const keepLast = Math.max(1, COMPACT_KEEP_LAST_TASK_EVENTS);
    if (taskPositions.length <= keepLast) return undefined;

    const compactCount = taskPositions.length - keepLast;
    const lastCompactedIndex = taskPositions[compactCount - 1];
    if (lastCompactedIndex === undefined) return undefined;
    const lastCompactedEvent = events[lastCompactedIndex];
    if (!lastCompactedEvent) return undefined;

    let checkpointState = createEmptyTaskState();
    const compactedTaskEvents: RoasterEventRecord[] = [];
    for (const position of taskPositions.slice(0, compactCount)) {
      const event = events[position];
      if (!event) continue;
      compactedTaskEvents.push(event);
      const payload = coerceTaskLedgerPayload(event.payload);
      if (!payload) continue;
      checkpointState = reduceTaskState(checkpointState, payload, event.timestamp);
    }

    const checkpointPayload = normalizeJsonRecord(buildCheckpointSetEvent(checkpointState) as unknown as Record<string, unknown>);
    if (!checkpointPayload) return undefined;

    const checkpointEvent: RoasterEventRecord = {
      id: buildEventId("evt_task_checkpoint", lastCompactedEvent.timestamp),
      sessionId,
      type: TASK_EVENT_TYPE,
      timestamp: lastCompactedEvent.timestamp,
      turn: lastCompactedEvent.turn,
      payload: checkpointPayload,
    };

    const compactedPositions = new Set(taskPositions.slice(0, compactCount));
    const rebuilt: RoasterEventRecord[] = [];
    for (let i = 0; i < events.length; i += 1) {
      if (i === lastCompactedIndex) {
        rebuilt.push(checkpointEvent);
        continue;
      }
      if (compactedPositions.has(i)) {
        continue;
      }
      rebuilt.push(events[i]!);
    }

    const archivePath = resolve(this.archiveDir, `${normalizedSession}.jsonl`);
    const archiveLines: string[] = [];
    archiveLines.push(
      JSON.stringify({
        schema: "roaster.task.ledger.archive.v1",
        kind: "compacted",
        sessionId,
        createdAt: startMs,
        checkpointEventId: checkpointEvent.id,
        compacted: compactedTaskEvents.length,
        kept: keepLast,
        schemaVersion: TASK_LEDGER_SCHEMA,
      }),
    );
    for (const event of compactedTaskEvents) {
      archiveLines.push(JSON.stringify(event));
    }
    const archivePrefix = existsSync(archivePath) && statSync(archivePath).size > 0 ? "\n" : "";
    writeFileSync(archivePath, `${archivePrefix}${archiveLines.join("\n")}`, { flag: "a" });

    writeFileAtomic(eventsPath, rebuilt.map((event) => JSON.stringify(event)).join("\n"));
    this.save(sessionId, state);
    this.lastCompactionAtBySession.set(sessionId, startMs);

    let bytesAfter = bytesBefore;
    try {
      bytesAfter = statSync(eventsPath).size;
    } catch {
      bytesAfter = bytesBefore;
    }

    return {
      sessionId,
      compacted: compactedTaskEvents.length,
      kept: keepLast,
      bytesBefore,
      bytesAfter,
      durationMs: Math.max(0, Date.now() - startMs),
      checkpointEventId: checkpointEvent.id,
    };
  }

  remove(sessionId: string): void {
    if (!this.enabled) return;
    const normalizedSession = sanitizeSessionId(sessionId);
    const snapshotPath = resolve(this.snapshotsDir, `${normalizedSession}.json`);
    if (!existsSync(snapshotPath)) return;
    rmSync(snapshotPath, { force: true });
  }
}

export function createTaskLedgerSnapshotStore(config: RoasterConfig, cwd: string): TaskLedgerSnapshotStore {
  return new TaskLedgerSnapshotStore(
    {
      enabled: config.infrastructure.events.enabled,
      snapshotsDir: config.infrastructure.interruptRecovery.snapshotsDir,
      eventsDir: config.infrastructure.events.dir,
    },
    cwd,
  );
}
