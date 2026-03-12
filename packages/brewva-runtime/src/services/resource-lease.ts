import { randomUUID } from "node:crypto";
import {
  RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
  RESOURCE_LEASE_EXPIRED_EVENT_TYPE,
  RESOURCE_LEASE_GRANTED_EVENT_TYPE,
} from "../events/event-types.js";
import { resolveSkillDefaultLease, resolveSkillHardCeiling } from "../skills/facets.js";
import type {
  ResourceLeaseBudget,
  ResourceLeaseCancelResult,
  ResourceLeaseQuery,
  ResourceLeaseRecord,
  ResourceLeaseRequest,
  ResourceLeaseResult,
  SkillContract,
  SkillDocument,
  SkillResourceBudget,
} from "../types.js";
import { RuntimeSessionStateStore } from "./session-state.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";

export interface ResourceLeaseServiceOptions {
  sessionState: RuntimeSessionStateStore;
  getCurrentTurn(sessionId: string): number;
  recordEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }): unknown;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
}

function cloneBudget(
  budget: ResourceLeaseBudget | SkillResourceBudget | undefined,
): ResourceLeaseBudget {
  return {
    maxToolCalls: budget?.maxToolCalls,
    maxTokens: budget?.maxTokens,
    maxParallel: budget?.maxParallel,
  };
}

