import type { SessionCostSummary, TaskSpec, TaskState, TruthState } from "../types.js";
import { isRecord, normalizeNonEmptyString } from "../utils/coerce.js";

export const TAPE_ANCHOR_EVENT_TYPE = "anchor";
export const TAPE_CHECKPOINT_EVENT_TYPE = "checkpoint";

export const TAPE_ANCHOR_SCHEMA = "brewva.tape.anchor.v1" as const;
export const TAPE_CHECKPOINT_SCHEMA = "brewva.tape.checkpoint.v1" as const;

const TASK_ITEM_STATUSES = ["todo", "doing", "done", "blocked"] as const;
const TASK_PHASES = ["align", "investigate", "execute", "verify", "blocked", "done"] as const;
const TASK_HEALTH_VALUES = [
  "ok",
  "needs_spec",
  "blocked",
  "verification_failed",
  "budget_pressure",
  "unknown",
] as const;
const TRUTH_FACT_STATUSES = ["active", "resolved"] as const;
const TRUTH_FACT_SEVERITIES = ["info", "warn", "error"] as const;

export interface TapeAnchorPayload {
  schema: typeof TAPE_ANCHOR_SCHEMA;
  name: string;
  summary?: string;
  nextSteps?: string;
  createdAt: number;
}

export interface TapeCheckpointPayload {
  schema: typeof TAPE_CHECKPOINT_SCHEMA;
  state: {
    task: TaskState;
    truth: TruthState;
    cost: SessionCostSummary;
    costSkillLastTurnByName: Record<string, number>;
    evidence: TapeCheckpointEvidenceState;
    memory: TapeCheckpointMemoryState;
  };
  basedOnEventId?: string;
  latestAnchorEventId?: string;
  reason: string;
  createdAt: number;
}

export interface TapeCheckpointToolFailureEntry {
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  turn: number;
  anchorEpoch: number;
  timestamp: number;
}

export interface TapeCheckpointEvidenceState {
  totalRecords: number;
  failureRecords: number;
  anchorEpoch: number;
  recentFailures: TapeCheckpointToolFailureEntry[];
}

export interface TapeCheckpointMemoryCrystalState {
  id: string;
  topic: string;
  summary?: string;
  unitCount: number;
  confidence: number;
  updatedAt: number;
}

export interface TapeCheckpointMemoryState {
  updatedAt: number | null;
  crystals: TapeCheckpointMemoryCrystalState[];
}

function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function normalizeOptionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeFiniteNumber(value) ?? undefined;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, value);
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const normalized = normalizeNonEmptyString(item);
    if (!normalized) return null;
    out.push(normalized);
  }
  return out;
}

function isTaskItemStatus(value: unknown): value is TaskState["items"][number]["status"] {
  return typeof value === "string" && (TASK_ITEM_STATUSES as readonly string[]).includes(value);
}

function isTaskPhase(value: unknown): value is NonNullable<TaskState["status"]>["phase"] {
  return typeof value === "string" && (TASK_PHASES as readonly string[]).includes(value);
}

function isTaskHealth(value: unknown): value is NonNullable<TaskState["status"]>["health"] {
  return typeof value === "string" && (TASK_HEALTH_VALUES as readonly string[]).includes(value);
}

function isTruthFactStatus(value: unknown): value is TruthState["facts"][number]["status"] {
  return typeof value === "string" && (TRUTH_FACT_STATUSES as readonly string[]).includes(value);
}

function isTruthFactSeverity(value: unknown): value is TruthState["facts"][number]["severity"] {
  return typeof value === "string" && (TRUTH_FACT_SEVERITIES as readonly string[]).includes(value);
}

