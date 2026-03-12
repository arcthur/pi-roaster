import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { redactUnknown } from "../security/redact.js";
import {
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  type TapeAnchorPayload,
  type TapeCheckpointPayload,
} from "../tape/events.js";
import type { BrewvaConfig, BrewvaEventQuery, BrewvaEventRecord } from "../types.js";
import { ensureDir } from "../utils/fs.js";
import { normalizeJsonRecord } from "../utils/json.js";

type EventAppendInput = {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: Record<string, unknown>;
  timestamp?: number;
};

const ENCODED_SESSION_PREFIX = "sess_";

function encodeSessionIdForFileName(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function decodeSessionIdFromFileName(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

interface EventFileCache {
  readonly rows: BrewvaEventRecord[];
  byteOffset: number;
  trailingFragment: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreezeJson(entry);
    }
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      deepFreezeJson(entry);
    }
    return Object.freeze(value);
  }
  return value;
}

function freezeEventRecord(row: BrewvaEventRecord): BrewvaEventRecord {
  const payload = row.payload ? deepFreezeJson(row.payload) : undefined;
  return Object.freeze({
    ...row,
    payload,
  });
}

function parseEventRecord(line: string): BrewvaEventRecord | null {
  try {
    const value = JSON.parse(line) as BrewvaEventRecord;
    if (
      value &&
      typeof value.id === "string" &&
      typeof value.sessionId === "string" &&
      typeof value.type === "string" &&
      typeof value.timestamp === "number" &&
      Number.isFinite(value.timestamp) &&
      (value.turn === undefined ||
        (typeof value.turn === "number" && Number.isFinite(value.turn))) &&
      (value.payload === undefined || isRecord(value.payload))
    ) {
      return freezeEventRecord(value);
    }
  } catch {
    return null;
  }
  return null;
}

export class BrewvaEventStore {
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly fileHasContent = new Map<string, boolean>();
  private readonly eventCacheByFilePath = new Map<string, EventFileCache>();

  constructor(config: BrewvaConfig["infrastructure"]["events"], cwd: string) {
    this.enabled = config.enabled;
    this.dir = resolve(cwd, config.dir);
    if (this.enabled) {
      ensureDir(this.dir);
    }
  }

  append(input: EventAppendInput): BrewvaEventRecord | undefined {
    if (!this.enabled) return undefined;

    const timestamp = input.timestamp ?? Date.now();
    const id = `evt_${timestamp}_${randomUUID()}`;
    const row: BrewvaEventRecord = {
      id,
      sessionId: input.sessionId,
      type: input.type,
      timestamp,
      turn: input.turn,
      payload: normalizeJsonRecord(
        input.payload ? (redactUnknown(input.payload) as Record<string, unknown>) : undefined,
      ),
    };
    const frozenRow = freezeEventRecord(row);

    const filePath = this.filePathForSession(frozenRow.sessionId);
    const prefix = this.hasContent(filePath) ? "\n" : "";
    const serialized = JSON.stringify(frozenRow);
    const appended = `${prefix}${serialized}`;
    writeFileSync(filePath, appended, { flag: "a" });
    this.fileHasContent.set(filePath, true);
    this.trackAppendedRow(filePath, frozenRow, appended);
    return frozenRow;
  }

  appendAnchor(input: {
    sessionId: string;
    payload: TapeAnchorPayload;
    turn?: number;
    timestamp?: number;
  }): BrewvaEventRecord | undefined {
    return this.append({
      sessionId: input.sessionId,
      type: TAPE_ANCHOR_EVENT_TYPE,
      turn: input.turn,
      payload: input.payload as unknown as Record<string, unknown>,
      timestamp: input.timestamp,
    });
  }

  appendCheckpoint(input: {
    sessionId: string;
    payload: TapeCheckpointPayload;
    turn?: number;
    timestamp?: number;
  }): BrewvaEventRecord | undefined {
    return this.append({
      sessionId: input.sessionId,
      type: TAPE_CHECKPOINT_EVENT_TYPE,
      turn: input.turn,
      payload: input.payload as unknown as Record<string, unknown>,
      timestamp: input.timestamp,
    });
  }

  list(sessionId: string, query: BrewvaEventQuery = {}): BrewvaEventRecord[] {
    const rows = this.listFromCache(sessionId);
    const requestedLast =
      typeof query.last === "number" && Number.isFinite(query.last)
        ? Math.max(0, Math.floor(query.last))
        : 0;

    if (requestedLast > 0 && query.type) {
      const matches: BrewvaEventRecord[] = [];
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (!row || row.type !== query.type) continue;
        matches.push(row);
        if (matches.length >= requestedLast) break;
      }
      return matches.toReversed();
    }

    if (requestedLast > 0) {
      return rows.slice(-requestedLast);
    }

    if (query.type) {
      return rows.filter((row) => row.type === query.type);
    }

