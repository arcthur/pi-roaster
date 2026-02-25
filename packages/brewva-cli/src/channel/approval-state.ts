import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const STATE_SCHEMA_V1 = "brewva.channel-approval-state.v1";
const STATE_SCHEMA_V2 = "brewva.channel-approval-state.v2";
const STATE_BLOB_SCHEMA = "brewva.channel-approval-state-blob.v1";
const DEFAULT_MAX_ENTRIES_PER_CONVERSATION = 2048;
const STATE_KEY_MAX_LENGTH = 64;

export interface ApprovalStateSnapshot {
  screenId?: string;
  stateKey?: string;
  state?: unknown;
}

export interface ApprovalStateRecordInput {
  conversationId: string;
  requestId: string;
  snapshot: ApprovalStateSnapshot;
  recordedAt?: number;
}

export interface ApprovalStateResolveInput {
  conversationId: string;
  requestId: string;
  actionId?: string;
}

type PersistedApprovalStateEntry = {
  recordedAt: number;
  snapshot: ApprovalStateSnapshot;
};

type PersistedApprovalStateState = {
  schema: typeof STATE_SCHEMA_V1 | typeof STATE_SCHEMA_V2;
  updatedAt: number;
  conversations: Record<string, Record<string, PersistedApprovalStateEntry>>;
};

type PersistedApprovalStateBlob = {
  schema: typeof STATE_BLOB_SCHEMA;
  recordedAt: number;
  updatedAt: number;
  conversationId: string;
  requestId: string;
  screenId?: string;
  stateKey: string;
  state: unknown;
};

