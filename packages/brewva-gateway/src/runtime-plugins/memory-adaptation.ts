import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  COGNITIVE_METRIC_REHYDRATION_USEFULNESS_EVENT_TYPE,
  MEMORY_ADAPTATION_UPDATE_FAILED_EVENT_TYPE,
  MEMORY_ADAPTATION_UPDATED_EVENT_TYPE,
  type BrewvaRuntime,
  type BrewvaStructuredEvent,
} from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { normalizeOptionalString } from "./context-shared.js";

export type MemoryHydrationStrategy =
  | "reference"
  | "procedure"
  | "episode"
  | "summary"
  | "open_loop";

export interface MemoryAdaptationStats {
  attempts: number;
  useful: number;
  useless: number;
  lastObservedAt: number | null;
  lastUsefulAt: number | null;
}

export interface MemoryAdaptationPacketStats extends MemoryAdaptationStats {
  strategy: MemoryHydrationStrategy;
  artifactRef: string | null;
}

export interface MemoryAdaptationPolicy {
  schema: "brewva.memory_adaptation_policy.v1";
  updatedAt: number;
  strategies: Record<MemoryHydrationStrategy, MemoryAdaptationStats>;
  packets: Record<string, MemoryAdaptationPacketStats>;
}

export interface MemoryAdaptationCandidate {
  strategy: MemoryHydrationStrategy;
  packetKey: string;
  baseScore: number;
}

export interface MemoryFormationGuidance {
  summary: {
    minSignalCount: number;
    requireResumeSignal: boolean;
  };
  episode: {
    minRecentEvents: number;
    requireAnchor: boolean;
  };
  procedure: {
    requireStableAnchor: boolean;
  };
}

interface RehydrationPacketObservation {
  kind: MemoryHydrationStrategy;
  packetKey: string | null;
  artifactRef: string | null;
}

interface RehydrationUsefulnessPayload {
  useful?: unknown;
  rehydrationKinds?: unknown;
  rehydrationPackets?: unknown;
}

interface MemoryAdaptationState {
  policy: MemoryAdaptationPolicy | null;
  loadPromise: Promise<MemoryAdaptationPolicy> | null;
  writePromise: Promise<void>;
}

const MEMORY_ADAPTATION_POLICY_SCHEMA = "brewva.memory_adaptation_policy.v1";
const MEMORY_ADAPTATION_MAX_PACKETS = 256;
// Packet-level observations are more specific than strategy-wide averages, so
// they intentionally influence ranking more strongly than the coarse strategy
// bias. Strategy bias still matters as a low-resolution fallback when a packet
// has little or no history.
const STRATEGY_BIAS_WEIGHT = 0.35;
const PACKET_BIAS_WEIGHT = 0.85;
const adaptationStateByWorkspace = new Map<string, MemoryAdaptationState>();

function createEmptyStats(): MemoryAdaptationStats {
  return {
    attempts: 0,
    useful: 0,
    useless: 0,
    lastObservedAt: null,
    lastUsefulAt: null,
  };
}

export function createEmptyMemoryAdaptationPolicy(now = Date.now()): MemoryAdaptationPolicy {
  return {
    schema: MEMORY_ADAPTATION_POLICY_SCHEMA,
    updatedAt: now,
    strategies: {
      reference: createEmptyStats(),
      procedure: createEmptyStats(),
      episode: createEmptyStats(),
      summary: createEmptyStats(),
      open_loop: createEmptyStats(),
    },
    packets: {},
  };
}

function clonePolicy(policy: MemoryAdaptationPolicy): MemoryAdaptationPolicy {
  return structuredClone(policy);
}

function resolveMemoryAdaptationState(workspaceRoot: string): MemoryAdaptationState {
  const existing = adaptationStateByWorkspace.get(workspaceRoot);
  if (existing) {
    return existing;
  }
  const created: MemoryAdaptationState = {
    policy: null,
    loadPromise: null,
    writePromise: Promise.resolve(),
  };
  adaptationStateByWorkspace.set(workspaceRoot, created);
  return created;
}

export function resolveMemoryAdaptationPolicyPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".brewva", "cognition", "adaptation.json");
}