function coerceCheckpointTaskState(value: unknown): TaskState | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.items) || !Array.isArray(value.blockers)) return null;

  const items: TaskState["items"] = [];
  for (const rawItem of value.items) {
    if (!isRecord(rawItem)) return null;
    const id = normalizeNonEmptyString(rawItem.id);
    const text = normalizeNonEmptyString(rawItem.text);
    const createdAt = normalizeFiniteNumber(rawItem.createdAt);
    const updatedAt = normalizeFiniteNumber(rawItem.updatedAt);
    const status = isTaskItemStatus(rawItem.status) ? rawItem.status : null;
    if (!id || !text || createdAt === null || updatedAt === null || !status) return null;
    items.push({
      id,
      text,
      status,
      createdAt,
      updatedAt,
    });
  }

  const blockers: TaskState["blockers"] = [];
  for (const rawBlocker of value.blockers) {
    if (!isRecord(rawBlocker)) return null;
    const id = normalizeNonEmptyString(rawBlocker.id);
    const message = normalizeNonEmptyString(rawBlocker.message);
    const createdAt = normalizeFiniteNumber(rawBlocker.createdAt);
    const source = normalizeNonEmptyString(rawBlocker.source);
    const truthFactId = normalizeNonEmptyString(rawBlocker.truthFactId);
    if (!id || !message || createdAt === null) return null;
    blockers.push({
      id,
      message,
      createdAt,
      source,
      truthFactId,
    });
  }

  let spec: TaskState["spec"] | undefined;
  if (value.spec !== undefined) {
    if (!isRecord(value.spec)) return null;
    if (value.spec.schema !== "brewva.task.v1") return null;
    const goal = normalizeNonEmptyString(value.spec.goal);
    if (!goal) return null;
    const rawSpec = value.spec;
    let targets: TaskSpec["targets"];
    if (rawSpec.targets !== undefined) {
      if (!isRecord(rawSpec.targets)) return null;
      targets = {
        files: Array.isArray(rawSpec.targets.files)
          ? rawSpec.targets.files.filter(
              (item: unknown): item is string => typeof item === "string",
            )
          : undefined,
        symbols: Array.isArray(rawSpec.targets.symbols)
          ? rawSpec.targets.symbols.filter(
              (item: unknown): item is string => typeof item === "string",
            )
          : undefined,
      };
    }
    const expectedBehavior = normalizeNonEmptyString(rawSpec.expectedBehavior);
    const constraints = Array.isArray(rawSpec.constraints)
      ? rawSpec.constraints.filter((item: unknown): item is string => typeof item === "string")
      : undefined;
    let verification: TaskSpec["verification"];
    if (rawSpec.verification !== undefined) {
      if (!isRecord(rawSpec.verification)) return null;
      verification = {
        level:
          typeof rawSpec.verification.level === "string" &&
          (["quick", "standard", "strict"] as readonly string[]).includes(
            rawSpec.verification.level,
          )
            ? (rawSpec.verification.level as "quick" | "standard" | "strict")
            : undefined,
        commands: Array.isArray(rawSpec.verification.commands)
          ? rawSpec.verification.commands.filter(
              (item: unknown): item is string => typeof item === "string",
            )
          : undefined,
      };
    }
    spec = {
      schema: "brewva.task.v1",
      goal,
      targets,
      expectedBehavior,
      constraints,
      verification,
    };
  }

  let status: TaskState["status"] | undefined;
  if (value.status !== undefined) {
    if (!isRecord(value.status)) return null;
    const phase = isTaskPhase(value.status.phase) ? value.status.phase : null;
    const health = isTaskHealth(value.status.health) ? value.status.health : null;
    const updatedAt = normalizeFiniteNumber(value.status.updatedAt);
    if (!phase || !health || updatedAt === null) return null;
    let truthFactIds: string[] | undefined;
    if (value.status.truthFactIds !== undefined) {
      const normalizedTruthFactIds = normalizeStringArray(value.status.truthFactIds);
      if (!normalizedTruthFactIds) return null;
      truthFactIds = normalizedTruthFactIds;
    }
    status = {
      phase,
      health,
      reason: normalizeNonEmptyString(value.status.reason),
      updatedAt,
      truthFactIds,
    };
  }

  let updatedAt: number | null = null;
  if (value.updatedAt !== null && value.updatedAt !== undefined) {
    const normalized = normalizeFiniteNumber(value.updatedAt);
    if (normalized === null) return null;
    updatedAt = normalized;
  }

  return {
    spec,
    status,
    items,
    blockers,
    updatedAt,
  };
}

