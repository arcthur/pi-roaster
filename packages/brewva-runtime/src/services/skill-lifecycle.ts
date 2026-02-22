import type { SkillRegistry } from "../skills/registry.js";
import type { SkillDocument } from "../types.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

export interface SkillLifecycleServiceOptions {
  skills: SkillRegistry;
  sessionState: RuntimeSessionStateStore;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: Record<string, unknown>;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    unknown
  >;
}

export class SkillLifecycleService {
  private readonly skills: SkillRegistry;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: SkillLifecycleServiceOptions["recordEvent"];

  constructor(options: SkillLifecycleServiceOptions) {
    this.skills = options.skills;
    this.sessionState = options.sessionState;
    this.getCurrentTurn = options.getCurrentTurn;
    this.recordEvent = options.recordEvent;
  }

  activateSkill(
    sessionId: string,
    name: string,
  ): { ok: boolean; reason?: string; skill?: SkillDocument } {
    const skill = this.skills.get(name);
    if (!skill) {
      return { ok: false, reason: `Skill '${name}' not found.` };
    }

    const activeName = this.sessionState.activeSkillsBySession.get(sessionId);
    if (activeName && activeName !== name) {
      const activeSkill = this.skills.get(activeName);
      const activeAllows = activeSkill?.contract.composableWith?.includes(name) ?? false;
      const nextAllows = skill.contract.composableWith?.includes(activeName) ?? false;
      if (!activeAllows && !nextAllows) {
        return {
          ok: false,
          reason: `Active skill '${activeName}' must be completed before activating '${name}'.`,
        };
      }
    }

    this.sessionState.activeSkillsBySession.set(sessionId, name);
    this.sessionState.toolCallsBySession.set(sessionId, 0);
    return { ok: true, skill };
  }

  getActiveSkill(sessionId: string): SkillDocument | undefined {
    const active = this.sessionState.activeSkillsBySession.get(sessionId);
    if (!active) return undefined;
    return this.skills.get(active);
  }

  validateSkillOutputs(
    sessionId: string,
    outputs: Record<string, unknown>,
  ): { ok: boolean; missing: string[] } {
    const skill = this.getActiveSkill(sessionId);
    if (!skill) {
      return { ok: true, missing: [] };
    }

    const isSatisfied = (value: unknown): boolean => {
      if (value === undefined || value === null) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "number") return Number.isFinite(value);
      if (typeof value === "boolean") return true;
      if (typeof value === "object") {
        return Object.keys(value as Record<string, unknown>).length > 0;
      }
      return true;
    };

    const expected = skill.contract.outputs ?? [];
    const missing = expected.filter((name) => !isSatisfied(outputs[name]));
    if (missing.length === 0) {
      return { ok: true, missing: [] };
    }
    return { ok: false, missing };
  }

  validateComposePlan(plan: {
    steps: Array<{ skill: string; consumes?: string[]; produces?: string[] }>;
  }): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const availableOutputs = new Set<string>();

    for (const [i, step] of plan.steps.entries()) {
      const skill = this.skills.get(step.skill);
      if (!skill) {
        errors.push(`Step ${i + 1}: skill '${step.skill}' not found in registry.`);
        continue;
      }

      for (const consumed of step.consumes ?? []) {
        if (!availableOutputs.has(consumed)) {
          warnings.push(
            `Step ${i + 1} (${step.skill}): consumes '${consumed}' but no prior step produces it.`,
          );
        }
      }

      for (const produced of step.produces ?? []) {
        availableOutputs.add(produced);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  completeSkill(
    sessionId: string,
    outputs: Record<string, unknown>,
  ): { ok: boolean; missing: string[] } {
    const validation = this.validateSkillOutputs(sessionId, outputs);
    if (!validation.ok) {
      return validation;
    }

    const activeSkillName = this.sessionState.activeSkillsBySession.get(sessionId);
    if (activeSkillName) {
      const completedAt = Date.now();
      let sessionOutputs = this.sessionState.skillOutputsBySession.get(sessionId);
      if (!sessionOutputs) {
        sessionOutputs = new Map();
        this.sessionState.skillOutputsBySession.set(sessionId, sessionOutputs);
      }
      sessionOutputs.set(activeSkillName, {
        skillName: activeSkillName,
        completedAt,
        outputs,
      });

      this.recordEvent({
        sessionId,
        type: "skill_completed",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          skillName: activeSkillName,
          outputKeys: Object.keys(outputs).toSorted().slice(0, 64),
          completedAt,
        },
      });

      this.sessionState.activeSkillsBySession.delete(sessionId);
      this.sessionState.toolCallsBySession.delete(sessionId);
    }
    return validation;
  }

  getSkillOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined {
    return this.sessionState.skillOutputsBySession.get(sessionId)?.get(skillName)?.outputs;
  }

  getAvailableConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown> {
    const targetSkill = this.skills.get(targetSkillName);
    if (!targetSkill) return {};
    const consumes = targetSkill.contract.consumes ?? [];
    if (consumes.length === 0) return {};

    const consumeSet = new Set(consumes);
    const result: Record<string, unknown> = {};
    const sessionOutputs = this.sessionState.skillOutputsBySession.get(sessionId);
    if (!sessionOutputs) return {};

    for (const record of sessionOutputs.values()) {
      for (const [key, value] of Object.entries(record.outputs)) {
        if (consumeSet.has(key)) {
          result[key] = value;
        }
      }
    }
    return result;
  }
}