function isMemoryHydrationStrategy(value: unknown): value is MemoryHydrationStrategy {
  return (
    value === "reference" ||
    value === "procedure" ||
    value === "episode" ||
    value === "summary" ||
    value === "open_loop"
  );
}

function coerceStats(value: unknown): MemoryAdaptationStats {
  if (!value || typeof value !== "object") {
    return createEmptyStats();
  }
  const source = value as Partial<MemoryAdaptationStats>;
  return {
    attempts: Number.isFinite(source.attempts) ? Math.max(0, Math.floor(source.attempts ?? 0)) : 0,
    useful: Number.isFinite(source.useful) ? Math.max(0, Math.floor(source.useful ?? 0)) : 0,
    useless: Number.isFinite(source.useless) ? Math.max(0, Math.floor(source.useless ?? 0)) : 0,
    lastObservedAt:
      Number.isFinite(source.lastObservedAt) && typeof source.lastObservedAt === "number"
        ? source.lastObservedAt
        : null,
    lastUsefulAt:
      Number.isFinite(source.lastUsefulAt) && typeof source.lastUsefulAt === "number"
        ? source.lastUsefulAt
        : null,
  };
}

function parseMemoryAdaptationPolicy(raw: string): MemoryAdaptationPolicy {
  const parsed = JSON.parse(raw) as Partial<MemoryAdaptationPolicy> | null;
  if (!parsed || typeof parsed !== "object" || parsed.schema !== MEMORY_ADAPTATION_POLICY_SCHEMA) {
    return createEmptyMemoryAdaptationPolicy();
  }

  const packets: Record<string, MemoryAdaptationPacketStats> = {};
  for (const [packetKey, value] of Object.entries(parsed.packets ?? {})) {
    if (!packetKey || typeof packetKey !== "string") continue;
    if (!value || typeof value !== "object") continue;
    const packet = value as Partial<MemoryAdaptationPacketStats>;
    if (!isMemoryHydrationStrategy(packet.strategy)) continue;
    packets[packetKey] = {
      strategy: packet.strategy,
      artifactRef: normalizeOptionalString(packet.artifactRef),
      ...coerceStats(packet),
    };
  }

  return {
    schema: MEMORY_ADAPTATION_POLICY_SCHEMA,
    updatedAt:
      typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : Date.now(),
    strategies: {
      reference: coerceStats(parsed.strategies?.reference),
      procedure: coerceStats(parsed.strategies?.procedure),
      episode: coerceStats(parsed.strategies?.episode),
      summary: coerceStats(parsed.strategies?.summary),
      open_loop: coerceStats(parsed.strategies?.open_loop),
    },
    packets,
  };
}

async function loadMemoryAdaptationPolicyInternal(
  workspaceRoot: string,
): Promise<MemoryAdaptationPolicy> {
  const path = resolveMemoryAdaptationPolicyPath(workspaceRoot);
  try {
    return parseMemoryAdaptationPolicy(await readFile(path, "utf8"));
  } catch {
    // Adaptation is control-plane bias, not authority. Corrupt or missing local
    // policy should degrade to an empty policy instead of blocking sessions.
    return createEmptyMemoryAdaptationPolicy();
  }
}

export async function readMemoryAdaptationPolicy(
  workspaceRoot: string,
): Promise<MemoryAdaptationPolicy> {
  const state = resolveMemoryAdaptationState(workspaceRoot);
  if (state.policy) {
    return clonePolicy(state.policy);
  }
  if (!state.loadPromise) {
    state.loadPromise = loadMemoryAdaptationPolicyInternal(workspaceRoot)
      .then((policy) => {
        state.policy = policy;
        state.loadPromise = null;
        return policy;
      })
      .catch((error) => {
        state.loadPromise = null;
        throw error;
      });
  }
  return clonePolicy(await state.loadPromise);
}

async function persistMemoryAdaptationPolicy(
  workspaceRoot: string,
  policy: MemoryAdaptationPolicy,
): Promise<void> {
  const path = resolveMemoryAdaptationPolicyPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
}

