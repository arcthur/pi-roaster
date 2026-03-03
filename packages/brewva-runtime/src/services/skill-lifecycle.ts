import type { SkillRegistry } from "../skills/registry.js";
import { parseTaskSpec } from "../task/spec.js";
import type { SkillDispatchDecision, SkillDocument, TaskSpec, TaskState } from "../types.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function compactText(value: string, maxChars = 2000): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function deriveComposeGoal(outputs: Record<string, unknown>): string | null {
  const analysis = outputs.compose_analysis;
  if (typeof analysis === "string") {
    const summaryMatch = analysis.match(/request_summary:\s*["']?(.+?)["']?(?:$|\r?\n)/i);
    if (summaryMatch?.[1]) {
      return compactText(summaryMatch[1], 500);
    }
    const firstLine = analysis
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !/^compose_analysis$/i.test(line));
    if (firstLine) {
      return compactText(firstLine, 500);
    }
  }

  if (isRecord(analysis)) {
    const summary =
      readNonEmptyString(analysis.request_summary) ??
      readNonEmptyString(analysis.requestSummary) ??
      readNonEmptyString(analysis.goal) ??
      readNonEmptyString(analysis.summary);
    if (summary) return compactText(summary, 500);
  }

  const composePlan = outputs.compose_plan;
  if (isRecord(composePlan)) {
    const summary =
      readNonEmptyString(composePlan.goal) ??
      readNonEmptyString(composePlan.summary) ??
      readNonEmptyString(composePlan.intent);
    if (summary) return compactText(summary, 500);
  }

  if (readNonEmptyString(composePlan)) {
    return "Execute composed multi-step plan";
  }
  if (Array.isArray(outputs.skill_sequence) && outputs.skill_sequence.length > 0) {
    return "Execute composed multi-step plan";
  }
  return null;
}

function deriveTaskSpecFromOutputs(
  activeSkillName: string,
  outputs: Record<string, unknown>,
): TaskSpec | null {
  if (Object.prototype.hasOwnProperty.call(outputs, "task_spec")) {
    const parsed = parseTaskSpec(outputs.task_spec);
    if (parsed.ok) return parsed.spec;
  }

  if (activeSkillName !== "compose") return null;
  const hasComposeSignals =
    Object.prototype.hasOwnProperty.call(outputs, "compose_analysis") ||
    Object.prototype.hasOwnProperty.call(outputs, "compose_plan") ||
    Object.prototype.hasOwnProperty.call(outputs, "skill_sequence");
  if (!hasComposeSignals) return null;

  const goal = deriveComposeGoal(outputs) ?? "Execute composed multi-step plan";
  const expectedBehavior = readNonEmptyString(outputs.compose_plan);
  return {
    schema: "brewva.task.v1",
    goal,
    expectedBehavior: expectedBehavior ? compactText(expectedBehavior, 2000) : undefined,
  };
}

export interface SkillLifecycleServiceOptions {
  skills: SkillRegistry;
  sessionState: RuntimeSessionStateStore;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  getTaskState?: RuntimeCallback<[sessionId: string], TaskState>;
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
  setTaskSpec?: RuntimeCallback<[sessionId: string, spec: TaskSpec]>;
}

export class SkillLifecycleService {
  private readonly skills: SkillRegistry;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getTaskState?: (sessionId: string) => TaskState;
  private readonly recordEvent: SkillLifecycleServiceOptions["recordEvent"];
  private readonly setTaskSpec?: SkillLifecycleServiceOptions["setTaskSpec"];

  constructor(options: SkillLifecycleServiceOptions) {
    this.skills = options.skills;
    this.sessionState = options.sessionState;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getTaskState = options.getTaskState;
    this.recordEvent = options.recordEvent;
    this.setTaskSpec = options.setTaskSpec;
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
    this.recordEvent({
      sessionId,
      type: "skill_activated",
      turn: this.getCurrentTurn(sessionId),
      payload: {
        skillName: name,
      },
    });

    const pendingDispatch = this.getPendingDispatch(sessionId);
    if (pendingDispatch && pendingDispatch.mode !== "none") {
      const primaryName = pendingDispatch.primary?.name;
      if (primaryName && primaryName === name) {
        this.recordEvent({
          sessionId,
          type: "skill_routing_followed",
          turn: this.getCurrentTurn(sessionId),
          payload: this.buildDispatchPayload(pendingDispatch, {
            activatedSkill: name,
            resolvedBy: "skill_load",
          }),
        });
      } else {
        this.recordEvent({
          sessionId,
          type: "skill_routing_overridden",
          turn: this.getCurrentTurn(sessionId),
          payload: this.buildDispatchPayload(pendingDispatch, {
            activatedSkill: name,
            resolvedBy: "skill_load_non_primary",
          }),
        });
      }
      this.sessionState.pendingDispatchBySession.delete(sessionId);
    }

    return { ok: true, skill };
  }

  getActiveSkill(sessionId: string): SkillDocument | undefined {
    const active = this.sessionState.activeSkillsBySession.get(sessionId);
    if (!active) return undefined;
    return this.skills.get(active);
  }