function cloneLease(lease: ResourceLeaseRecord): ResourceLeaseRecord {
  return {
    ...lease,
    budget: cloneBudget(lease.budget),
  };
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function sumBudget(
  base: ResourceLeaseBudget | SkillResourceBudget | undefined,
  delta: ResourceLeaseBudget | SkillResourceBudget | undefined,
): ResourceLeaseBudget {
  const sumDimension = (
    left: number | undefined,
    right: number | undefined,
  ): number | undefined => {
    if (left === undefined && right === undefined) {
      return undefined;
    }
    return (left ?? 0) + (right ?? 0);
  };

  return {
    maxToolCalls: sumDimension(base?.maxToolCalls, delta?.maxToolCalls),
    maxTokens: sumDimension(base?.maxTokens, delta?.maxTokens),
    maxParallel: sumDimension(base?.maxParallel, delta?.maxParallel),
  };
}

function clampAdditionalBudget(input: {
  requested: ResourceLeaseBudget;
  base: SkillResourceBudget | undefined;
  currentLeaseBudget: ResourceLeaseBudget;
  hardCeiling: SkillResourceBudget | undefined;
}): ResourceLeaseBudget {
  const clamp = (
    requested: number | undefined,
    baseValue: number | undefined,
    currentLeaseValue: number | undefined,
    hardValue: number | undefined,
  ): number | undefined => {
    if (requested === undefined) return undefined;
    if (hardValue === undefined) return requested;
    const headroom = Math.max(0, hardValue - (baseValue ?? 0) - (currentLeaseValue ?? 0));
    const granted = Math.min(requested, headroom);
    return granted > 0 ? granted : undefined;
  };

  return {
    maxToolCalls: clamp(
      input.requested.maxToolCalls,
      input.base?.maxToolCalls,
      input.currentLeaseBudget.maxToolCalls,
      input.hardCeiling?.maxToolCalls,
    ),
    maxTokens: clamp(
      input.requested.maxTokens,
      input.base?.maxTokens,
      input.currentLeaseBudget.maxTokens,
      input.hardCeiling?.maxTokens,
    ),
    maxParallel: clamp(
      input.requested.maxParallel,
      input.base?.maxParallel,
      input.currentLeaseBudget.maxParallel,
      input.hardCeiling?.maxParallel,
    ),
  };
}

function budgetHasValues(budget: ResourceLeaseBudget | undefined): boolean {
  return Boolean(
    budget &&
    ((typeof budget.maxToolCalls === "number" && budget.maxToolCalls > 0) ||
      (typeof budget.maxTokens === "number" && budget.maxTokens > 0) ||
      (typeof budget.maxParallel === "number" && budget.maxParallel > 0)),
  );
}

export class ResourceLeaseService {
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getCurrentTurn: ResourceLeaseServiceOptions["getCurrentTurn"];
  private readonly recordEvent: ResourceLeaseServiceOptions["recordEvent"];
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;

  constructor(options: ResourceLeaseServiceOptions) {
    this.sessionState = options.sessionState;
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.getActiveSkill = (sessionId) => options.skillLifecycleService.getActiveSkill(sessionId);
  }

  requestLease(sessionId: string, request: ResourceLeaseRequest): ResourceLeaseResult {
    const reason = request.reason.trim();
    if (!reason) {
      return { ok: false, error: "Lease reason is required." };
    }

    this.expireLeases(sessionId);
    const skill = this.getActiveSkill(sessionId);
    if (!skill) {
      return { ok: false, error: "Resource leases require an active skill." };
    }
    const currentLeaseBudget = this.getGrantedBudget(sessionId, skill?.name);
    const requestedBudget: ResourceLeaseBudget = {
      maxToolCalls: normalizePositiveInteger(request.budget?.maxToolCalls),
      maxTokens: normalizePositiveInteger(request.budget?.maxTokens),
      maxParallel: normalizePositiveInteger(request.budget?.maxParallel),
    };
    const grantedBudget = clampAdditionalBudget({
      requested: requestedBudget,
      base: resolveSkillDefaultLease(skill?.contract),
      currentLeaseBudget,
      hardCeiling: resolveSkillHardCeiling(skill?.contract),
    });

    if (!budgetHasValues(grantedBudget)) {
      const defaultLease = resolveSkillDefaultLease(skill?.contract);
      const hardCeiling = resolveSkillHardCeiling(skill?.contract);
      const noHeadroom =
        defaultLease?.maxToolCalls === hardCeiling?.maxToolCalls &&
        defaultLease?.maxTokens === hardCeiling?.maxTokens &&
        defaultLease?.maxParallel === hardCeiling?.maxParallel;
      return {
        ok: false,
        error: noHeadroom
          ? `Lease request did not produce any additional budget expansion for skill '${skill.name}'. Increase resources.hard_ceiling above resources.default_lease to create lease headroom.`
          : "Lease request did not produce any additional budget expansion.",
      };
    }

    const ttlMs = normalizePositiveInteger(request.ttlMs);
    const ttlTurns = normalizePositiveInteger(request.ttlTurns);
    const now = Date.now();
    const lease: ResourceLeaseRecord = {
      id: randomUUID(),
      sessionId,
      skillName: skill.name,
      reason,
      budget: grantedBudget,
      createdAt: now,
      expiresAt: ttlMs ? now + ttlMs : undefined,
      expiresAfterTurn: ttlTurns ? this.getCurrentTurn(sessionId) + ttlTurns : undefined,
      status: "active",
    };

    this.sessionState.getCell(sessionId).resourceLeases.set(lease.id, lease);
    this.recordEvent({
      sessionId,
      type: RESOURCE_LEASE_GRANTED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: this.serializeLease(lease),
      timestamp: now,
    });
    return { ok: true, lease: cloneLease(lease) };
  }

  listLeases(sessionId: string, query: ResourceLeaseQuery = {}): ResourceLeaseRecord[] {
    this.expireLeases(sessionId);
    const activeSkillName = this.getActiveSkill(sessionId)?.name;
    return [...this.sessionState.getCell(sessionId).resourceLeases.values()]
      .filter((lease) => query.includeInactive === true || lease.status === "active")
      .filter((lease) => {
        if (!query.skillName) return true;
        return lease.skillName === query.skillName;
      })
      .filter((lease) => {
        if (query.skillName !== undefined || query.includeInactive === true) {
          return true;
        }
        return activeSkillName !== undefined && lease.skillName === activeSkillName;
      })
      .map((lease) => cloneLease(lease))
      .toSorted((left, right) => right.createdAt - left.createdAt);
  }

  cancelLease(sessionId: string, leaseId: string, reason?: string): ResourceLeaseCancelResult {
    this.expireLeases(sessionId);
    const lease = this.sessionState.getCell(sessionId).resourceLeases.get(leaseId);
    if (!lease) {
      return { ok: false, error: `Resource lease '${leaseId}' was not found.` };
    }
    if (lease.status !== "active") {
      return { ok: false, error: `Resource lease '${leaseId}' is already ${lease.status}.` };
    }
    lease.status = "cancelled";
    lease.cancelledAt = Date.now();
    lease.cancelledReason = reason?.trim() || "cancelled";
    this.recordEvent({
      sessionId,
      type: RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        leaseId: lease.id,
        status: lease.status,
        cancelledAt: lease.cancelledAt,
        cancelledReason: lease.cancelledReason,
      },
      timestamp: lease.cancelledAt,
    });
    return { ok: true, lease: cloneLease(lease) };
  }

  getGrantedBudget(sessionId: string, skillName?: string): ResourceLeaseBudget {
    this.expireLeases(sessionId);
    const activeSkillName = skillName ?? this.getActiveSkill(sessionId)?.name;
    let budget: ResourceLeaseBudget = {};
    for (const lease of this.getApplicableActiveLeases(sessionId, activeSkillName)) {
      budget = sumBudget(budget, lease.budget);
    }
    return budget;
  }

  getEffectiveBudget(
    sessionId: string,
    contract: SkillContract | undefined,
    skillName?: string,
  ): SkillResourceBudget | undefined {
    const base = resolveSkillDefaultLease(contract);
    const expansion = this.getGrantedBudget(sessionId, skillName);
    const hardCeiling = resolveSkillHardCeiling(contract);
    const combined = sumBudget(base, expansion);
    if (!budgetHasValues(combined)) {
      return undefined;
    }
    const clampDimension = (
      value: number | undefined,
      hardValue: number | undefined,
    ): number | undefined => {
      if (value === undefined) return undefined;
      return hardValue !== undefined ? Math.min(value, hardValue) : value;
    };
    return {
      maxToolCalls: clampDimension(combined.maxToolCalls, hardCeiling?.maxToolCalls),
      maxTokens: clampDimension(combined.maxTokens, hardCeiling?.maxTokens),
      maxParallel: clampDimension(combined.maxParallel, hardCeiling?.maxParallel),
    };
  }

  restoreLease(sessionId: string, lease: ResourceLeaseRecord): void {
    this.sessionState.getCell(sessionId).resourceLeases.set(lease.id, cloneLease(lease));
  }

  markLeaseStatus(
    sessionId: string,
    leaseId: string,
    status: ResourceLeaseRecord["status"],
    input: { cancelledAt?: number; cancelledReason?: string } = {},
  ): void {
    const lease = this.sessionState.getCell(sessionId).resourceLeases.get(leaseId);
    if (!lease) return;
    lease.status = status;
    if (status === "cancelled") {
      lease.cancelledAt = input.cancelledAt;
      lease.cancelledReason = input.cancelledReason;
    }
  }

  private getApplicableActiveLeases(sessionId: string, skillName?: string): ResourceLeaseRecord[] {
    const state = this.sessionState.getCell(sessionId);
    return [...state.resourceLeases.values()].filter((lease) => {
      if (lease.status !== "active") return false;
      return lease.skillName === skillName;
    });
  }

  private expireLeases(sessionId: string): void {
    const state = this.sessionState.getCell(sessionId);
    const now = Date.now();
    const currentTurn = this.getCurrentTurn(sessionId);
    for (const lease of state.resourceLeases.values()) {
      if (lease.status !== "active") continue;
      const expiredByTime = lease.expiresAt !== undefined && lease.expiresAt <= now;
      const expiredByTurn =
        lease.expiresAfterTurn !== undefined && lease.expiresAfterTurn <= currentTurn;
      if (!expiredByTime && !expiredByTurn) continue;
      lease.status = "expired";
      this.recordEvent({
        sessionId,
        type: RESOURCE_LEASE_EXPIRED_EVENT_TYPE,
        turn: currentTurn,
        payload: {
          leaseId: lease.id,
          status: lease.status,
          expiredBy: expiredByTime ? "time" : "turn",
        },
        timestamp: now,
      });
    }
  }

  private serializeLease(lease: ResourceLeaseRecord): Record<string, unknown> {
    return {
      id: lease.id,
      sessionId: lease.sessionId,
      skillName: lease.skillName,
      reason: lease.reason,
      budget: cloneBudget(lease.budget),
      createdAt: lease.createdAt,
      expiresAt: lease.expiresAt,
      expiresAfterTurn: lease.expiresAfterTurn,
      status: lease.status,
    };
  }
}
