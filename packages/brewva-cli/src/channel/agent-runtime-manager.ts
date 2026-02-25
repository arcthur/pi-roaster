import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BrewvaRuntime, normalizeAgentId, type BrewvaConfig } from "@brewva/brewva-runtime";

export interface AgentRuntimeHandle {
  agentId: string;
  runtime: BrewvaRuntime;
  createdAt: number;
  lastUsedAt: number;
  sessionRefs: number;
}

export interface AgentRuntimeSummary {
  agentId: string;
  createdAt: number;
  lastUsedAt: number;
  sessionRefs: number;
}

export interface AgentRuntimeManagerOptions {
  controllerRuntime: BrewvaRuntime;
  maxLiveRuntimes: number;
  idleRuntimeTtlMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (!isRecord(base) || !isRecord(overlay)) {
    return overlay === undefined ? base : overlay;
  }
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = output[key];
    if (isRecord(existing) && isRecord(value)) {
      output[key] = deepMerge(existing, value);
      continue;
    }
    output[key] = value;
  }
  return output;
}

function forceNamespaceConfig(baseConfig: BrewvaConfig, agentId: string): BrewvaConfig {
  const stateRoot = `.brewva/agents/${agentId}/state`;
  return {
    ...baseConfig,
    ledger: {
      ...baseConfig.ledger,
      path: `${stateRoot}/ledger/evidence.jsonl`,
    },
    memory: {
      ...baseConfig.memory,
      dir: `${stateRoot}/memory`,
    },
    schedule: {
      ...baseConfig.schedule,
      enabled: false,
      projectionPath: `${stateRoot}/schedule/intents.jsonl`,
    },
    infrastructure: {
      ...baseConfig.infrastructure,
      events: {
        ...baseConfig.infrastructure.events,
        dir: `${stateRoot}/events`,
      },
      turnWal: {
        ...baseConfig.infrastructure.turnWal,
        dir: `${stateRoot}/turn-wal`,
      },
    },
  };
}

async function loadAgentConfigOverlay(workspaceRoot: string, agentId: string): Promise<unknown> {
  const path = resolve(workspaceRoot, ".brewva", "agents", agentId, "config.json");
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(
      `invalid_agent_config:${agentId}:${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export class AgentRuntimeManager {
  readonly workspaceRoot: string;
  readonly maxLiveRuntimes: number;
  readonly idleRuntimeTtlMs: number;

  private readonly controllerRuntime: BrewvaRuntime;
  private readonly handles = new Map<string, AgentRuntimeHandle>();
  private readonly creating = new Map<string, Promise<AgentRuntimeHandle>>();

  constructor(options: AgentRuntimeManagerOptions) {
    this.controllerRuntime = options.controllerRuntime;
    this.workspaceRoot = options.controllerRuntime.workspaceRoot;
    this.maxLiveRuntimes = Math.max(1, Math.floor(options.maxLiveRuntimes));
    this.idleRuntimeTtlMs = Math.max(1, Math.floor(options.idleRuntimeTtlMs));
  }

  listRuntimes(): AgentRuntimeSummary[] {
    return [...this.handles.values()]
      .map((entry) => ({
        agentId: entry.agentId,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
        sessionRefs: entry.sessionRefs,
      }))
      .toSorted((a, b) => b.lastUsedAt - a.lastUsedAt || a.agentId.localeCompare(b.agentId));
  }

  async getOrCreateRuntime(requestedAgentId: string): Promise<BrewvaRuntime> {
    const agentId = normalizeAgentId(requestedAgentId);
    const existing = this.handles.get(agentId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.runtime;
    }

    const pending = this.creating.get(agentId);
    if (pending) {
      const handle = await pending;
      handle.lastUsedAt = Date.now();
      return handle.runtime;
    }

    const creationTask = this.createRuntime(agentId);
    this.creating.set(agentId, creationTask);
    try {
      const handle = await creationTask;
      this.handles.set(agentId, handle);
      return handle.runtime;
    } finally {
      this.creating.delete(agentId);
    }
  }

  retainRuntime(requestedAgentId: string): void {
    const agentId = normalizeAgentId(requestedAgentId);
    const handle = this.handles.get(agentId);
    if (!handle) return;
    handle.sessionRefs += 1;
    handle.lastUsedAt = Date.now();
  }

  releaseRuntime(requestedAgentId: string): void {
    const agentId = normalizeAgentId(requestedAgentId);
    const handle = this.handles.get(agentId);
    if (!handle) return;
    handle.sessionRefs = Math.max(0, handle.sessionRefs - 1);
    handle.lastUsedAt = Date.now();
  }

  touchRuntime(requestedAgentId: string): void {
    const agentId = normalizeAgentId(requestedAgentId);
    const handle = this.handles.get(agentId);
    if (!handle) return;
    handle.lastUsedAt = Date.now();
  }

  evictIdleRuntimes(now = Date.now()): string[] {
    const evicted: string[] = [];
    for (const handle of Array.from(this.handles.values())) {
      if (handle.sessionRefs > 0) continue;
      if (now - handle.lastUsedAt < this.idleRuntimeTtlMs) continue;
      this.disposeHandle(handle);
      evicted.push(handle.agentId);
    }
    return evicted;
  }

  disposeRuntime(requestedAgentId: string): boolean {
    const agentId = normalizeAgentId(requestedAgentId);
    const handle = this.handles.get(agentId);
    if (!handle) return false;
    this.disposeHandle(handle);
    return true;
  }

  disposeAll(): void {
    for (const handle of Array.from(this.handles.values())) {
      this.disposeHandle(handle);
    }
  }

  private async createRuntime(agentId: string): Promise<AgentRuntimeHandle> {
    this.evictIdleRuntimes(Date.now());
    this.enforceCapacity();

    const baseConfig = structuredClone(this.controllerRuntime.config);
    const overlay = await loadAgentConfigOverlay(this.workspaceRoot, agentId);
    const merged = deepMerge(baseConfig, overlay) as BrewvaConfig;
    const config = forceNamespaceConfig(merged, agentId);
    const runtime = new BrewvaRuntime({
      cwd: this.controllerRuntime.cwd,
      agentId,
      config,
    });
    const now = Date.now();
    return {
      agentId,
      runtime,
      createdAt: now,
      lastUsedAt: now,
      sessionRefs: 0,
    };
  }

  private enforceCapacity(): void {
    if (this.handles.size < this.maxLiveRuntimes) return;

    const candidates = [...this.handles.values()]
      .filter((entry) => entry.sessionRefs === 0)
      .toSorted((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (this.handles.size >= this.maxLiveRuntimes && candidates.length > 0) {
      const candidate = candidates.shift();
      if (!candidate) break;
      this.disposeHandle(candidate);
    }

    if (this.handles.size >= this.maxLiveRuntimes) {
      throw new Error("runtime_capacity_exhausted");
    }
  }

  private disposeHandle(handle: AgentRuntimeHandle): void {
    this.handles.delete(handle.agentId);
  }
}

export function forceAgentRuntimeNamespace(
  baseConfig: BrewvaConfig,
  agentId: string,
): BrewvaConfig {
  return forceNamespaceConfig(baseConfig, normalizeAgentId(agentId));
}
