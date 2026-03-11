import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeChannelId } from "@brewva/brewva-runtime/channels";

const BINDING_SCHEMA = "brewva.conversation-bindings.v1";

interface ConversationBindingEntry {
  conversationKey: string;
  scopeId: string;
  channel: string;
  conversationId: string;
  threadId?: string;
  boundAt: number;
  updatedAt: number;
}

interface PersistedConversationBindingState {
  schema: typeof BINDING_SCHEMA;
  updatedAt: number;
  bindings: Record<string, ConversationBindingEntry>;
}

export interface EnsureConversationBindingInput {
  conversationKey: string;
  proposedScopeId: string;
  channel: string;
  conversationId: string;
  threadId?: string;
  now?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeChannel(value: unknown): string {
  const normalized = normalizeChannelId(typeof value === "string" ? value : "") ?? "";
  return normalized || normalizeToken(value).toLowerCase();
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeState(raw: unknown): PersistedConversationBindingState {
  const now = Date.now();
  const fallback: PersistedConversationBindingState = {
    schema: BINDING_SCHEMA,
    updatedAt: now,
    bindings: {},
  };
  if (!isRecord(raw)) {
    return fallback;
  }

  const bindingsRaw = isRecord(raw.bindings) ? raw.bindings : {};
  const bindings: Record<string, ConversationBindingEntry> = {};
  for (const [conversationKey, entryRaw] of Object.entries(bindingsRaw)) {
    if (!isRecord(entryRaw)) continue;
    const normalizedConversationKey = normalizeToken(conversationKey);
    const scopeId = normalizeToken(entryRaw.scopeId);
    const channel = normalizeChannel(entryRaw.channel);
    const conversationId = normalizeToken(entryRaw.conversationId);
    const threadId = normalizeToken(entryRaw.threadId) || undefined;
    if (!normalizedConversationKey || !scopeId || !channel || !conversationId) {
      continue;
    }
    bindings[normalizedConversationKey] = {
      conversationKey: normalizedConversationKey,
      scopeId,
      channel,
      conversationId,
      threadId,
      boundAt: normalizeTimestamp(entryRaw.boundAt, now),
      updatedAt: normalizeTimestamp(entryRaw.updatedAt, now),
    };
  }

  return {
    schema: BINDING_SCHEMA,
    updatedAt: normalizeTimestamp(raw.updatedAt, now),
    bindings,
  };
}

export class ConversationBindingStore {
  readonly workspaceRoot: string;
  readonly filePath: string;

  private readonly bindings = new Map<string, ConversationBindingEntry>();

  private constructor(workspaceRoot: string, state: PersistedConversationBindingState) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.filePath = resolve(this.workspaceRoot, ".brewva", "control", "conversations.json");
    for (const [conversationKey, entry] of Object.entries(state.bindings)) {
      this.bindings.set(conversationKey, entry);
    }
  }

  static create(options: { workspaceRoot: string }): ConversationBindingStore {
    const workspaceRoot = resolve(options.workspaceRoot);
    const filePath = resolve(workspaceRoot, ".brewva", "control", "conversations.json");
    let state: PersistedConversationBindingState = {
      schema: BINDING_SCHEMA,
      updatedAt: Date.now(),
      bindings: {},
    };
    if (existsSync(filePath)) {
      try {
        state = normalizeState(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
      } catch {
        state = normalizeState({});
      }
    }
    return new ConversationBindingStore(workspaceRoot, state);
  }

  resolveScopeId(conversationKey: string): string | undefined {
    const normalizedConversationKey = normalizeToken(conversationKey);
    if (!normalizedConversationKey) return undefined;
    return this.bindings.get(normalizedConversationKey)?.scopeId;
  }

  ensureBinding(input: EnsureConversationBindingInput): ConversationBindingEntry {
    const conversationKey = normalizeToken(input.conversationKey);
    const proposedScopeId = normalizeToken(input.proposedScopeId);
    const channel = normalizeChannel(input.channel);
    const conversationId = normalizeToken(input.conversationId);
    const threadId = normalizeToken(input.threadId) || undefined;
    if (!conversationKey || !proposedScopeId || !channel || !conversationId) {
      throw new Error(
        "conversation binding requires conversationKey, scopeId, channel, conversationId",
      );
    }

    const existing = this.bindings.get(conversationKey);
    if (existing) {
      return existing;
    }

    const now = input.now ?? Date.now();
    const next: ConversationBindingEntry = {
      conversationKey,
      scopeId: proposedScopeId,
      channel,
      conversationId,
      threadId,
      boundAt: now,
      updatedAt: now,
    };
    this.bindings.set(conversationKey, next);
    this.persist();
    return next;
  }

  private persist(): void {
    const filePath = resolve(this.workspaceRoot, ".brewva", "control", "conversations.json");
    const directory = dirname(filePath);
    mkdirSync(directory, { recursive: true });
    const payload: PersistedConversationBindingState = {
      schema: BINDING_SCHEMA,
      updatedAt: Date.now(),
      bindings: Object.fromEntries(this.bindings.entries()),
    };
    const tempPath = `${filePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tempPath, filePath);
  }
}