function coerceCheckpointTruthState(value: unknown): TruthState | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.facts)) return null;

  const facts: TruthState["facts"] = [];
  for (const rawFact of value.facts) {
    if (!isRecord(rawFact)) return null;
    const id = normalizeNonEmptyString(rawFact.id);
    const kind = normalizeNonEmptyString(rawFact.kind);
    const status = isTruthFactStatus(rawFact.status) ? rawFact.status : null;
    const severity = isTruthFactSeverity(rawFact.severity) ? rawFact.severity : null;
    const summary = normalizeNonEmptyString(rawFact.summary);
    const evidenceIds = normalizeStringArray(rawFact.evidenceIds);
    const firstSeenAt = normalizeFiniteNumber(rawFact.firstSeenAt);
    const lastSeenAt = normalizeFiniteNumber(rawFact.lastSeenAt);
    const resolvedAt = normalizeOptionalFiniteNumber(rawFact.resolvedAt);
    if (
      !id ||
      !kind ||
      !status ||
      !severity ||
      !summary ||
      !evidenceIds ||
      firstSeenAt === null ||
      lastSeenAt === null
    ) {
      return null;
    }

    facts.push({
      id,
      kind,
      status,
      severity,
      summary,
      evidenceIds,
      details: isRecord(rawFact.details)
        ? (rawFact.details as TruthState["facts"][number]["details"])
        : undefined,
      firstSeenAt,
      lastSeenAt,
      resolvedAt,
    });
  }

  let updatedAt: number | null = null;
  if (value.updatedAt !== null && value.updatedAt !== undefined) {
    const normalized = normalizeFiniteNumber(value.updatedAt);
    if (normalized === null) return null;
    updatedAt = normalized;
  }

  return {
    facts,
    updatedAt,
  };
}

function coerceSessionCostTotals(value: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd: number;
} | null {
  if (!isRecord(value)) return null;
  const inputTokens = normalizeNonNegativeNumber(value.inputTokens);
  const outputTokens = normalizeNonNegativeNumber(value.outputTokens);
  const cacheReadTokens = normalizeNonNegativeNumber(value.cacheReadTokens);
  const cacheWriteTokens = normalizeNonNegativeNumber(value.cacheWriteTokens);
  const totalTokens = normalizeNonNegativeNumber(value.totalTokens);
  const totalCostUsd = normalizeNonNegativeNumber(value.totalCostUsd);
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null ||
    totalTokens === null ||
    totalCostUsd === null
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    totalCostUsd,
  };
}

function coerceSessionCostSummary(value: unknown): SessionCostSummary | null {
  if (!isRecord(value)) return null;
  const totals = coerceSessionCostTotals(value);
  if (!totals) return null;

  const models: SessionCostSummary["models"] = {};
  if (isRecord(value.models)) {
    for (const [model, rawTotals] of Object.entries(value.models)) {
      const parsed = coerceSessionCostTotals(rawTotals);
      if (!parsed) continue;
      models[model] = parsed;
    }
  }

  const skills: SessionCostSummary["skills"] = {};
  if (isRecord(value.skills)) {
    for (const [skillName, rawSkill] of Object.entries(value.skills)) {
      if (!isRecord(rawSkill)) continue;
      const parsedTotals = coerceSessionCostTotals(rawSkill);
      const usageCount = normalizeNonNegativeInteger(rawSkill.usageCount);
      const turns = normalizeNonNegativeInteger(rawSkill.turns);
      if (!parsedTotals || usageCount === null || turns === null) continue;
      skills[skillName] = {
        ...parsedTotals,
        usageCount,
        turns,
      };
    }
  }

  const tools: SessionCostSummary["tools"] = {};
  if (isRecord(value.tools)) {
    for (const [toolName, rawTool] of Object.entries(value.tools)) {
      if (!isRecord(rawTool)) continue;
      const callCount = normalizeNonNegativeInteger(rawTool.callCount);
      const allocatedTokens = normalizeNonNegativeNumber(rawTool.allocatedTokens);
      const allocatedCostUsd = normalizeNonNegativeNumber(rawTool.allocatedCostUsd);
      if (callCount === null || allocatedTokens === null || allocatedCostUsd === null) continue;
      tools[toolName] = {
        callCount,
        allocatedTokens,
        allocatedCostUsd,
      };
    }
  }

  const alerts: SessionCostSummary["alerts"] = [];
  if (Array.isArray(value.alerts)) {
    for (const rawAlert of value.alerts) {
      if (!isRecord(rawAlert)) continue;
      const kind =
        rawAlert.kind === "session_threshold" ||
        rawAlert.kind === "session_cap" ||
        rawAlert.kind === "skill_cap"
          ? rawAlert.kind
          : null;
      const scope =
        rawAlert.scope === "session" || rawAlert.scope === "skill" ? rawAlert.scope : null;
      const timestamp = normalizeNonNegativeNumber(rawAlert.timestamp);
      const costUsd = normalizeNonNegativeNumber(rawAlert.costUsd);
      const thresholdUsd = normalizeNonNegativeNumber(rawAlert.thresholdUsd);
      if (!kind || !scope || timestamp === null || costUsd === null || thresholdUsd === null) {
        continue;
      }
      alerts.push({
        kind,
        scope,
        timestamp,
        costUsd,
        thresholdUsd,
        scopeId: normalizeNonEmptyString(rawAlert.scopeId),
      });
    }
  }

  const budgetRecord = isRecord(value.budget) ? value.budget : {};
  const action: SessionCostSummary["budget"]["action"] =
    budgetRecord.action === "warn" || budgetRecord.action === "block_tools"
      ? budgetRecord.action
      : "warn";
  const budget: SessionCostSummary["budget"] = {
    action,
    sessionExceeded: budgetRecord.sessionExceeded === true,
    skillExceeded: budgetRecord.skillExceeded === true,
    blocked: budgetRecord.blocked === true,
  };

  return {
    ...totals,
    models,
    skills,
    tools,
    alerts,
    budget,
  };
}

