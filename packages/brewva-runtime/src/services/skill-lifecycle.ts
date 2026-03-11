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

function hasInformativeValue(value: unknown, options: InformativeTextOptions = {}): boolean {
  if (isInformativeText(value, options)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasInformativeValue(entry, options));
  }
  if (isRecord(value)) {
    return Object.values(value).some((entry) => hasInformativeValue(entry, options));
  }
  return false;
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

function isPathLikeText(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0 || isPlaceholderText(normalized)) {
    return false;
  }
  if (!/^[A-Za-z0-9._@/-]+$/u.test(normalized)) {
    return false;
  }
  return (
    /[\\/]/u.test(normalized) ||
    /\./u.test(normalized) ||
    /[A-Z]/u.test(normalized) ||
    /(?:^|[\\/])[a-z0-9._-]*file$/u.test(normalized)
  );
}

function validateObjectContract(
  value: unknown,
  contract: Extract<SkillOutputContract, { kind: "object" }>,
  label: string,
): string | null {
  if (!isRecord(value)) {
    return `${label} must be an object`;
  }
  const keys = Object.keys(value);
  const minKeys = contract.minKeys ?? 1;
  if (keys.length < minKeys) {
    return `${label} must contain at least ${minKeys} field${minKeys === 1 ? "" : "s"}`;
  }
  const required = contract.required ?? [];
  for (const requiredField of required) {
    if (
      !Object.prototype.hasOwnProperty.call(value, requiredField) ||
      !isSatisfied(value[requiredField])
    ) {
      return `${label} must include '${requiredField}'`;
    }
  }
  for (const [propertyName, propertyContract] of Object.entries(contract.properties ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(value, propertyName)) {
      continue;
    }
    const reason = validateOutputContract(
      value[propertyName],
      propertyContract,
      `${label}.${propertyName}`,
    );
    if (reason) {
      return reason;
    }
  }
  if (
    contract.requireAnyInformativeField === true &&
    !Object.values(value).some((entry) =>
      hasInformativeValue(entry, { minWords: 2, minLength: 12 }),
    )
  ) {
    return `${label} must include at least one informative field`;
  }
  return null;
}

function validateOutputContract(
  value: unknown,
  contract: SkillOutputContract,
  label: string,
): string | null {
  switch (contract.kind) {
    case "informative_text":
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
    case "informative_list": {
      const minItems = contract.minItems ?? 1;
      if (!Array.isArray(value) || value.length < minItems) {
        return `${label} must contain at least ${minItems} informative item${minItems === 1 ? "" : "s"}`;
      }
      const textOptions = {
        minWords: contract.minWords,
        minLength: contract.minLength,
      };
      for (const [index, entry] of value.entries()) {
        if (typeof entry === "string" && isInformativeText(entry, textOptions)) {
          continue;
        }
        if (
          contract.allowObjects === true &&
          isRecord(entry) &&
          Object.values(entry).some((field) => hasInformativeValue(field, textOptions))
        ) {
          continue;
        }
        return `${label} item ${index + 1} must be informative`;
      }
      return null;
    }
    case "path_list": {
      const minItems = contract.minItems ?? 1;
      if (!Array.isArray(value) || value.length < minItems) {
        return `${label} must contain at least ${minItems} path${minItems === 1 ? "" : "s"}`;
      }
      for (const [index, entry] of value.entries()) {
        const text = normalizeText(entry);
        if (text && isPathLikeText(text)) {
          continue;
        }
        return `${label} item ${index + 1} must be a concrete relative path`;
      }
      return null;
    }
    case "object":
      return validateObjectContract(value, contract, label);
    case "record_list": {
      const minItems = contract.minItems ?? 1;
      if (!Array.isArray(value) || value.length < minItems) {
        return `${label} must contain at least ${minItems} record${minItems === 1 ? "" : "s"}`;
      }
      for (const [index, entry] of value.entries()) {
        const reason = validateObjectContract(
          entry,
          {
            kind: "object",
            minKeys: 1,
            required: contract.required,
            properties: contract.properties,
            requireAnyInformativeField: contract.requireAnyInformativeField,
          },
          `${label} entry ${index + 1}`,
        );
        if (reason) {
          return reason;
        }
      }
      return null;
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
    case "one_of": {
      for (const variant of contract.variants) {
        if (!validateOutputContract(value, variant, label)) {
          return null;
        }
      }
      return `${label} does not satisfy any declared output contract variant`;
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
  ): SkillOutputValidationResult {
    const skill = this.getActiveSkill(sessionId);
    if (!skill) {
      return { ok: true, missing: [], invalid: [] };
    }

    const expected = skill.contract.outputs ?? [];
    const outputContracts = skill.contract.outputContracts ?? {};
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
    const activeSkillName = this.sessionState.activeSkillsBySession.get(sessionId) ?? null;
    const validation = this.validateSkillOutputs(sessionId, outputs);
    if (!validation.ok) {
      return validation;
    }

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

      this.sessionState.activeSkillsBySession.delete(sessionId);
      this.sessionState.toolCallsBySession.delete(sessionId);

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
    return this.sessionState.skillOutputsBySession.get(sessionId)?.get(skillName)?.outputs;
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

  private maybePromoteTaskSpec(sessionId: string, outputs: Record<string, unknown>): void {
    if (!this.setTaskSpec || !this.getTaskState) return;
    const taskState = this.getTaskState(sessionId);
    if (taskState.spec) return;
    const phase = taskState.status?.phase;
    if (phase && phase !== "align") return;

    const nextSpec = deriveTaskSpecFromOutputs(outputs);
    if (!nextSpec) return;
    this.setTaskSpec(sessionId, nextSpec);
  }
}