type ApprovalStateBlobLookupResult = { found: true; state: unknown } | { found: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStateKey(value: unknown): string | undefined {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return undefined;
  const candidate = normalized.toLowerCase();
  if (candidate.length > STATE_KEY_MAX_LENGTH) return undefined;
  if (!/^[a-z0-9_-]+$/.test(candidate)) return undefined;
  return candidate;
}

function computeStateKey(input: { conversationId: string; requestId: string }): string {
  const digest = createHash("sha256")
    .update(`${input.conversationId}:${input.requestId}`)
    .digest("hex")
    .slice(0, 12);
  return `st_${digest}`;
}

function normalizeSnapshot(raw: unknown): ApprovalStateSnapshot | null {
  if (!isRecord(raw)) return null;
  const screenId = normalizeOptionalText(raw.screenId ?? raw.screen_id);
  const stateKey = normalizeStateKey(raw.stateKey ?? raw.state_key);
  const state =
    Object.prototype.hasOwnProperty.call(raw, "state") && raw.state !== undefined
      ? raw.state
      : undefined;

  if (!screenId && !stateKey && state === undefined) {
    return null;
  }
  return {
    ...(screenId ? { screenId } : {}),
    ...(stateKey ? { stateKey } : {}),
    ...(state !== undefined ? { state } : {}),
  };
}

function normalizeState(raw: unknown): PersistedApprovalStateState {
  const now = Date.now();
  const fallback: PersistedApprovalStateState = {
    schema: STATE_SCHEMA_V2,
    updatedAt: now,
    conversations: {},
  };
  if (!isRecord(raw)) return fallback;
  const conversationsRaw = isRecord(raw.conversations) ? raw.conversations : {};
  const conversations: PersistedApprovalStateState["conversations"] = {};
  for (const [conversationId, requestMapRaw] of Object.entries(conversationsRaw)) {
    if (!isRecord(requestMapRaw)) continue;
    const normalizedConversationId = normalizeToken(conversationId);
    if (!normalizedConversationId) continue;
    const requestMap: Record<string, PersistedApprovalStateEntry> = {};
    for (const [requestId, entryRaw] of Object.entries(requestMapRaw)) {
      if (!isRecord(entryRaw)) continue;
      const normalizedRequestId = normalizeToken(requestId);
      if (!normalizedRequestId) continue;
      const snapshot = normalizeSnapshot(entryRaw.snapshot);
      if (!snapshot) continue;
      if (!snapshot.stateKey && snapshot.state !== undefined) {
        snapshot.stateKey = computeStateKey({
          conversationId: normalizedConversationId,
          requestId: normalizedRequestId,
        });
      }
      requestMap[normalizedRequestId] = {
        recordedAt: normalizeTimestamp(entryRaw.recordedAt, now),
        snapshot,
      };
    }
    if (Object.keys(requestMap).length > 0) {
      conversations[normalizedConversationId] = requestMap;
    }
  }
  return {
    schema: STATE_SCHEMA_V2,
    updatedAt: normalizeTimestamp(raw.updatedAt, now),
    conversations,
  };
}

function pruneConversationMap(
  map: Map<string, PersistedApprovalStateEntry>,
  maxEntries: number,
): void {
  if (map.size <= maxEntries) return;
  const sorted = [...map.entries()].toSorted((a, b) => {
    const at = a[1].recordedAt;
    const bt = b[1].recordedAt;
    return at - bt || a[0].localeCompare(b[0]);
  });
  const dropCount = Math.max(0, sorted.length - maxEntries);
  for (const [requestId] of sorted.slice(0, dropCount)) {
    map.delete(requestId);
  }
}

export class ApprovalStateStore {
  readonly workspaceRoot: string;
  readonly statePath: string;
  readonly stateDir: string;

  private readonly maxEntriesPerConversation: number;
  private readonly conversations = new Map<string, Map<string, PersistedApprovalStateEntry>>();

  private constructor(input: {
    workspaceRoot: string;
    maxEntriesPerConversation: number;
    state: PersistedApprovalStateState;
  }) {
    this.workspaceRoot = resolve(input.workspaceRoot);
    this.statePath = resolve(this.workspaceRoot, ".brewva", "channel", "approval-state.json");
    this.stateDir = resolve(this.workspaceRoot, ".brewva", "channel", "approval-state");
    this.maxEntriesPerConversation = Math.max(1, Math.floor(input.maxEntriesPerConversation));

    let needsPersist = false;
    for (const [conversationId, requestMap] of Object.entries(input.state.conversations)) {
      const inner = new Map<string, PersistedApprovalStateEntry>();
      for (const [requestId, entry] of Object.entries(requestMap)) {
        const snapshot = entry.snapshot;
        const screenId = snapshot.screenId;
        const stateKey = snapshot.stateKey;
        let storedSnapshot: ApprovalStateSnapshot = {
          ...(screenId ? { screenId } : {}),
          ...(stateKey ? { stateKey } : {}),
        };

        if (snapshot.state !== undefined) {
          needsPersist = true;
          if (stateKey) {
            const persisted = this.writeBlob({
              conversationId,
              requestId,
              recordedAt: entry.recordedAt,
              snapshot: {
                ...(screenId ? { screenId } : {}),
                stateKey,
                state: snapshot.state,
              },
            });
            if (persisted) {
              // Drop state from index once blob is safely persisted.
              storedSnapshot = {
                ...(screenId ? { screenId } : {}),
                ...(stateKey ? { stateKey } : {}),
              };
            } else {
              storedSnapshot = {
                ...(screenId ? { screenId } : {}),
                ...(stateKey ? { stateKey } : {}),
                state: snapshot.state,
              };
            }
          } else {
            storedSnapshot = {
              ...(screenId ? { screenId } : {}),
              state: snapshot.state,
            };
          }
        }

        inner.set(requestId, {
          recordedAt: entry.recordedAt,
          snapshot: storedSnapshot,
        });
      }
      this.conversations.set(conversationId, inner);
    }

    if (needsPersist) {
      try {
        this.persist();
      } catch {
        // Best effort migration; avoid failing channel-mode startup.
      }
    }
  }

  static create(options: {
    workspaceRoot: string;
    maxEntriesPerConversation?: number;
  }): ApprovalStateStore {
    const workspaceRoot = resolve(options.workspaceRoot);
    const statePath = resolve(workspaceRoot, ".brewva", "channel", "approval-state.json");
    let state: PersistedApprovalStateState = {
      schema: STATE_SCHEMA_V2,
      updatedAt: Date.now(),
      conversations: {},
    };
    if (existsSync(statePath)) {
      try {
        const raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
        state = normalizeState(raw);
      } catch {
        state = normalizeState({});
      }
    }
    return new ApprovalStateStore({
      workspaceRoot,
      maxEntriesPerConversation:
        options.maxEntriesPerConversation ?? DEFAULT_MAX_ENTRIES_PER_CONVERSATION,
      state,
    });
  }

  resolve(input: ApprovalStateResolveInput): ApprovalStateSnapshot | undefined {
    const normalizedConversationId = normalizeToken(input.conversationId);
    const normalizedRequestId = normalizeToken(input.requestId);
    if (!normalizedConversationId || !normalizedRequestId) return undefined;
    const entry = this.conversations.get(normalizedConversationId)?.get(normalizedRequestId);
    if (!entry) return undefined;

    // Touch LRU on resolve so active flows are less likely to be pruned.
    const next: PersistedApprovalStateEntry = {
      recordedAt: Date.now(),
      snapshot: entry.snapshot,
    };
    this.conversations.get(normalizedConversationId)?.set(normalizedRequestId, next);
    try {
      this.persist();
    } catch {
      // Best effort resolve touch; don't throw while projecting callback turn.
    }
    if (!entry.snapshot.stateKey) {
      return entry.snapshot;
    }

    const lookup = this.readBlobState(entry.snapshot.stateKey);
    if (!lookup.found) {
      return entry.snapshot;
    }
    return {
      ...entry.snapshot,
      state: lookup.state,
    };
  }

  record(input: ApprovalStateRecordInput): {
    ok: boolean;
    snapshot?: ApprovalStateSnapshot;
    generatedStateKey?: boolean;
    storedState?: boolean;
  } {
    const normalizedConversationId = normalizeToken(input.conversationId);
    const normalizedRequestId = normalizeToken(input.requestId);
    if (!normalizedConversationId || !normalizedRequestId) return { ok: false };

    const snapshot = normalizeSnapshot(input.snapshot);
    if (!snapshot) return { ok: false };

    const existingStateKey = this.conversations
      .get(normalizedConversationId)
      ?.get(normalizedRequestId)?.snapshot.stateKey;
    let generatedStateKey = false;
    if (!snapshot.stateKey && existingStateKey) {
      snapshot.stateKey = existingStateKey;
    } else if (!snapshot.stateKey && snapshot.state !== undefined) {
      snapshot.stateKey = computeStateKey({
        conversationId: normalizedConversationId,
        requestId: normalizedRequestId,
      });
      generatedStateKey = true;
    } else if (snapshot.stateKey && existingStateKey && snapshot.stateKey !== existingStateKey) {
      snapshot.stateKey = existingStateKey;
    }

    const recordedAt = input.recordedAt ?? Date.now();
    let storedState = false;
    if (snapshot.stateKey && snapshot.state !== undefined) {
      storedState = this.writeBlob({
        conversationId: normalizedConversationId,
        requestId: normalizedRequestId,
        recordedAt,
        snapshot: {
          ...(snapshot.screenId ? { screenId: snapshot.screenId } : {}),
          stateKey: snapshot.stateKey,
          state: snapshot.state,
        },
      });
    }

    const entrySnapshot: ApprovalStateSnapshot = {
      ...(snapshot.screenId ? { screenId: snapshot.screenId } : {}),
      ...(snapshot.stateKey ? { stateKey: snapshot.stateKey } : {}),
      ...(snapshot.state !== undefined && !storedState ? { state: snapshot.state } : {}),
    };

    const entry: PersistedApprovalStateEntry = {
      recordedAt,
      snapshot: entrySnapshot,
    };
    const requestMap =
      this.conversations.get(normalizedConversationId) ??
      new Map<string, PersistedApprovalStateEntry>();
    requestMap.set(normalizedRequestId, entry);
    pruneConversationMap(requestMap, this.maxEntriesPerConversation);
    this.conversations.set(normalizedConversationId, requestMap);

    try {
      this.persist();
    } catch {
      // Best effort persistence; do not throw during outbound turn rendering.
    }
    return {
      ok: true,
      snapshot: entry.snapshot,
      ...(generatedStateKey ? { generatedStateKey } : {}),
      ...(storedState ? { storedState } : {}),
    };
  }

  private persist(): void {
    const conversations: PersistedApprovalStateState["conversations"] = {};
    for (const [conversationId, requestMap] of this.conversations.entries()) {
      conversations[conversationId] = Object.fromEntries(requestMap.entries());
    }
    const payload: PersistedApprovalStateState = {
      schema: STATE_SCHEMA_V2,
      updatedAt: Date.now(),
      conversations,
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmpPath = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, serialized, "utf8");
    renameSync(tmpPath, this.statePath);
  }

  private blobPath(stateKey: string): string {
    return resolve(this.stateDir, `${stateKey}.json`);
  }

  private readBlobState(stateKey: string): ApprovalStateBlobLookupResult {
    const normalizedStateKey = normalizeStateKey(stateKey);
    if (!normalizedStateKey) return { found: false };
    const blobPath = this.blobPath(normalizedStateKey);
    if (!existsSync(blobPath)) return { found: false };
    try {
      const raw = JSON.parse(readFileSync(blobPath, "utf8")) as unknown;
      if (!isRecord(raw)) return { found: false };
      if (!Object.prototype.hasOwnProperty.call(raw, "state")) return { found: false };
      return { found: true, state: raw.state };
    } catch {
      return { found: false };
    }
  }

  private writeBlob(input: {
    conversationId: string;
    requestId: string;
    recordedAt: number;
    snapshot: Required<Pick<ApprovalStateSnapshot, "stateKey" | "state">> &
      Pick<ApprovalStateSnapshot, "screenId">;
  }): boolean {
    const normalizedStateKey = normalizeStateKey(input.snapshot.stateKey);
    if (!normalizedStateKey) return false;

    const payload: PersistedApprovalStateBlob = {
      schema: STATE_BLOB_SCHEMA,
      recordedAt: input.recordedAt,
      updatedAt: Date.now(),
      conversationId: input.conversationId,
      requestId: input.requestId,
      ...(input.snapshot.screenId ? { screenId: input.snapshot.screenId } : {}),
      stateKey: normalizedStateKey,
      state: input.snapshot.state,
    };

    const blobPath = this.blobPath(normalizedStateKey);
    mkdirSync(dirname(blobPath), { recursive: true });
    const tmpPath = `${blobPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(tmpPath, blobPath);
      return true;
    } catch {
      try {
        // Clean up best-effort. Ignore failures.
        renameSync(tmpPath, `${tmpPath}.failed`);
      } catch {
        // ignore
      }
      return false;
    }
  }
}
