import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { normalizeAgentId } from "@brewva/brewva-runtime";

const REGISTRY_SCHEMA = "brewva.channel-agent-registry.v1";
const DEFAULT_AGENT_ID = "default";
const RESERVED_AGENT_IDS = new Set(["default", "all", "system"]);

export type ChannelAgentStatus = "active" | "deleted";

export interface ChannelAgentRecord {
  agentId: string;
  status: ChannelAgentStatus;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  lastActiveAt?: number;
  model?: string;
}

interface PersistedRegistryState {
  schema: typeof REGISTRY_SCHEMA;
  defaultAgentId: string;
  focusByScope: Record<string, string>;
  agents: Record<string, ChannelAgentRecord>;
}

export interface AgentListItem extends ChannelAgentRecord {
  isFocused: boolean;
}

export interface AgentRegistrySnapshot {
  defaultAgentId: string;
  focusedAgentId: string;
  agents: AgentListItem[];
}

export interface CreateAgentInput {
  requestedAgentId: string;
  model?: string;
  createdAt?: number;
}

export interface AgentRegistryOptions {
  workspaceRoot: string;
}

function buildInitialState(now: number): PersistedRegistryState {
  return {
    schema: REGISTRY_SCHEMA,
    defaultAgentId: DEFAULT_AGENT_ID,
    focusByScope: {},
    agents: {
      [DEFAULT_AGENT_ID]: {
        agentId: DEFAULT_AGENT_ID,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}

function toModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRegistryState(raw: unknown): PersistedRegistryState {
  const now = Date.now();
  const initial = buildInitialState(now);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return initial;
  }
  const candidate = raw as Record<string, unknown>;
  const focusByScopeRaw =
    candidate.focusByScope &&
    typeof candidate.focusByScope === "object" &&
    !Array.isArray(candidate.focusByScope)
      ? (candidate.focusByScope as Record<string, unknown>)
      : {};
  const agentsRaw =
    candidate.agents && typeof candidate.agents === "object" && !Array.isArray(candidate.agents)
      ? (candidate.agents as Record<string, unknown>)
      : {};

  const agents: Record<string, ChannelAgentRecord> = {};
  for (const [key, value] of Object.entries(agentsRaw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const agentId = normalizeAgentId(
      typeof record.agentId === "string"
        ? record.agentId
        : typeof key === "string"
          ? key
          : undefined,
    );
    if (!agentId) continue;
    const createdAt = Number.isFinite(record.createdAt)
      ? Math.floor(record.createdAt as number)
      : now;
    const updatedAt = Number.isFinite(record.updatedAt)
      ? Math.floor(record.updatedAt as number)
      : createdAt;
    const deletedAt = Number.isFinite(record.deletedAt)
      ? Math.floor(record.deletedAt as number)
      : undefined;
    const lastActiveAt = Number.isFinite(record.lastActiveAt)
      ? Math.floor(record.lastActiveAt as number)
      : undefined;
    const status = record.status === "deleted" ? "deleted" : "active";
    agents[agentId] = {
      agentId,
      status,
      createdAt,
      updatedAt,
      deletedAt,
      lastActiveAt,
      model: toModel(record.model),
    };
  }

  if (!agents[DEFAULT_AGENT_ID]) {
    agents[DEFAULT_AGENT_ID] = {
      agentId: DEFAULT_AGENT_ID,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
  } else if (agents[DEFAULT_AGENT_ID].status !== "active") {
    agents[DEFAULT_AGENT_ID] = {
      ...agents[DEFAULT_AGENT_ID],
      status: "active",
      deletedAt: undefined,
      updatedAt: now,
    };
  }

  const focusByScope: Record<string, string> = {};
  for (const [scopeKey, value] of Object.entries(focusByScopeRaw)) {
    if (typeof value !== "string") continue;
    const normalized = normalizeAgentId(value);
    if (normalized.length === 0) continue;
    focusByScope[scopeKey] = normalized;
  }

  return {
    schema: REGISTRY_SCHEMA,
    defaultAgentId: DEFAULT_AGENT_ID,
    focusByScope,
    agents,
  };
}

function normalizeRequestedAgentId(raw: string): string {
  return normalizeAgentId(raw);
}

function createIdentityScaffold(agentId: string): string {
  return [
    `# Agent: ${agentId}`,
    "",
    "## Purpose",
    "- Define this agent's role and decision boundary.",
    "",
    "## Constraints",
    "- Keep outputs deterministic and concise.",
    "",
  ].join("\n");
}

export class AgentRegistry {
  readonly workspaceRoot: string;
  readonly registryPath: string;

  private readonly agents = new Map<string, ChannelAgentRecord>();
  private readonly focusByScope = new Map<string, string>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: AgentRegistryOptions, state: PersistedRegistryState) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.registryPath = resolve(this.workspaceRoot, ".brewva", "channel", "agent-registry.json");
    for (const record of Object.values(state.agents)) {
      this.agents.set(record.agentId, { ...record });
    }
    for (const [scopeKey, agentId] of Object.entries(state.focusByScope)) {
      this.focusByScope.set(scopeKey, agentId);
    }
    this.repairFocusState();
  }

  static async create(options: AgentRegistryOptions): Promise<AgentRegistry> {
    const workspaceRoot = resolve(options.workspaceRoot);
    const registryPath = resolve(workspaceRoot, ".brewva", "channel", "agent-registry.json");
    let state = buildInitialState(Date.now());
    if (existsSync(registryPath)) {
      try {
        const raw = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
        state = normalizeRegistryState(raw);
      } catch {
        state = buildInitialState(Date.now());
      }
    }
    const registry = new AgentRegistry(options, state);
    await registry.persist();
    return registry;
  }

  get defaultAgentId(): string {
    return DEFAULT_AGENT_ID;
  }

  list(input: { includeDeleted?: boolean } = {}): ChannelAgentRecord[] {
    const includeDeleted = input.includeDeleted === true;
    return [...this.agents.values()]
      .filter((entry) => includeDeleted || entry.status === "active")
      .toSorted((a, b) => a.agentId.localeCompare(b.agentId))
      .map((entry) => Object.assign({}, entry));
  }

  get(agentId: string): ChannelAgentRecord | undefined {
    const normalized = normalizeRequestedAgentId(agentId);
    const record = this.agents.get(normalized);
    return record ? { ...record } : undefined;
  }

  isActive(agentId: string): boolean {
    const normalized = normalizeRequestedAgentId(agentId);
    return this.agents.get(normalized)?.status === "active";
  }

  getModel(agentId: string): string | undefined {
    return this.agents.get(normalizeRequestedAgentId(agentId))?.model;
  }

  resolveFocus(scopeKey: string): string {
    const focused = this.focusByScope.get(scopeKey);
    if (focused && this.isActive(focused)) {
      return focused;
    }
    this.focusByScope.delete(scopeKey);
    return DEFAULT_AGENT_ID;
  }

  async setFocus(scopeKey: string, requestedAgentId: string): Promise<string> {
    const agentId = normalizeRequestedAgentId(requestedAgentId);
    if (!this.isActive(agentId)) {
      throw new Error(`agent_not_found:${agentId}`);
    }
    this.focusByScope.set(scopeKey, agentId);
    await this.persist();
    return agentId;
  }

  async createAgent(input: CreateAgentInput): Promise<ChannelAgentRecord> {
    const createdAt = input.createdAt ?? Date.now();
    const agentId = normalizeRequestedAgentId(input.requestedAgentId);
    if (!agentId) {
      throw new Error("invalid_agent_id");
    }
    if (RESERVED_AGENT_IDS.has(agentId)) {
      throw new Error(`reserved_agent_id:${agentId}`);
    }

    await this.withWriteLock(async () => {
      await this.ensureAgentScaffold(agentId);
      const existing = this.agents.get(agentId);
      if (existing && existing.status === "active") {
        throw new Error(`agent_exists:${agentId}`);
      }
      const nextRecord: ChannelAgentRecord = existing
        ? {
            ...existing,
            status: "active",
            deletedAt: undefined,
            updatedAt: createdAt,
            model: toModel(input.model) ?? existing.model,
          }
        : {
            agentId,
            status: "active",
            createdAt,
            updatedAt: createdAt,
            model: toModel(input.model),
          };
      this.agents.set(agentId, nextRecord);
      await this.persistUnlocked();
    });

    return { ...(this.agents.get(agentId) as ChannelAgentRecord) };
  }

  async softDeleteAgent(requestedAgentId: string, deletedAt = Date.now()): Promise<void> {
    const agentId = normalizeRequestedAgentId(requestedAgentId);
    if (agentId === DEFAULT_AGENT_ID) {
      throw new Error("cannot_delete_default");
    }
    await this.withWriteLock(async () => {
      const existing = this.agents.get(agentId);
      if (!existing || existing.status === "deleted") {
        throw new Error(`agent_not_found:${agentId}`);
      }
      this.agents.set(agentId, {
        ...existing,
        status: "deleted",
        deletedAt,
        updatedAt: deletedAt,
      });
      for (const [scopeKey, focusedAgentId] of Array.from(this.focusByScope.entries())) {
        if (focusedAgentId === agentId) {
          this.focusByScope.delete(scopeKey);
        }
      }
      await this.persistUnlocked();
    });
  }

  async touchAgent(
    requestedAgentId: string,
    timestamp = Date.now(),
    persist = false,
  ): Promise<void> {
    const agentId = normalizeRequestedAgentId(requestedAgentId);
    const existing = this.agents.get(agentId);
    if (!existing || existing.status !== "active") return;
    existing.lastActiveAt = timestamp;
    existing.updatedAt = Math.max(existing.updatedAt, timestamp);
    if (persist) {
      await this.persist();
    }
  }

  snapshot(scopeKey: string, includeDeleted = false): AgentRegistrySnapshot {
    const focusedAgentId = this.resolveFocus(scopeKey);
    const agents = this.list({ includeDeleted }).map((entry) =>
      Object.assign({}, entry, {
        isFocused: entry.agentId === focusedAgentId,
      }),
    );
    return {
      defaultAgentId: DEFAULT_AGENT_ID,
      focusedAgentId,
      agents,
    };
  }

  private repairFocusState(): void {
    for (const [scopeKey, focusedAgentId] of Array.from(this.focusByScope.entries())) {
      if (!this.isActive(focusedAgentId)) {
        this.focusByScope.delete(scopeKey);
      }
    }
  }

  private serialize(): PersistedRegistryState {
    const agents: Record<string, ChannelAgentRecord> = {};
    for (const [agentId, record] of this.agents.entries()) {
      agents[agentId] = { ...record };
    }
    return {
      schema: REGISTRY_SCHEMA,
      defaultAgentId: DEFAULT_AGENT_ID,
      focusByScope: Object.fromEntries(this.focusByScope.entries()),
      agents,
    };
  }

  private async ensureAgentScaffold(agentId: string): Promise<void> {
    const agentRoot = resolve(this.workspaceRoot, ".brewva", "agents", agentId);
    await mkdir(agentRoot, { recursive: true });

    const identityPath = join(agentRoot, "identity.md");
    if (!existsSync(identityPath)) {
      await writeFile(identityPath, createIdentityScaffold(agentId), "utf8");
    }

    const configPath = join(agentRoot, "config.json");
    if (!existsSync(configPath)) {
      await writeFile(configPath, "{}\n", "utf8");
    }
  }

  private async persist(): Promise<void> {
    await this.withWriteLock(async () => {
      await this.persistUnlocked();
    });
  }

  private async persistUnlocked(): Promise<void> {
    const payload = `${JSON.stringify(this.serialize(), null, 2)}\n`;
    await mkdir(dirname(this.registryPath), { recursive: true });
    const tempPath = `${this.registryPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, this.registryPath);
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release: () => void = () => undefined;
    this.writeQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
