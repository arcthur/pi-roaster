import type { ZoneBudgetConfig } from "./zone-budget.js";
import { ZONE_ORDER, createZeroZoneTokenMap, type ContextZone } from "./zones.js";

export interface ZoneBudgetAdaptiveConfig {
  enabled: boolean;
  emaAlpha: number;
  minTurnsBeforeAdapt: number;
  stepTokens: number;
  maxShiftPerTurn: number;
  upshiftTruncationRatio: number;
  downshiftIdleRatio: number;
}

export interface ZoneBudgetPlanTelemetry {
  zoneDemandTokens: Record<ContextZone, number>;
  zoneAllocatedTokens: Record<ContextZone, number>;
  zoneAcceptedTokens: Record<ContextZone, number>;
}

export interface ZoneBudgetControllerSnapshot {
  turn: number;
  emaTruncationByZone: Record<ContextZone, number>;
  emaIdleByZone: Record<ContextZone, number>;
  maxByZone: Record<ContextZone, number>;
}

export interface ZoneBudgetControllerAdjustment {
  changed: boolean;
  movedTokens: number;
  maxByZone: Record<ContextZone, number>;
  shifts: Array<{ from: ContextZone; to: ContextZone; tokens: number }>;
  turn: number;
}

interface ZoneBudgetControllerState {
  turn: number;
  emaTruncationByZone: Record<ContextZone, number>;
  emaIdleByZone: Record<ContextZone, number>;
  maxByZone: Record<ContextZone, number>;
}

const FLOOR_PROTECTED_ZONES = new Set<ContextZone>(["identity", "truth", "task_state"]);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeNonNegativeInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeStep(value: number, fallback: number): number {
  const normalized = normalizeNonNegativeInteger(value, fallback);
  return normalized > 0 ? normalized : fallback;
}

function normalizeRatio(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp01(value);
}

function toInitialMaxByZone(config: ZoneBudgetConfig): Record<ContextZone, number> {
  const out = createZeroZoneTokenMap();
  for (const zone of ZONE_ORDER) {
    out[zone] = Math.max(config[zone].min, config[zone].max);
  }
  return out;
}

function createInitialState(config: ZoneBudgetConfig): ZoneBudgetControllerState {
  return {
    turn: 0,
    emaTruncationByZone: createZeroZoneTokenMap(),
    emaIdleByZone: createZeroZoneTokenMap(),
    maxByZone: toInitialMaxByZone(config),
  };
}

export class ZoneBudgetController {
  private readonly config: ZoneBudgetConfig;
  private readonly adaptive: ZoneBudgetAdaptiveConfig;
  private readonly sessions = new Map<string, ZoneBudgetControllerState>();

  constructor(config: ZoneBudgetConfig, adaptive: ZoneBudgetAdaptiveConfig) {
    this.config = config;
    this.adaptive = {
      enabled: adaptive.enabled,
      emaAlpha: normalizeRatio(adaptive.emaAlpha, 0.3),
      minTurnsBeforeAdapt: normalizeNonNegativeInteger(adaptive.minTurnsBeforeAdapt, 3),
      stepTokens: normalizeStep(adaptive.stepTokens, 32),
      maxShiftPerTurn: normalizeNonNegativeInteger(adaptive.maxShiftPerTurn, 96),
      upshiftTruncationRatio: normalizeRatio(adaptive.upshiftTruncationRatio, 0.25),
      downshiftIdleRatio: normalizeRatio(adaptive.downshiftIdleRatio, 0.15),
    };
  }

  resolveZoneBudgetConfig(sessionId: string): ZoneBudgetConfig {
    if (!this.adaptive.enabled) {
      return this.config;
    }
    const state = this.getOrCreateSessionState(sessionId);
    const out = {} as ZoneBudgetConfig;
    for (const zone of ZONE_ORDER) {
      out[zone] = {
        min: this.config[zone].min,
        max: Math.max(this.config[zone].min, state.maxByZone[zone]),
      };
    }
    return out;
  }