  setPendingDispatch(
    sessionId: string,
    decision: SkillDispatchDecision,
    options: { emitEvent?: boolean } = {},
  ): void {
    const activeSkillName = this.sessionState.activeSkillsBySession.get(sessionId) ?? null;
    const shouldStorePending = decision.mode === "gate" || decision.mode === "auto";
    if (!shouldStorePending) {
      this.sessionState.pendingDispatchBySession.delete(sessionId);
    } else {
      this.sessionState.pendingDispatchBySession.set(sessionId, decision);
    }
    if (options.emitEvent === false) return;
    this.recordEvent({
      sessionId,
      type: "skill_routing_decided",
      turn: this.getCurrentTurn(sessionId),
      payload: this.buildDispatchPayload(decision),
    });
    if (activeSkillName && shouldStorePending) {
      this.recordEvent({
        sessionId,
        type: "skill_routing_deferred",
        turn: this.getCurrentTurn(sessionId),
        payload: this.buildDispatchPayload(decision, {
          deferredBy: activeSkillName,
          deferredAtTurn: this.getCurrentTurn(sessionId),
        }),
      });
    }
  }

  getPendingDispatch(sessionId: string): SkillDispatchDecision | undefined {
    return this.sessionState.pendingDispatchBySession.get(sessionId);
  }

  clearPendingDispatch(sessionId: string): SkillDispatchDecision | undefined {
    const pending = this.sessionState.pendingDispatchBySession.get(sessionId);
    this.sessionState.pendingDispatchBySession.delete(sessionId);
    return pending;
  }

  overridePendingDispatch(
    sessionId: string,
    input: { reason?: string; targetSkillName?: string } = {},
  ): { ok: boolean; reason?: string; decision?: SkillDispatchDecision } {
    const pending = this.getPendingDispatch(sessionId);
    if (!pending || pending.mode === "none") {
      return { ok: false, reason: "No pending skill dispatch gate." };
    }
    this.recordEvent({
      sessionId,
      type: "skill_routing_overridden",
      turn: this.getCurrentTurn(sessionId),
      payload: this.buildDispatchPayload(pending, {
        reason: input.reason ?? "manual_override",
        targetSkillName: input.targetSkillName ?? null,
        resolvedBy: "skill_route_override",
      }),
    });
    this.clearPendingDispatch(sessionId);
    return { ok: true, decision: pending };
  }

  reconcilePendingDispatchOnTurnEnd(sessionId: string, turn: number): void {
    const pending = this.getPendingDispatch(sessionId);
    if (!pending || pending.mode === "none") return;
    const effectiveTurn = Math.max(turn, this.getCurrentTurn(sessionId));
    if (pending.turn > effectiveTurn) return;

    this.recordEvent({
      sessionId,
      type: "skill_routing_ignored",
      turn: this.getCurrentTurn(sessionId),
      payload: this.buildDispatchPayload(pending, {
        resolvedBy: "turn_end",
      }),
    });
    this.clearPendingDispatch(sessionId);
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
      const outputKeys = Object.keys(outputs).toSorted();

      this.recordEvent({
        sessionId,
        type: "skill_completed",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          skillName: activeSkillName,
          outputKeys,
          outputs,
          completedAt,
        },
      });

      this.maybePromoteTaskSpec(sessionId, activeSkillName, outputs);

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

  listProducedOutputKeys(sessionId: string): string[] {
    const sessionOutputs = this.sessionState.skillOutputsBySession.get(sessionId);
    if (!sessionOutputs || sessionOutputs.size === 0) {
      return [];
    }
    const outputKeys = new Set<string>();
    for (const record of sessionOutputs.values()) {
      for (const key of Object.keys(record.outputs)) {
        const normalized = key.trim();
        if (!normalized) continue;
        outputKeys.add(normalized);
      }
    }
    return [...outputKeys];
  }

  private buildDispatchPayload(
    decision: SkillDispatchDecision,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      mode: decision.mode,
      reason: decision.reason,
      confidence: decision.confidence,
      routingOutcome: decision.routingOutcome ?? null,
      decisionTurn: decision.turn,
      primary: decision.primary
        ? {
            name: decision.primary.name,
            score: decision.primary.score,
            reason: decision.primary.reason,
            breakdown: decision.primary.breakdown,
          }
        : null,
      selectedCount: decision.selected.length,
      selected: decision.selected.map((entry) => ({
        name: entry.name,
        score: entry.score,
        reason: entry.reason,
        breakdown: entry.breakdown,
      })),
      chain: decision.chain,
      unresolvedConsumes: decision.unresolvedConsumes,
      ...extra,
    };
  }

  private maybePromoteTaskSpec(
    sessionId: string,
    activeSkillName: string,
    outputs: Record<string, unknown>,
  ): void {
    if (!this.setTaskSpec || !this.getTaskState) return;
    const taskState = this.getTaskState(sessionId);
    if (taskState.spec) return;
    const phase = taskState.status?.phase;
    if (phase && phase !== "align") return;

    const nextSpec = deriveTaskSpecFromOutputs(activeSkillName, outputs);
    if (!nextSpec) return;
    this.setTaskSpec(sessionId, nextSpec);
  }
}