function collectPacketObservations(
  payload: RehydrationUsefulnessPayload,
): RehydrationPacketObservation[] {
  if (Array.isArray(payload.rehydrationPackets)) {
    const observations: RehydrationPacketObservation[] = [];
    for (const entry of payload.rehydrationPackets) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      if (!isMemoryHydrationStrategy(row.kind)) continue;
      observations.push({
        kind: row.kind,
        packetKey: normalizeOptionalString(row.packetKey),
        artifactRef: normalizeOptionalString(row.artifactRef),
      });
    }
    if (observations.length > 0) {
      return observations;
    }
  }

  if (!Array.isArray(payload.rehydrationKinds)) {
    return [];
  }
  const fallback: RehydrationPacketObservation[] = [];
  for (const entry of payload.rehydrationKinds) {
    if (!isMemoryHydrationStrategy(entry)) continue;
    fallback.push({
      kind: entry,
      packetKey: null,
      artifactRef: null,
    });
  }
  return fallback;
}

function observeStats(stats: MemoryAdaptationStats, useful: boolean, now: number): void {
  stats.attempts += 1;
  stats.lastObservedAt = now;
  if (useful) {
    stats.useful += 1;
    stats.lastUsefulAt = now;
    return;
  }
  stats.useless += 1;
}

function prunePacketStats(policy: MemoryAdaptationPolicy): void {
  const entries = Object.entries(policy.packets);
  if (entries.length <= MEMORY_ADAPTATION_MAX_PACKETS) {
    return;
  }
  entries
    .toSorted((left, right) => {
      const leftObserved = left[1].lastObservedAt ?? 0;
      const rightObserved = right[1].lastObservedAt ?? 0;
      if (leftObserved !== rightObserved) {
        return leftObserved - rightObserved;
      }
      if (left[1].attempts !== right[1].attempts) {
        return left[1].attempts - right[1].attempts;
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, entries.length - MEMORY_ADAPTATION_MAX_PACKETS)
    .forEach(([packetKey]) => {
      delete policy.packets[packetKey];
    });
}

function applyUsefulnessObservation(
  policy: MemoryAdaptationPolicy,
  payload: RehydrationUsefulnessPayload,
  timestamp: number,
): {
  updated: boolean;
  observedStrategies: MemoryHydrationStrategy[];
  observedPackets: string[];
  useful: boolean;
} {
  const packetObservations = collectPacketObservations(payload);
  const useful = payload.useful === true;
  if (packetObservations.length === 0) {
    return {
      updated: false,
      observedStrategies: [],
      observedPackets: [],
      useful,
    };
  }

  const observedStrategies = new Set<MemoryHydrationStrategy>();
  const observedPackets: string[] = [];
  for (const observation of packetObservations) {
    observedStrategies.add(observation.kind);
    observeStats(policy.strategies[observation.kind], useful, timestamp);
    if (!observation.packetKey) {
      continue;
    }
    const packetStats = policy.packets[observation.packetKey] ?? {
      strategy: observation.kind,
      artifactRef: observation.artifactRef,
      ...createEmptyStats(),
    };
    packetStats.strategy = observation.kind;
    packetStats.artifactRef = observation.artifactRef ?? packetStats.artifactRef;
    observeStats(packetStats, useful, timestamp);
    policy.packets[observation.packetKey] = packetStats;
    observedPackets.push(observation.packetKey);
  }

  policy.updatedAt = timestamp;
  prunePacketStats(policy);
  return {
    updated: true,
    observedStrategies: [...observedStrategies],
    observedPackets,
    useful,
  };
}

function computeAdaptationBias(stats: MemoryAdaptationStats | undefined): number {
  if (!stats || stats.attempts <= 0) {
    return 0;
  }
  const usefulRate = (stats.useful + 1) / (stats.attempts + 2);
  const confidence = Math.min(1, stats.attempts / 6);
  return (usefulRate - 0.5) * confidence;
}

export function rankMemoryHydrationCandidates<T extends MemoryAdaptationCandidate>(
  candidates: T[],
  policy: MemoryAdaptationPolicy,
): T[] {
  return [...candidates].toSorted((left, right) => {
    const leftStrategyBias = computeAdaptationBias(policy.strategies[left.strategy]);
    const rightStrategyBias = computeAdaptationBias(policy.strategies[right.strategy]);
    const leftPacketBias = computeAdaptationBias(policy.packets[left.packetKey]);
    const rightPacketBias = computeAdaptationBias(policy.packets[right.packetKey]);
    const leftScore =
      left.baseScore +
      leftStrategyBias * STRATEGY_BIAS_WEIGHT +
      leftPacketBias * PACKET_BIAS_WEIGHT;
    const rightScore =
      right.baseScore +
      rightStrategyBias * STRATEGY_BIAS_WEIGHT +
      rightPacketBias * PACKET_BIAS_WEIGHT;
    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }
    if (right.baseScore !== left.baseScore) {
      return right.baseScore - left.baseScore;
    }
    return left.packetKey.localeCompare(right.packetKey);
  });
}

export function deriveMemoryFormationGuidance(
  policy: MemoryAdaptationPolicy,
): MemoryFormationGuidance {
  const summaryBias = computeAdaptationBias(policy.strategies.summary);
  const episodeBias = computeAdaptationBias(policy.strategies.episode);
  const procedureBias = computeAdaptationBias(policy.strategies.procedure);

  return {
    summary: {
      minSignalCount: summaryBias < -0.08 ? 2 : 1,
      requireResumeSignal: summaryBias < -0.12,
    },
    episode: {
      minRecentEvents: episodeBias < -0.08 ? 2 : 1,
      requireAnchor: episodeBias < -0.12,
    },
    procedure: {
      requireStableAnchor: procedureBias < -0.08,
    },
  };
}

async function applyAdaptationObservation(
  runtime: BrewvaRuntime,
  event: BrewvaStructuredEvent,
): Promise<void> {
  const state = resolveMemoryAdaptationState(runtime.workspaceRoot);
  const currentPolicy = await readMemoryAdaptationPolicy(runtime.workspaceRoot);
  const nextPolicy = clonePolicy(currentPolicy);
  const result = applyUsefulnessObservation(
    nextPolicy,
    (event.payload ?? {}) as RehydrationUsefulnessPayload,
    event.timestamp,
  );

  if (!result.updated) {
    return;
  }

  state.policy = nextPolicy;
  try {
    await persistMemoryAdaptationPolicy(runtime.workspaceRoot, nextPolicy);
    runtime.events.record({
      sessionId: event.sessionId,
      type: MEMORY_ADAPTATION_UPDATED_EVENT_TYPE,
      turn: event.turn,
      payload: {
        useful: result.useful,
        observedStrategies: result.observedStrategies,
        observedPackets: result.observedPackets,
        adaptationPath: resolveMemoryAdaptationPolicyPath(runtime.workspaceRoot),
      },
    });
  } catch (error) {
    runtime.events.record({
      sessionId: event.sessionId,
      type: MEMORY_ADAPTATION_UPDATE_FAILED_EVENT_TYPE,
      turn: event.turn,
      payload: {
        useful: result.useful,
        observedStrategies: result.observedStrategies,
        observedPackets: result.observedPackets,
        adaptationPath: resolveMemoryAdaptationPolicyPath(runtime.workspaceRoot),
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function queueAdaptationObservation(runtime: BrewvaRuntime, event: BrewvaStructuredEvent): void {
  const state = resolveMemoryAdaptationState(runtime.workspaceRoot);
  state.writePromise = state.writePromise
    .then(() => applyAdaptationObservation(runtime, event))
    .catch((error) => {
      runtime.events.record({
        sessionId: event.sessionId,
        type: MEMORY_ADAPTATION_UPDATE_FAILED_EVENT_TYPE,
        turn: event.turn,
        payload: {
          adaptationPath: resolveMemoryAdaptationPolicyPath(runtime.workspaceRoot),
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      return undefined;
    });
}

export async function flushMemoryAdaptationPolicy(workspaceRoot: string): Promise<void> {
  const state = resolveMemoryAdaptationState(workspaceRoot);
  await state.writePromise;
}

export function registerMemoryAdaptation(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  runtime.events.subscribe((event) => {
    if (event.type !== COGNITIVE_METRIC_REHYDRATION_USEFULNESS_EVENT_TYPE) {
      return;
    }
    queueAdaptationObservation(runtime, event);
  });

  pi.on("before_agent_start", async () => {
    await readMemoryAdaptationPolicy(runtime.workspaceRoot);
    return undefined;
  });

  pi.on("session_shutdown", async () => {
    await flushMemoryAdaptationPolicy(runtime.workspaceRoot);
    return undefined;
  });
}