  observe(
    sessionId: string,
    telemetry: ZoneBudgetPlanTelemetry,
  ): ZoneBudgetControllerAdjustment | null {
    if (!this.adaptive.enabled) {
      return null;
    }
    const state = this.getOrCreateSessionState(sessionId);
    state.turn += 1;
    const alpha = this.adaptive.emaAlpha;

    for (const zone of ZONE_ORDER) {
      const demand = Math.max(0, Math.floor(telemetry.zoneDemandTokens[zone] ?? 0));
      const allocated = Math.max(0, Math.floor(telemetry.zoneAllocatedTokens[zone] ?? 0));
      const accepted = Math.max(0, Math.floor(telemetry.zoneAcceptedTokens[zone] ?? 0));
      const truncationRatio = demand > 0 ? clamp01((demand - accepted) / demand) : 0;
      const idleRatio = allocated > 0 ? clamp01((allocated - accepted) / allocated) : 0;
      state.emaTruncationByZone[zone] =
        alpha * truncationRatio + (1 - alpha) * state.emaTruncationByZone[zone];
      state.emaIdleByZone[zone] = alpha * idleRatio + (1 - alpha) * state.emaIdleByZone[zone];
    }

    if (state.turn < this.adaptive.minTurnsBeforeAdapt) {
      return null;
    }

    const shiftUnit = this.adaptive.stepTokens;
    const shiftBudget =
      Math.floor(this.adaptive.maxShiftPerTurn / Math.max(1, shiftUnit)) * Math.max(1, shiftUnit);
    if (shiftBudget <= 0) {
      return null;
    }

    const receivers = ZONE_ORDER.filter((zone) => {
      const demand = telemetry.zoneDemandTokens[zone] ?? 0;
      return demand > 0 && state.emaTruncationByZone[zone] > this.adaptive.upshiftTruncationRatio;
    }).toSorted(
      (left, right) => state.emaTruncationByZone[right] - state.emaTruncationByZone[left],
    );
    if (receivers.length === 0) {
      return null;
    }

    const donors = ZONE_ORDER.filter((zone) => {
      if (FLOOR_PROTECTED_ZONES.has(zone)) return false;
      if (state.emaIdleByZone[zone] <= this.adaptive.downshiftIdleRatio) return false;
      return state.maxByZone[zone] > this.config[zone].min;
    }).toSorted((left, right) => state.emaIdleByZone[right] - state.emaIdleByZone[left]);
    if (donors.length === 0) {
      return null;
    }

    let remainingShift = shiftBudget;
    let receiverIndex = 0;
    const shifts: Array<{ from: ContextZone; to: ContextZone; tokens: number }> = [];

    while (remainingShift >= shiftUnit && donors.length > 0 && receivers.length > 0) {
      const donor = donors[0];
      const receiver = receivers[receiverIndex % receivers.length];
      receiverIndex += 1;
      if (!donor || !receiver) break;
      if (donor === receiver) {
        if (receivers.length <= 1) break;
        continue;
      }
      const donorHeadroom = state.maxByZone[donor] - this.config[donor].min;
      if (donorHeadroom < shiftUnit) {
        donors.shift();
        continue;
      }

      state.maxByZone[donor] -= shiftUnit;
      state.maxByZone[receiver] += shiftUnit;
      remainingShift -= shiftUnit;
      shifts.push({ from: donor, to: receiver, tokens: shiftUnit });
      if (state.maxByZone[donor] <= this.config[donor].min) {
        donors.shift();
      }
    }

    if (shifts.length === 0) {
      return null;
    }
    return {
      changed: true,
      movedTokens: shifts.reduce((sum, shift) => sum + shift.tokens, 0),
      maxByZone: { ...state.maxByZone },
      shifts,
      turn: state.turn,
    };
  }

  resetEpoch(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  snapshot(sessionId: string): ZoneBudgetControllerSnapshot | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      turn: state.turn,
      emaTruncationByZone: { ...state.emaTruncationByZone },
      emaIdleByZone: { ...state.emaIdleByZone },
      maxByZone: { ...state.maxByZone },
    };
  }

  private getOrCreateSessionState(sessionId: string): ZoneBudgetControllerState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created = createInitialState(this.config);
    this.sessions.set(sessionId, created);
    return created;
  }
}
