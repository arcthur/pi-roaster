import { getSkillOutputContracts, listSkillOutputs } from "../skills/facets.js";
import type { SkillRegistry } from "../skills/registry.js";
import { parseTaskSpec } from "../task/spec.js";
import type {
  SkillDispatchDecision,
  SkillDocument,
  SkillOutputContract,
  TaskSpec,
  TaskState,
} from "../types.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

interface SkillOutputValidationIssue {
  name: string;
  reason: string;
}

interface SkillOutputValidationResult {
  ok: boolean;
  missing: string[];
  invalid: SkillOutputValidationIssue[];
}

type InformativeTextOptions = {
  minWords?: number;
  minLength?: number;
};
const PLACEHOLDER_OUTPUT_TEXT = new Set([
  "artifact",
  "artifacts",
  "dummy",
  "finding",
  "findings",
  "foo",
  "n/a",
  "na",
  "none",
  "placeholder",
  "summary",
  "tbd",
  "test",
  "todo",
  "trace",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function countWords(text: string): number {
  return text
    .split(/\s+/u)
    .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, ""))
    .filter((token) => token.length > 0).length;
}

function isPlaceholderText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (PLACEHOLDER_OUTPUT_TEXT.has(normalized)) return true;
  return /^[a-z]$/u.test(normalized);
}

function isInformativeText(value: unknown, options: InformativeTextOptions = {}): boolean {
  const text = normalizeText(value);
  if (!text) return false;
  if (isPlaceholderText(text)) return false;

  const minWords = options.minWords ?? 2;
  const minLength = options.minLength ?? 16;
  return countWords(text) >= minWords || text.length >= minLength;
}

function validateInformativeText(
  value: unknown,
  label: string,
  options: InformativeTextOptions = {},
): string | null {
  if (isInformativeText(value, options)) {
    return null;
  }
  return `${label} must be an informative artifact, not a placeholder value`;
}

function isSatisfied(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

function validateOutputContract(
  value: unknown,
  contract: SkillOutputContract,
  label: string,
): string | null {
  switch (contract.kind) {
    case "text":
      return validateInformativeText(value, label, {
        minWords: contract.minWords,
        minLength: contract.minLength,
      });
    case "enum": {
      const text = normalizeText(value);
      const values =
        contract.caseSensitive === true
          ? contract.values
          : contract.values.map((entry) => entry.toLowerCase());
      const candidate = contract.caseSensitive === true ? text : text?.toLowerCase();
      if (candidate && values.includes(candidate)) {
        return null;
      }
      return `${label} must be one of: ${contract.values.join(", ")}`;
    }
    case "json": {
      if (Array.isArray(value)) {
        const minItems = contract.minItems ?? 1;
        return value.length >= minItems
          ? null
          : `${label} must contain at least ${minItems} item${minItems === 1 ? "" : "s"}`;
      }
      if (isRecord(value)) {
        const minKeys = contract.minKeys ?? 1;
        return Object.keys(value).length >= minKeys
          ? null
          : `${label} must contain at least ${minKeys} field${minKeys === 1 ? "" : "s"}`;
      }
      return `${label} must be a non-empty object or array`;
    }
  }
}

function deriveTaskSpecFromOutputs(outputs: Record<string, unknown>): TaskSpec | null {
  if (Object.prototype.hasOwnProperty.call(outputs, "task_spec")) {
    const parsed = parseTaskSpec(outputs.task_spec);
    if (parsed.ok) return parsed.spec;
  }
  return null;
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
    const state = this.sessionState.getCell(sessionId);
    const skill = this.skills.get(name);
    if (!skill) {
      return { ok: false, reason: `Skill '${name}' not found.` };
    }

    const activeName = state.activeSkill;
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

    state.activeSkill = name;
    state.toolCalls = 0;
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
      state.pendingDispatch = undefined;
    }

    return { ok: true, skill };
  }

  getActiveSkill(sessionId: string): SkillDocument | undefined {
    const active = this.sessionState.getExistingCell(sessionId)?.activeSkill;
    if (!active) return undefined;
    return this.skills.get(active);
  }

  setPendingDispatch(
    sessionId: string,
    decision: SkillDispatchDecision,
    options: { emitEvent?: boolean } = {},
  ): void {
    const state = this.sessionState.getCell(sessionId);
    const activeSkillName = state.activeSkill ?? null;
    const shouldStorePending = decision.mode !== "none";
    if (!shouldStorePending) {
      state.pendingDispatch = undefined;
    } else {
      state.pendingDispatch = decision;
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
    return this.sessionState.getExistingCell(sessionId)?.pendingDispatch;
  }

  clearPendingDispatch(sessionId: string): SkillDispatchDecision | undefined {
    const state = this.sessionState.getExistingCell(sessionId);
    const pending = state?.pendingDispatch;
    if (state) {
      state.pendingDispatch = undefined;
    }
    return pending;
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
  ): SkillOutputValidationResult {
    const skill = this.getActiveSkill(sessionId);
    if (!skill) {
      return { ok: true, missing: [], invalid: [] };
    }

    const expected = listSkillOutputs(skill.contract);
    const outputContracts = getSkillOutputContracts(skill.contract);
    const missing = expected.filter((name) => !isSatisfied(outputs[name]));
    const invalid = expected.flatMap((name) => {
      if (missing.includes(name)) {
        return [];
      }
      const contract = outputContracts[name];
      if (!contract) {
        return [];
      }
      const reason = validateOutputContract(outputs[name], contract, name);
      return reason ? [{ name, reason }] : [];
    });

    if (missing.length === 0 && invalid.length === 0) {
      return { ok: true, missing: [], invalid: [] };
    }
    return { ok: false, missing, invalid };
  }

  completeSkill(sessionId: string, outputs: Record<string, unknown>): SkillOutputValidationResult {
    const state = this.sessionState.getCell(sessionId);
    const activeSkillName = state.activeSkill ?? null;
    const validation = this.validateSkillOutputs(sessionId, outputs);
    if (!validation.ok) {
      return validation;
    }

    if (activeSkillName) {
      const completedAt = Date.now();
      state.skillOutputs.set(activeSkillName, {
        skillName: activeSkillName,
        completedAt,
        outputs,
      });
      const outputKeys = Object.keys(outputs).toSorted();

      state.activeSkill = undefined;
      state.toolCalls = 0;

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

      this.maybePromoteTaskSpec(sessionId, outputs);
    }
    return validation;
  }

  getSkillOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined {
    return this.sessionState.getExistingCell(sessionId)?.skillOutputs.get(skillName)?.outputs;
  }

  getAvailableConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown> {
    const targetSkill = this.skills.get(targetSkillName);
    if (!targetSkill) return {};
    const requestedInputs = [
      ...(targetSkill.contract.requires ?? []),
      ...(targetSkill.contract.consumes ?? []),
    ];
    if (requestedInputs.length === 0) return {};

    const consumeSet = new Set(requestedInputs);
    const result: Record<string, unknown> = {};
    const sessionOutputs = this.sessionState.getExistingCell(sessionId)?.skillOutputs;
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
    const sessionOutputs = this.sessionState.getExistingCell(sessionId)?.skillOutputs;
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

  private maybePromoteTaskSpec(sessionId: string, outputs: Record<string, unknown>): void {
    if (!this.setTaskSpec || !this.getTaskState) return;
    const taskState = this.getTaskState(sessionId);
    if (taskState.spec) return;

    const nextSpec = deriveTaskSpecFromOutputs(outputs);
    if (!nextSpec) return;
    this.setTaskSpec(sessionId, nextSpec);
  }
}
