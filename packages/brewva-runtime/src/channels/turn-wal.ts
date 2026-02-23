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
import type { BrewvaConfig, TurnWALRecord, TurnWALSource, TurnWALStatus } from "../types.js";
import { ensureDir, writeFileAtomic } from "../utils/fs.js";
import type { TurnEnvelope } from "./turn.js";

export interface TurnWALStoreOptions {
  workspaceRoot: string;
  config: BrewvaConfig["infrastructure"]["turnWal"];
  scope: string;
  now?: () => number;
  recordEvent?: (input: {
    sessionId: string;
    type: string;
    payload?: Record<string, unknown>;
  }) => void;
}

export interface TurnWALAppendPendingOptions {
  ttlMs?: number;
  dedupeKey?: string;
}

export interface TurnWALCompactResult {
  scope: string;
  filePath: string;
  scanned: number;
  retained: number;
  dropped: number;
}

interface TurnWALFileCache {
  readonly rowsByWalId: Map<string, TurnWALRecord>;
  byteOffset: number;
  trailingFragment: string;
}

const TERMINAL_STATUSES = new Set<TurnWALStatus>(["done", "failed", "expired"]);
const RECOVERABLE_STATUSES = new Set<TurnWALStatus>(["pending", "inflight"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTurnEnvelope(value: unknown): value is TurnEnvelope {
  if (!isRecord(value)) return false;
  if (value.schema !== "brewva.turn.v1") return false;
  if (typeof value.kind !== "string") return false;
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return false;
  if (typeof value.turnId !== "string" || !value.turnId.trim()) return false;
  if (typeof value.channel !== "string" || !value.channel.trim()) return false;
  if (typeof value.conversationId !== "string" || !value.conversationId.trim()) return false;
  if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return false;
  if (!Array.isArray(value.parts)) return false;
  return true;
}

function isTurnWALStatus(value: unknown): value is TurnWALStatus {
  return (
    value === "pending" ||
    value === "inflight" ||
    value === "done" ||
    value === "failed" ||
    value === "expired"
  );
}

function isTurnWALSource(value: unknown): value is TurnWALSource {
  return (
    value === "channel" || value === "schedule" || value === "gateway" || value === "heartbeat"
  );
}

function parseTurnWALRecord(line: string): TurnWALRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.schema !== "brewva.turn-wal.v1") return null;
  if (typeof value.walId !== "string" || !value.walId.trim()) return null;
  if (typeof value.turnId !== "string" || !value.turnId.trim()) return null;
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return null;
  if (typeof value.channel !== "string" || !value.channel.trim()) return null;
  if (typeof value.conversationId !== "string" || !value.conversationId.trim()) return null;
  if (!isTurnWALStatus(value.status)) return null;
  if (!isTurnEnvelope(value.envelope)) return null;
  if (
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt <= 0
  )
    return null;
  if (
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt <= 0
  )
    return null;
  if (typeof value.attempts !== "number" || !Number.isFinite(value.attempts) || value.attempts < 0)
    return null;
  if (!isTurnWALSource(value.source)) return null;
  if (value.error !== undefined && typeof value.error !== "string") return null;
  if (
    value.ttlMs !== undefined &&
    (typeof value.ttlMs !== "number" || !Number.isFinite(value.ttlMs) || value.ttlMs <= 0)
  ) {
    return null;
  }
  if (value.dedupeKey !== undefined && typeof value.dedupeKey !== "string") return null;

  const row: TurnWALRecord = {
    schema: "brewva.turn-wal.v1",
    walId: value.walId,
    turnId: value.turnId,
    sessionId: value.sessionId,
    channel: value.channel,
    conversationId: value.conversationId,
    status: value.status,
    envelope: value.envelope,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    attempts: value.attempts,
    source: value.source,
  };
  if (value.error !== undefined) {
    row.error = value.error;
  }
  if (value.ttlMs !== undefined) {
    row.ttlMs = value.ttlMs;
  }
  if (value.dedupeKey !== undefined) {
    row.dedupeKey = value.dedupeKey;
  }
  return row;
}