function coerceCostSkillLastTurnByName(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [skillName, rawTurn] of Object.entries(value)) {
    const turn = normalizeNonNegativeInteger(rawTurn);
    if (turn === null) continue;
    out[skillName] = turn;
  }
  return out;
}

function coerceCheckpointToolFailureEntry(value: unknown): TapeCheckpointToolFailureEntry | null {
  if (!isRecord(value)) return null;
  const toolName = normalizeNonEmptyString(value.toolName);
  const outputText = typeof value.outputText === "string" ? value.outputText : null;
  const turn = normalizeNonNegativeInteger(value.turn);
  const anchorEpoch = normalizeNonNegativeInteger(value.anchorEpoch);
  const timestamp = normalizeNonNegativeNumber(value.timestamp);
  if (
    !toolName ||
    outputText === null ||
    turn === null ||
    anchorEpoch === null ||
    timestamp === null
  ) {
    return null;
  }

  const args = isRecord(value.args) ? value.args : {};
  return {
    toolName,
    args,
    outputText,
    turn,
    anchorEpoch,
    timestamp,
  };
}

function coerceCheckpointEvidenceState(value: unknown): TapeCheckpointEvidenceState | null {
  if (!isRecord(value)) return null;
  const totalRecords = normalizeNonNegativeInteger(value.totalRecords);
  const failureRecords = normalizeNonNegativeInteger(value.failureRecords);
  const anchorEpoch = normalizeNonNegativeInteger(value.anchorEpoch);
  if (totalRecords === null || failureRecords === null || anchorEpoch === null) return null;

  const recentFailures: TapeCheckpointToolFailureEntry[] = [];
  if (Array.isArray(value.recentFailures)) {
    for (const rawFailure of value.recentFailures) {
      const parsed = coerceCheckpointToolFailureEntry(rawFailure);
      if (!parsed) continue;
      recentFailures.push(parsed);
    }
  }

  return {
    totalRecords,
    failureRecords,
    anchorEpoch,
    recentFailures,
  };
}

function coerceCheckpointMemoryCrystalState(
  value: unknown,
): TapeCheckpointMemoryCrystalState | null {
  if (!isRecord(value)) return null;
  const id = normalizeNonEmptyString(value.id);
  const topic = normalizeNonEmptyString(value.topic);
  const summary = normalizeNonEmptyString(value.summary);
  const unitCount = normalizeNonNegativeInteger(value.unitCount);
  const confidence = normalizeNonNegativeNumber(value.confidence);
  const updatedAt = normalizeNonNegativeNumber(value.updatedAt);
  if (!id || !topic || unitCount === null || confidence === null || updatedAt === null) {
    return null;
  }
  return {
    id,
    topic,
    summary,
    unitCount,
    confidence,
    updatedAt,
  };
}

function coerceCheckpointMemoryState(value: unknown): TapeCheckpointMemoryState | null {
  if (!isRecord(value)) return null;

  let updatedAt: number | null = null;
  if (value.updatedAt !== null && value.updatedAt !== undefined) {
    const normalized = normalizeNonNegativeNumber(value.updatedAt);
    if (normalized === null) return null;
    updatedAt = normalized;
  }

  const crystals: TapeCheckpointMemoryCrystalState[] = [];
  if (Array.isArray(value.crystals)) {
    for (const rawCrystal of value.crystals) {
      const parsed = coerceCheckpointMemoryCrystalState(rawCrystal);
      if (!parsed) continue;
      crystals.push(parsed);
    }
  }

  return {
    updatedAt,
    crystals,
  };
}

