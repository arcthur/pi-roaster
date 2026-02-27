import { ZONE_ORDER, createZeroZoneTokenMap, type ContextZone } from "./zones.js";

export type ZoneBudgetConfig = Record<ContextZone, { min: number; max: number }>;

export type ZoneDemand = Partial<Record<ContextZone, number>>;

export type ZoneBudgetAllocationResult = {
  accepted: boolean;
  reason?: "floor_unmet";
} & Record<ContextZone, number>;

function normalizeDemand(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeLimit(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export class ZoneBudgetAllocator {
  private readonly config: ZoneBudgetConfig;

  constructor(config: ZoneBudgetConfig) {
    this.config = config;
  }

  allocate(input: { totalBudget: number; zoneDemands: ZoneDemand }): ZoneBudgetAllocationResult {
    const totalBudget = Math.max(0, Math.floor(input.totalBudget));
    const demands: Record<ContextZone, number> = createZeroZoneTokenMap();
    for (const zone of ZONE_ORDER) {
      demands[zone] = normalizeDemand(input.zoneDemands[zone]);
    }

    const allocated = createZeroZoneTokenMap();
    let floorSum = 0;
    for (const zone of ZONE_ORDER) {
      const demand = demands[zone];
      if (demand <= 0) continue;
      const floor = normalizeLimit(this.config[zone].min);
      const cap = normalizeLimit(this.config[zone].max);
      const boundedFloor = Math.min(demand, Math.min(floor, cap));
      allocated[zone] = boundedFloor;
      floorSum += boundedFloor;
    }

    if (floorSum > totalBudget) {
      return {
        accepted: false,
        reason: "floor_unmet",
        ...createZeroZoneTokenMap(),
      };
    }

    let remaining = totalBudget - floorSum;
    for (const zone of ZONE_ORDER) {
      if (remaining <= 0) break;
      const demand = demands[zone];
      if (demand <= 0) continue;
      const cap = normalizeLimit(this.config[zone].max);
      const current = allocated[zone];
      if (current >= demand || current >= cap) continue;
      const extraDemand = demand - current;
      const capHeadroom = cap - current;
      const grant = Math.min(extraDemand, capHeadroom, remaining);
      if (grant <= 0) continue;
      allocated[zone] = current + grant;
      remaining -= grant;
    }

    return {
      accepted: true,
      ...allocated,
    };
  }
}