function sanitizeScopeId(scope: string): string {
  const normalized = scope.trim().replaceAll(/[^\w.-]+/g, "_");
  return normalized || "default";
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cloneTurnWALRecord(row: TurnWALRecord): TurnWALRecord {
  return structuredClone(row);
}

function compareByCreatedAt(left: TurnWALRecord, right: TurnWALRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.updatedAt - right.updatedAt;
}

export class TurnWALStore {
  readonly workspaceRoot: string;
  readonly scope: string;
  readonly filePath: string;
  readonly config: BrewvaConfig["infrastructure"]["turnWal"];

  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly scheduleTurnTtlMs: number;
  private readonly compactAfterMs: number;
  private readonly recordEvent?:
    | ((input: { sessionId: string; type: string; payload?: Record<string, unknown> }) => void)
    | undefined;
  private readonly cacheByFilePath = new Map<string, TurnWALFileCache>();
  private fileHasContent: boolean | null = null;

  constructor(options: TurnWALStoreOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.config = { ...options.config };
    this.scope = sanitizeScopeId(options.scope);
    this.enabled = options.config.enabled;
    this.now = options.now ?? (() => Date.now());
    this.defaultTtlMs = Math.max(1, Math.floor(options.config.defaultTtlMs));
    this.scheduleTurnTtlMs = Math.max(1, Math.floor(options.config.scheduleTurnTtlMs));
    this.compactAfterMs = Math.max(1, Math.floor(options.config.compactAfterMs));
    this.recordEvent = options.recordEvent;
    const walDir = resolve(this.workspaceRoot, options.config.dir);
    this.filePath = resolve(walDir, `${this.scope}.jsonl`);
    if (this.enabled) {
      ensureDir(walDir);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  appendPending(
    envelope: TurnEnvelope,
    source: TurnWALSource,
    options: TurnWALAppendPendingOptions = {},
  ): TurnWALRecord {
    const timestamp = this.now();
    const turnId = normalizeOptionalString(envelope.turnId) ?? `turn_${timestamp}_${randomUUID()}`;
    const sessionId = normalizeOptionalString(envelope.sessionId) ?? "unknown";
    const channel = normalizeOptionalString(envelope.channel) ?? "unknown";
    const conversationId = normalizeOptionalString(envelope.conversationId) ?? "unknown";
    const dedupeKey = normalizeOptionalString(options.dedupeKey);
    const ttlMs = this.resolveTtlMs(source, options.ttlMs);

    const row: TurnWALRecord = {
      schema: "brewva.turn-wal.v1",
      walId: `wal_${timestamp}_${randomUUID()}`,
      turnId,
      sessionId,
      channel,
      conversationId,
      status: "pending",
      envelope: structuredClone(envelope),
      createdAt: timestamp,
      updatedAt: timestamp,
      attempts: 0,
      source,
      ttlMs,
      dedupeKey,
    };

    if (this.enabled) {
      this.appendRecord(row);
    }
    this.emitAppended(row);
    return cloneTurnWALRecord(row);
  }

  markInflight(walId: string): TurnWALRecord | undefined {
    return this.transitionStatus(walId, "inflight", {
      attemptsDelta: 1,
    });
  }

  markDone(walId: string): TurnWALRecord | undefined {
    return this.transitionStatus(walId, "done");
  }

  markFailed(walId: string, error?: string): TurnWALRecord | undefined {
    return this.transitionStatus(walId, "failed", {
      error: normalizeOptionalString(error),
    });
  }

  markExpired(walId: string): TurnWALRecord | undefined {
    return this.transitionStatus(walId, "expired");
  }

  listPending(): TurnWALRecord[] {
    if (!this.enabled) return [];
    const rows = [...this.syncCache().rowsByWalId.values()]
      .filter((row) => RECOVERABLE_STATUSES.has(row.status))
      .toSorted(compareByCreatedAt);
    return rows.map((row) => cloneTurnWALRecord(row));
  }

  listCurrent(): TurnWALRecord[] {
    if (!this.enabled) return [];
    return [...this.syncCache().rowsByWalId.values()]
      .toSorted(compareByCreatedAt)
      .map((row) => cloneTurnWALRecord(row));
  }

  compact(): TurnWALCompactResult {
    if (!this.enabled) {
      return {
        scope: this.scope,
        filePath: this.filePath,
        scanned: 0,
        retained: 0,
        dropped: 0,
      };
    }

    const now = this.now();
    const current = [...this.syncCache().rowsByWalId.values()].toSorted(compareByCreatedAt);
    const retained = current.filter((row) => {
      if (!TERMINAL_STATUSES.has(row.status)) return true;
      return row.updatedAt + this.compactAfterMs > now;
    });
    const dropped = current.length - retained.length;
    const content =
      retained.length > 0 ? `${retained.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
    writeFileAtomic(this.filePath, content);

    const cache: TurnWALFileCache = {
      rowsByWalId: new Map(retained.map((row) => [row.walId, row])),
      byteOffset: Buffer.byteLength(content, "utf8"),
      trailingFragment: "",
    };
    this.cacheByFilePath.set(this.filePath, cache);
    this.fileHasContent = retained.length > 0;

    const result: TurnWALCompactResult = {
      scope: this.scope,
      filePath: this.filePath,
      scanned: current.length,
      retained: retained.length,
      dropped,
    };
    this.emitCompacted(result);
    return result;
  }

  static listScopeIds(input: { workspaceRoot: string; dir: string }): string[] {
    const root = resolve(input.workspaceRoot, input.dir);
    if (!existsSync(root)) return [];
    const scopes: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const scope = entry.name.slice(0, -".jsonl".length).trim();
      if (!scope) continue;
      scopes.push(scope);
    }
    return scopes.toSorted((left, right) => left.localeCompare(right));
  }

  private resolveTtlMs(source: TurnWALSource, overrideTtlMs: number | undefined): number {
    if (typeof overrideTtlMs === "number" && Number.isFinite(overrideTtlMs) && overrideTtlMs > 0) {
      return Math.floor(overrideTtlMs);
    }
    if (source === "schedule") return this.scheduleTurnTtlMs;
    return this.defaultTtlMs;
  }

  private transitionStatus(
    walId: string,
    status: TurnWALStatus,
    options: {
      attemptsDelta?: number;
      error?: string;
    } = {},
  ): TurnWALRecord | undefined {
    if (!this.enabled) return undefined;
    const current = this.syncCache().rowsByWalId.get(walId);
    if (!current) return undefined;
    const timestamp = this.now();
    const attemptsDelta =
      typeof options.attemptsDelta === "number" && Number.isFinite(options.attemptsDelta)
        ? Math.floor(options.attemptsDelta)
        : 0;
    const next: TurnWALRecord = {
      ...current,
      status,
      updatedAt: timestamp,
      attempts: Math.max(0, current.attempts + attemptsDelta),
    };

    if (status === "failed") {
      next.error = options.error ?? current.error ?? "turn_wal_failed";
    } else {
      delete next.error;
    }

    this.appendRecord(next);
    this.emitStatusChanged({
      previous: current,
      next,
    });
    return cloneTurnWALRecord(next);
  }

  private appendRecord(row: TurnWALRecord): void {
    const prefix = this.hasContent() ? "\n" : "";
    const serialized = JSON.stringify(row);
    const appended = `${prefix}${serialized}`;
    writeFileSync(this.filePath, appended, { flag: "a" });
    this.fileHasContent = true;
    this.trackAppendedRow(row, appended);
  }

  private hasContent(): boolean {
    if (this.fileHasContent !== null) {
      return this.fileHasContent;
    }
    if (!existsSync(this.filePath)) {
      this.fileHasContent = false;
      return false;
    }

    try {
      this.fileHasContent = statSync(this.filePath).size > 0;
    } catch {
      this.fileHasContent = false;
    }
    return this.fileHasContent;
  }

  private syncCache(): TurnWALFileCache {
    if (!existsSync(this.filePath)) {
      const empty: TurnWALFileCache = {
        rowsByWalId: new Map(),
        byteOffset: 0,
        trailingFragment: "",
      };
      this.cacheByFilePath.set(this.filePath, empty);
      this.fileHasContent = false;
      return empty;
    }

    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch {
      const empty: TurnWALFileCache = {
        rowsByWalId: new Map(),
        byteOffset: 0,
        trailingFragment: "",
      };
      this.cacheByFilePath.set(this.filePath, empty);
      this.fileHasContent = false;
      return empty;
    }

    this.fileHasContent = size > 0;
    const cached = this.cacheByFilePath.get(this.filePath);
    if (!cached || size < cached.byteOffset) {
      return this.rebuildCache(size);
    }
    if (size === cached.byteOffset) {
      return cached;
    }

    const appended = this.readTextRange(cached.byteOffset, size);
    this.consumeChunk(cached, appended);
    cached.byteOffset = size;
    return cached;
  }

  private rebuildCache(size: number): TurnWALFileCache {
    const cache: TurnWALFileCache = {
      rowsByWalId: new Map(),
      byteOffset: size,
      trailingFragment: "",
    };
    if (size > 0) {
      const text = readFileSync(this.filePath, "utf8");
      this.consumeChunk(cache, text);
    }
    this.cacheByFilePath.set(this.filePath, cache);
    return cache;
  }

  private readTextRange(fromOffset: number, toOffset: number): string {
    const length = Math.max(0, toOffset - fromOffset);
    if (length <= 0) return "";
    const fd = openSync(this.filePath, "r");
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

  private consumeChunk(cache: TurnWALFileCache, text: string): void {
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
      const parsed = parseTurnWALRecord(trimmed);
      if (parsed) {
        cache.rowsByWalId.set(parsed.walId, parsed);
        continue;
      }

      if (index === lines.length - 1) {
        cache.trailingFragment = raw;
      }
    }
  }

  private trackAppendedRow(row: TurnWALRecord, appended: string): void {
    const cached = this.cacheByFilePath.get(this.filePath);
    if (!cached) return;
    if (cached.trailingFragment) {
      this.cacheByFilePath.delete(this.filePath);
      return;
    }
    cached.rowsByWalId.set(row.walId, row);
    cached.byteOffset += Buffer.byteLength(appended, "utf8");
  }

  private emitAppended(record: TurnWALRecord): void {
    this.recordEvent?.({
      sessionId: this.getSystemSessionId(),
      type: "turn_wal_appended",
      payload: {
        scope: this.scope,
        walId: record.walId,
        turnId: record.turnId,
        sessionId: record.sessionId,
        channel: record.channel,
        conversationId: record.conversationId,
        source: record.source,
        status: record.status,
        attempts: record.attempts,
      },
    });
  }

  private emitStatusChanged(input: { previous: TurnWALRecord; next: TurnWALRecord }): void {
    this.recordEvent?.({
      sessionId: this.getSystemSessionId(),
      type: "turn_wal_status_changed",
      payload: {
        scope: this.scope,
        walId: input.next.walId,
        turnId: input.next.turnId,
        from: input.previous.status,
        to: input.next.status,
        attempts: input.next.attempts,
        error: input.next.error ?? null,
      },
    });
  }

  private emitCompacted(result: TurnWALCompactResult): void {
    this.recordEvent?.({
      sessionId: this.getSystemSessionId(),
      type: "turn_wal_compacted",
      payload: {
        scope: result.scope,
        scanned: result.scanned,
        retained: result.retained,
        dropped: result.dropped,
      },
    });
  }

  private getSystemSessionId(): string {
    return `turn_wal:${this.scope}`;
  }
}
