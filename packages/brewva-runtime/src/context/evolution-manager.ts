import type {
  BrewvaConfig,
  BrewvaEventRecord,
  ContextRetirementMetricKey,
  ContextRetirementPolicy,
  ContextStrategyArm,
} from "../types.js";

export interface ContextEvolutionDecisionInput {
  sessionId: string;
  model: string;
  taskClass: string;
}

export interface ContextEvolutionFeatureTransition {
  feature: "stabilityMonitor" | "adaptiveZones";
  fromEnabled: boolean;
  toEnabled: boolean;
  metricKey: ContextRetirementMetricKey;
  metricValue: number;
  sampleSize: number;
}

export interface ContextEvolutionDecision {
  arm: ContextStrategyArm;
  armSource: "default";
  model: string;
  taskClass: string;
  adaptiveZonesEnabled: boolean;
  stabilityMonitorEnabled: boolean;
  transitions: ContextEvolutionFeatureTransition[];
}

interface RetirementState {
  disabled: boolean;
  lastCheckedAtMs: number;
  lastMetricValue: number;
  lastSampleSize: number;
}

interface MetricComputationResult {
  value: number;
  sampleSize: number;
}

interface SessionClassifier {
  model: string;
  taskClass: string;
}

const NONE_TASK_CLASS = "(none)";
const UNKNOWN_MODEL = "(unknown)";

