import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeAgentId } from "@brewva/brewva-runtime";

const ROUTING_SCHEMA = "brewva.channel-approval-routing.v1";
const DEFAULT_MAX_ENTRIES_PER_CONVERSATION = 2048;

export interface ApprovalRoutingRecordInput {
  conversationId: string;
  requestId: string;
  agentId?: string;
  agentSessionId?: string;
  turnId?: string;
  recordedAt?: number;
}

type ApprovalRoutingEntry = {
  agentId: string;
  recordedAt: number;
};

type PersistedApprovalRoutingState = {
  schema: typeof ROUTING_SCHEMA;
  updatedAt: number;
  conversations: Record<string, Record<string, ApprovalRoutingEntry>>;
};

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

function normalizeState(raw: unknown): PersistedApprovalRoutingState {
  const now = Date.now();
  const fallback: PersistedApprovalRoutingState = {
    schema: ROUTING_SCHEMA,
    updatedAt: now,
    conversations: {},
  };
  if (!isRecord(raw)) return fallback;
  const conversationsRaw = isRecord(raw.conversations) ? raw.conversations : {};
  const conversations: Record<string, Record<string, ApprovalRoutingEntry>> = {};
  for (const [conversationId, requestMapRaw] of Object.entries(conversationsRaw)) {
    if (!isRecord(requestMapRaw)) continue;
    const normalizedConversationId = normalizeToken(conversationId);
    if (!normalizedConversationId) continue;
    const requestMap: Record<string, ApprovalRoutingEntry> = {};
    for (const [requestId, entryRaw] of Object.entries(requestMapRaw)) {
      if (!isRecord(entryRaw)) continue;
      const normalizedRequestId = normalizeToken(requestId);
      if (!normalizedRequestId) continue;
      const rawAgentId = normalizeToken(entryRaw.agentId);
      if (!rawAgentId) continue;
      const agentId = normalizeAgentId(rawAgentId);
      requestMap[normalizedRequestId] = {
        agentId,
        recordedAt: normalizeTimestamp(entryRaw.recordedAt, now),
      };
    }
    if (Object.keys(requestMap).length > 0) {
      conversations[normalizedConversationId] = requestMap;
    }
  }
  return {
    schema: ROUTING_SCHEMA,
    updatedAt: normalizeTimestamp(raw.updatedAt, now),
    conversations,
  };
}

function pruneConversationMap(map: Map<string, ApprovalRoutingEntry>, maxEntries: number): void {
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

export class ApprovalRoutingStore {
  readonly workspaceRoot: string;
  readonly routingPath: string;

  private readonly maxEntriesPerConversation: number;
  private readonly conversations = new Map<string, Map<string, ApprovalRoutingEntry>>();

  private constructor(input: {
    workspaceRoot: string;
    maxEntriesPerConversation: number;
    state: PersistedApprovalRoutingState;
  }) {
    this.workspaceRoot = resolve(input.workspaceRoot);
    this.routingPath = resolve(this.workspaceRoot, ".brewva", "channel", "approval-routing.json");
    this.maxEntriesPerConversation = Math.max(1, Math.floor(input.maxEntriesPerConversation));

    for (const [conversationId, requestMap] of Object.entries(input.state.conversations)) {
      const inner = new Map<string, ApprovalRoutingEntry>();
      for (const [requestId, entry] of Object.entries(requestMap)) {
        inner.set(requestId, entry);
      }
      this.conversations.set(conversationId, inner);
    }
  }

  static create(options: {
    workspaceRoot: string;
    maxEntriesPerConversation?: number;
  }): ApprovalRoutingStore {
    const workspaceRoot = resolve(options.workspaceRoot);
    const routingPath = resolve(workspaceRoot, ".brewva", "channel", "approval-routing.json");
    let state: PersistedApprovalRoutingState = {
      schema: ROUTING_SCHEMA,
      updatedAt: Date.now(),
      conversations: {},
    };
    if (existsSync(routingPath)) {
      try {
        const raw = JSON.parse(readFileSync(routingPath, "utf8")) as unknown;
        state = normalizeState(raw);
      } catch {
        state = normalizeState({});
      }
    }
    return new ApprovalRoutingStore({
      workspaceRoot,
      maxEntriesPerConversation:
        options.maxEntriesPerConversation ?? DEFAULT_MAX_ENTRIES_PER_CONVERSATION,
      state,
    });
  }

  resolveAgentId(conversationId: string, requestId: string): string | undefined {
    const normalizedConversationId = normalizeToken(conversationId);
    const normalizedRequestId = normalizeToken(requestId);
    if (!normalizedConversationId || !normalizedRequestId) return undefined;
    return this.conversations.get(normalizedConversationId)?.get(normalizedRequestId)?.agentId;
  }

  record(input: ApprovalRoutingRecordInput): void {
    const normalizedConversationId = normalizeToken(input.conversationId);
    const normalizedRequestId = normalizeToken(input.requestId);
    const rawAgentId = normalizeToken(input.agentId);
    const normalizedAgentId = rawAgentId ? normalizeAgentId(rawAgentId) : "";
    if (!normalizedConversationId || !normalizedRequestId || !normalizedAgentId) {
      return;
    }

    const recordedAt = input.recordedAt ?? Date.now();
    const entry: ApprovalRoutingEntry = {
      agentId: normalizedAgentId,
      recordedAt,
    };
    const requestMap =
      this.conversations.get(normalizedConversationId) ?? new Map<string, ApprovalRoutingEntry>();
    requestMap.set(normalizedRequestId, entry);
    pruneConversationMap(requestMap, this.maxEntriesPerConversation);
    this.conversations.set(normalizedConversationId, requestMap);

    try {
      this.persist();
    } catch {
      // Best effort: do not throw during outbound turn rendering.
    }
  }

  private persist(): void {
    const conversations: PersistedApprovalRoutingState["conversations"] = {};
    for (const [conversationId, requestMap] of this.conversations.entries()) {
      conversations[conversationId] = Object.fromEntries(requestMap.entries());
    }
    const payload: PersistedApprovalRoutingState = {
      schema: ROUTING_SCHEMA,
      updatedAt: Date.now(),
      conversations,
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    mkdirSync(dirname(this.routingPath), { recursive: true });
    const tmpPath = `${this.routingPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, serialized, "utf8");
    renameSync(tmpPath, this.routingPath);
  }
}