function createEmptySessionCostSummary(): SessionCostSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    models: {},
    skills: {},
    tools: {},
    alerts: [],
    budget: {
      action: "warn",
      sessionExceeded: false,
      skillExceeded: false,
      blocked: false,
    },
  };
}

function createEmptyCheckpointEvidenceState(): TapeCheckpointEvidenceState {
  return {
    totalRecords: 0,
    failureRecords: 0,
    anchorEpoch: 0,
    recentFailures: [],
  };
}

function createEmptyCheckpointMemoryState(): TapeCheckpointMemoryState {
  return {
    updatedAt: null,
    crystals: [],
  };
}

export function buildTapeAnchorPayload(input: {
  name: string;
  summary?: string;
  nextSteps?: string;
  createdAt?: number;
}): TapeAnchorPayload {
  return {
    schema: TAPE_ANCHOR_SCHEMA,
    name: input.name,
    summary: input.summary,
    nextSteps: input.nextSteps,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function buildTapeCheckpointPayload(input: {
  taskState: TaskState;
  truthState: TruthState;
  costSummary: SessionCostSummary;
  costSkillLastTurnByName?: Record<string, number>;
  evidenceState: TapeCheckpointEvidenceState;
  memoryState: TapeCheckpointMemoryState;
  basedOnEventId?: string;
  latestAnchorEventId?: string;
  reason: string;
  createdAt?: number;
}): TapeCheckpointPayload {
  return {
    schema: TAPE_CHECKPOINT_SCHEMA,
    state: {
      task: input.taskState,
      truth: input.truthState,
      cost: input.costSummary,
      costSkillLastTurnByName: input.costSkillLastTurnByName ?? {},
      evidence: input.evidenceState,
      memory: input.memoryState,
    },
    basedOnEventId: input.basedOnEventId,
    latestAnchorEventId: input.latestAnchorEventId,
    reason: input.reason,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function coerceTapeAnchorPayload(value: unknown): TapeAnchorPayload | null {
  if (!isRecord(value)) return null;
  if (value.schema !== TAPE_ANCHOR_SCHEMA) return null;
  const name = normalizeNonEmptyString(value.name);
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : null;
  if (!name || createdAt === null) return null;
  const summary = normalizeNonEmptyString(value.summary);
  const nextSteps = normalizeNonEmptyString(value.nextSteps);
  return {
    schema: TAPE_ANCHOR_SCHEMA,
    name,
    summary,
    nextSteps,
    createdAt,
  };
}

export function coerceTapeCheckpointPayload(value: unknown): TapeCheckpointPayload | null {
  if (!isRecord(value)) return null;
  if (value.schema !== TAPE_CHECKPOINT_SCHEMA) return null;
  if (!isRecord(value.state)) return null;
  const task = coerceCheckpointTaskState(value.state.task);
  const truth = coerceCheckpointTruthState(value.state.truth);
  if (!task || !truth) return null;

  const reason = normalizeNonEmptyString(value.reason);
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : null;
  if (!reason || createdAt === null) return null;

  const basedOnEventId = normalizeNonEmptyString(value.basedOnEventId);
  const latestAnchorEventId = normalizeNonEmptyString(value.latestAnchorEventId);
  const cost =
    value.state.cost === undefined
      ? createEmptySessionCostSummary()
      : coerceSessionCostSummary(value.state.cost);
  const costSkillLastTurnByName =
    value.state.costSkillLastTurnByName === undefined
      ? {}
      : coerceCostSkillLastTurnByName(value.state.costSkillLastTurnByName);
  const evidence =
    value.state.evidence === undefined
      ? createEmptyCheckpointEvidenceState()
      : coerceCheckpointEvidenceState(value.state.evidence);
  const memory =
    value.state.memory === undefined
      ? createEmptyCheckpointMemoryState()
      : coerceCheckpointMemoryState(value.state.memory);
  if (!cost || !costSkillLastTurnByName || !evidence || !memory) return null;

  return {
    schema: TAPE_CHECKPOINT_SCHEMA,
    state: {
      task,
      truth,
      cost,
      costSkillLastTurnByName,
      evidence,
      memory,
    },
    basedOnEventId,
    latestAnchorEventId,
    reason,
    createdAt,
  };
}