function normalizeNonEmpty(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function parseWindowMs(metricKey: ContextRetirementMetricKey): number {
  if (metricKey.endsWith("_7d")) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  return 7 * 24 * 60 * 60 * 1000;
}

function toBucketKey(
  feature: "stabilityMonitor" | "adaptiveZones",
  model: string,
  taskClass: string,
): string {
  return `${feature}::${model}::${taskClass}`;
}

export class ContextEvolutionManager {
  private readonly config: BrewvaConfig["infrastructure"]["contextBudget"];
  private readonly listSessionIds: () => string[];
  private readonly listEvents: (sessionId: string) => BrewvaEventRecord[];
  private readonly now: () => number;
  private readonly retirementStates = new Map<string, RetirementState>();

  constructor(input: {
    config: BrewvaConfig["infrastructure"]["contextBudget"];
    listSessionIds: () => string[];
    listEvents: (sessionId: string) => BrewvaEventRecord[];
    now?: () => number;
  }) {
    this.config = input.config;
    this.listSessionIds = input.listSessionIds;
    this.listEvents = input.listEvents;
    this.now = input.now ?? Date.now;
  }

  resolve(input: ContextEvolutionDecisionInput): ContextEvolutionDecision {
    const model = normalizeNonEmpty(input.model, UNKNOWN_MODEL);
    const taskClass = normalizeNonEmpty(input.taskClass, NONE_TASK_CLASS);
    const transitions: ContextEvolutionFeatureTransition[] = [];

    const stabilityMonitorEnabled = this.resolveRetirementEnabled({
      feature: "stabilityMonitor",
      configuredEnabled: this.config.stabilityMonitor.enabled,
      policy: this.config.stabilityMonitor.retirement,
      model,
      taskClass,
      transitions,
    });
    const adaptiveZonesEnabled = this.resolveRetirementEnabled({
      feature: "adaptiveZones",
      configuredEnabled: this.config.adaptiveZones.enabled,
      policy: this.config.adaptiveZones.retirement,
      model,
      taskClass,
      transitions,
    });

    return {
      arm: "managed",
      armSource: "default",
      model,
      taskClass,
      adaptiveZonesEnabled,
      stabilityMonitorEnabled,
      transitions,
    };
  }

  private resolveRetirementEnabled(input: {
    feature: "stabilityMonitor" | "adaptiveZones";
    configuredEnabled: boolean;
    policy: ContextRetirementPolicy;
    model: string;
    taskClass: string;
    transitions: ContextEvolutionFeatureTransition[];
  }): boolean {
    if (!input.configuredEnabled) return false;
    if (!input.policy.enabled) return true;

    const now = this.now();
    const key = toBucketKey(input.feature, input.model, input.taskClass);
    const state = this.retirementStates.get(key) ?? {
      disabled: false,
      lastCheckedAtMs: 0,
      lastMetricValue: 0,
      lastSampleSize: 0,
    };

    const checkIntervalMs = Math.max(1, input.policy.checkIntervalHours) * 60 * 60 * 1000;
    if (state.lastCheckedAtMs > 0 && now - state.lastCheckedAtMs < checkIntervalMs) {
      return !state.disabled;
    }

    const metric = this.computeMetric(input.policy.metricKey, input.model, input.taskClass);
    state.lastCheckedAtMs = now;
    state.lastMetricValue = metric.value;
    state.lastSampleSize = metric.sampleSize;

    if (metric.sampleSize >= input.policy.minSamples) {
      if (!state.disabled && metric.value <= input.policy.disableBelow) {
        state.disabled = true;
        input.transitions.push({
          feature: input.feature,
          fromEnabled: true,
          toEnabled: false,
          metricKey: input.policy.metricKey,
          metricValue: metric.value,
          sampleSize: metric.sampleSize,
        });
      } else if (state.disabled && metric.value >= input.policy.reenableAbove) {
        state.disabled = false;
        input.transitions.push({
          feature: input.feature,
          fromEnabled: false,
          toEnabled: true,
          metricKey: input.policy.metricKey,
          metricValue: metric.value,
          sampleSize: metric.sampleSize,
        });
      }
    }

    this.retirementStates.set(key, state);
    return !state.disabled;
  }

  private computeMetric(
    metricKey: ContextRetirementMetricKey,
    model: string,
    taskClass: string,
  ): MetricComputationResult {
    const windowStart = this.now() - parseWindowMs(metricKey);
    let floorUnmet = 0;
    let planCount = 0;
    let movedTokens = 0;
    let injectedSourceTokens = 0;
    let injectedCount = 0;

    for (const sessionId of this.listSessionIds()) {
      const events = this.listEvents(sessionId);
      if (events.length === 0) continue;
      const classifier = this.classifySession(events);
      if (classifier.model !== model || classifier.taskClass !== taskClass) {
        continue;
      }

      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event) continue;
        if (event.timestamp < windowStart) break;
        if (metricKey === "floor_unmet_rate_7d") {
          if (event.type === "context_arena_floor_unmet_unrecoverable") {
            floorUnmet += 1;
            continue;
          }
          if (event.type === "context_injected") {
            planCount += 1;
            continue;
          }
          if (event.type === "context_injection_dropped") {
            const reason = this.readStringPayload(event, "reason");
            if (reason === "duplicate_content") continue;
            planCount += 1;
          }
          continue;
        }

        if (event.type === "context_arena_zone_adapted") {
          const moved = this.readNumberPayload(event, "movedTokens");
          movedTokens += Math.max(0, Math.floor(moved));
          continue;
        }
        if (event.type === "context_injected") {
          const sourceTokens = this.readNumberPayload(event, "sourceTokens");
          injectedSourceTokens += Math.max(0, Math.floor(sourceTokens));
          injectedCount += 1;
        }
      }
    }

    if (metricKey === "floor_unmet_rate_7d") {
      if (planCount <= 0) {
        return { value: 0, sampleSize: 0 };
      }
      return {
        value: floorUnmet / planCount,
        sampleSize: planCount,
      };
    }

    if (injectedCount <= 0 || injectedSourceTokens <= 0) {
      return { value: 0, sampleSize: injectedCount };
    }
    return {
      value: movedTokens / injectedSourceTokens,
      sampleSize: injectedCount,
    };
  }

  private classifySession(events: BrewvaEventRecord[]): SessionClassifier {
    let model = UNKNOWN_MODEL;
    let taskClass = NONE_TASK_CLASS;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event?.payload) continue;

      if (model === UNKNOWN_MODEL && event.type === "cost_update") {
        const candidate = this.readStringPayload(event, "model");
        if (candidate) model = candidate;
      }
      if (taskClass === NONE_TASK_CLASS && event.type === "skill_activated") {
        const candidate = this.readStringPayload(event, "skillName");
        if (candidate) taskClass = candidate;
      }
      if (model !== UNKNOWN_MODEL && taskClass !== NONE_TASK_CLASS) {
        break;
      }
    }
    return { model, taskClass };
  }

  private readStringPayload(event: BrewvaEventRecord, key: string): string {
    if (!event.payload || typeof event.payload !== "object") return "";
    const value = (event.payload as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }

  private readNumberPayload(event: BrewvaEventRecord, key: string): number {
    if (!event.payload || typeof event.payload !== "object") return 0;
    const value = (event.payload as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
}