    return rows.slice();
  }

  listAnchors(sessionId: string, query: Omit<BrewvaEventQuery, "type"> = {}): BrewvaEventRecord[] {
    return this.list(sessionId, {
      ...query,
      type: TAPE_ANCHOR_EVENT_TYPE,
    });
  }

  listCheckpoints(
    sessionId: string,
    query: Omit<BrewvaEventQuery, "type"> = {},
  ): BrewvaEventRecord[] {
    return this.list(sessionId, {
      ...query,
      type: TAPE_CHECKPOINT_EVENT_TYPE,
    });
  }

  latest(sessionId: string): BrewvaEventRecord | undefined {
    return this.list(sessionId, { last: 1 })[0];
  }

  clearSessionCache(sessionId: string): void {
    const filePath = this.filePathForSession(sessionId);
    this.fileHasContent.delete(filePath);
    this.eventCacheByFilePath.delete(filePath);
  }

  listSessionIds(): string[] {
    if (!this.enabled) return [];
    if (!existsSync(this.dir)) return [];

    const mtimeBySessionId = new Map<string, number>();
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = resolve(this.dir, entry.name);
      try {
        const stat = statSync(filePath);
        if (stat.size <= 0) continue;
        const stem = entry.name.slice(0, -".jsonl".length);
        if (!stem.startsWith(ENCODED_SESSION_PREFIX)) continue;

        const decoded = decodeSessionIdFromFileName(stem.slice(ENCODED_SESSION_PREFIX.length));
        if (!decoded) continue;

        const previous = mtimeBySessionId.get(decoded) ?? 0;
        mtimeBySessionId.set(decoded, Math.max(previous, stat.mtimeMs));
      } catch {
        continue;
      }
    }

    return [...mtimeBySessionId.entries()]
      .toSorted((left, right) => right[1] - left[1])
      .map(([sessionId]) => sessionId);
  }

  private listFromCache(sessionId: string): BrewvaEventRecord[] {
    if (!this.enabled) return [];
    const filePath = this.filePathForSession(sessionId);
    return this.syncCacheForFile(filePath).rows;
  }

  private filePathForSession(sessionId: string): string {
    const encoded = encodeSessionIdForFileName(sessionId);
    return resolve(this.dir, `${ENCODED_SESSION_PREFIX}${encoded}.jsonl`);
  }

  private syncCacheForFile(filePath: string): EventFileCache {
    if (!existsSync(filePath)) {
      const empty: EventFileCache = {
        rows: [],
        byteOffset: 0,
        trailingFragment: "",
      };
      this.eventCacheByFilePath.set(filePath, empty);
      return empty;
    }

    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      const empty: EventFileCache = {
        rows: [],
        byteOffset: 0,
        trailingFragment: "",
      };
      this.eventCacheByFilePath.set(filePath, empty);
      return empty;
    }

    const cached = this.eventCacheByFilePath.get(filePath);
    if (!cached || size < cached.byteOffset) {
      return this.rebuildCacheFromFile(filePath, size);
    }

    if (size === cached.byteOffset) {
      return cached;
    }

    const appended = this.readTextRange(filePath, cached.byteOffset, size);
    this.consumeChunk(cached, appended);
    cached.byteOffset = size;
    return cached;
  }

  private rebuildCacheFromFile(filePath: string, size: number): EventFileCache {
    const cache: EventFileCache = {
      rows: [],
      byteOffset: size,
      trailingFragment: "",
    };

    if (size > 0) {
      const text = readFileSync(filePath, "utf8");
      this.consumeChunk(cache, text);
    }

    this.eventCacheByFilePath.set(filePath, cache);
    return cache;
  }

  private readTextRange(filePath: string, fromOffset: number, toOffset: number): string {
    const length = Math.max(0, toOffset - fromOffset);
    if (length <= 0) return "";

    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      let consumed = 0;
      while (consumed < length) {
        const read = readSync(fd, buffer, consumed, length - consumed, fromOffset + consumed);
        if (read <= 0) break;
        consumed += read;
      }
      return buffer.subarray(0, consumed).toString("utf8");
    } finally {
      closeSync(fd);
    }
  }

  private consumeChunk(cache: EventFileCache, text: string): void {
    if (!text && !cache.trailingFragment) {
      return;
    }
    const combined = `${cache.trailingFragment}${text}`;
    if (!combined) {
      cache.trailingFragment = "";
      return;
    }
    const lines = combined.split("\n");
    cache.trailingFragment = "";

    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index] ?? "";
      const trimmed = raw.trim();
      if (!trimmed) continue;

      const parsed = parseEventRecord(trimmed);
      if (parsed) {
        cache.rows.push(parsed);
        continue;
      }

      // Keep only a potentially incomplete tail fragment for the next incremental read.
      if (index === lines.length - 1) {
        cache.trailingFragment = raw;
      }
    }
  }

  private trackAppendedRow(filePath: string, row: BrewvaEventRecord, appended: string): void {
    const cached = this.eventCacheByFilePath.get(filePath);
    if (!cached) return;
    if (cached.trailingFragment) {
      this.eventCacheByFilePath.delete(filePath);
      return;
    }
    cached.rows.push(row);
    cached.byteOffset += Buffer.byteLength(appended, "utf8");
  }

  private hasContent(filePath: string): boolean {
    const cached = this.fileHasContent.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    let hasData = false;
    if (existsSync(filePath)) {
      try {
        hasData = statSync(filePath).size > 0;
      } catch {
        hasData = false;
      }
    }
    this.fileHasContent.set(filePath, hasData);
    return hasData;
  }
}
