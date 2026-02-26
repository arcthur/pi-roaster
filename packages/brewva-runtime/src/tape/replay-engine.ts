import type { ToolFailureEntry } from "../context/tool-failures.js";
import {
  TASK_EVENT_TYPE,
  coerceTaskLedgerPayload,
  createEmptyTaskState,
  reduceTaskState,
} from "../task/ledger.js";
import {
  TRUTH_EVENT_TYPE,
  coerceTruthLedgerPayload,
  createEmptyTruthState,
  reduceTruthState,
} from "../truth/ledger.js";
import type { BrewvaEventRecord, SessionCostSummary, TaskState, TruthState } from "../types.js";
import {
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  coerceTapeCheckpointPayload,
  type TapeCheckpointEvidenceState,
  type TapeCheckpointMemoryState,
} from "./events.js";

const TOOL_FAILURE_ANCHOR_TTL = 3;
const MAX_RECENT_TOOL_FAILURES = 48;
const MAX_MEMORY_CRYSTALS = 128;
const TOOL_FAILURE_INFRASTRUCTURE_TOOLS = new Set([
  "ledger_checkpoint",
  "brewva_cost",
  "brewva_context_compaction",
  "brewva_rollback",
  "brewva_verify",
]);

export interface ReplayToolFailureEntry extends ToolFailureEntry {
  anchorEpoch: number;
  timestamp: number;
}

export interface ReplayEvidenceState {
  totalRecords: number;
  failureRecords: number;
  anchorEpoch: number;
  recentFailures: ReplayToolFailureEntry[];
}

export interface ReplayMemoryCrystalState {
  id: string;
  topic: string;
  summary?: string;
  unitCount: number;
  confidence: number;
  updatedAt: number;
}

export interface ReplayMemoryState {
  updatedAt: number | null;
  crystals: ReplayMemoryCrystalState[];
}

export interface ReplayCostState {
  summary: SessionCostSummary;
  updatedAt: number | null;
  skillLastTurnByName: Record<string, number>;
}

export interface TurnReplayView {
  turn: number;
  latestEventId: string | null;
  checkpointEventId: string | null;
  taskState: TaskState;
  truthState: TruthState;
  costState: ReplayCostState;
  evidenceState: ReplayEvidenceState;
  memoryState: ReplayMemoryState;
}

interface TurnReplayEngineOptions {
  listEvents: (sessionId: string) => BrewvaEventRecord[];
  getTurn: (sessionId: string) => number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneTaskState(state: TaskState): TaskState {
  const spec = state.spec
    ? {
        ...state.spec,
        targets: state.spec.targets
          ? {
              files: state.spec.targets.files ? [...state.spec.targets.files] : undefined,
              symbols: state.spec.targets.symbols ? [...state.spec.targets.symbols] : undefined,
            }
          : undefined,
        constraints: state.spec.constraints ? [...state.spec.constraints] : undefined,
        verification: state.spec.verification
          ? {
              level: state.spec.verification.level,
              commands: state.spec.verification.commands
                ? [...state.spec.verification.commands]
                : undefined,
            }
          : undefined,
      }
    : undefined;

  return {
    spec,
    status: state.status
      ? {
          ...state.status,
          truthFactIds: state.status.truthFactIds ? [...state.status.truthFactIds] : undefined,
        }
      : undefined,
    items: state.items.map((item) => ({ ...item })),
    blockers: state.blockers.map((blocker) => ({ ...blocker })),
    updatedAt: state.updatedAt,
  };
}

function cloneTruthState(state: TruthState): TruthState {
  const cloneDetails = (
    details: TruthState["facts"][number]["details"] | undefined,
  ): TruthState["facts"][number]["details"] =>
    details
      ? (JSON.parse(JSON.stringify(details)) as TruthState["facts"][number]["details"])
      : undefined;

  return {
    facts: state.facts.map((fact) => ({
      ...fact,
      evidenceIds: [...fact.evidenceIds],
      details: cloneDetails(fact.details),
    })),
    updatedAt: state.updatedAt,
  };
}

function createEmptyCostSummary(): SessionCostSummary {
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

function cloneCostSummary(summary: SessionCostSummary): SessionCostSummary {
  const models: SessionCostSummary["models"] = {};
  for (const [model, totals] of Object.entries(summary.models)) {
    models[model] = { ...totals };
  }
  const skills: SessionCostSummary["skills"] = {};
  for (const [skill, totals] of Object.entries(summary.skills)) {
    skills[skill] = { ...totals };
  }
  const tools: SessionCostSummary["tools"] = {};
  for (const [tool, entry] of Object.entries(summary.tools)) {
    tools[tool] = { ...entry };
  }
  return {
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cacheReadTokens: summary.cacheReadTokens,
    cacheWriteTokens: summary.cacheWriteTokens,
    totalTokens: summary.totalTokens,
    totalCostUsd: summary.totalCostUsd,
    models,
    skills,
    tools,
    alerts: summary.alerts.map((alert) => ({ ...alert })),
    budget: { ...summary.budget },
  };
}

function createEmptyCostState(): ReplayCostState {
  return {
    summary: createEmptyCostSummary(),
    updatedAt: null,
    skillLastTurnByName: {},
  };
}

function cloneCostSkillLastTurnByName(input: Record<string, number>): Record<string, number> {
  return { ...input };
}

function createEmptyEvidenceState(): ReplayEvidenceState {
  return {
    totalRecords: 0,
    failureRecords: 0,
    anchorEpoch: 0,
    recentFailures: [],
  };
}

function cloneToolFailureEntry(entry: ReplayToolFailureEntry): ReplayToolFailureEntry {
  return {
    ...entry,
    args: JSON.parse(JSON.stringify(entry.args)) as Record<string, unknown>,
  };
}

function createEmptyMemoryState(): ReplayMemoryState {
  return {
    updatedAt: null,
    crystals: [],
  };
}

function normalizeToolFailureTurn(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeNonNegativeNumber(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function parseBudget(
  value: unknown,
  fallback: SessionCostSummary["budget"],
): SessionCostSummary["budget"] {
  if (!isRecord(value)) return fallback;
  const action =
    value.action === "warn" || value.action === "block_tools" ? value.action : fallback.action;
  return {
    action,
    sessionExceeded: value.sessionExceeded === true,
    skillExceeded: value.skillExceeded === true,
    blocked: value.blocked === true,
  };
}

function parseFailureContext(
  payload: JsonRecord,
  fallbackTurn: number,
  timestamp: number,
  anchorEpoch: number,
): ReplayToolFailureEntry | null {
  const raw = payload.failureContext;
  if (!isRecord(raw)) return null;
  const toolName =
    typeof payload.toolName === "string" && payload.toolName.trim().length > 0
      ? payload.toolName.trim()
      : "unknown_tool";
  const args = isRecord(raw.args) ? (raw.args as Record<string, unknown>) : {};
  const outputText = typeof raw.outputText === "string" ? raw.outputText : "";
  if (!outputText) return null;
  const turn = normalizeToolFailureTurn(raw.turn, fallbackTurn);

  return {
    toolName,
    args,
    outputText,
    turn,
    anchorEpoch,
    timestamp,
  };
}

function pruneToolFailures(
  entries: ReplayToolFailureEntry[],
  anchorEpoch: number,
): ReplayToolFailureEntry[] {
  const pruned = entries.filter(
    (entry) => anchorEpoch - entry.anchorEpoch < TOOL_FAILURE_ANCHOR_TTL,
  );
  if (pruned.length <= MAX_RECENT_TOOL_FAILURES) return pruned;
  return pruned.slice(-MAX_RECENT_TOOL_FAILURES);
}

function coerceMemoryCrystalFromEvent(
  payload: JsonRecord,
  timestamp: number,
): ReplayMemoryCrystalState | null {
  const raw = isRecord(payload.crystal) ? payload.crystal : payload;
  const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : null;
  const topic =
    typeof raw.topic === "string" && raw.topic.trim().length > 0 ? raw.topic.trim() : null;
  if (!id || !topic) return null;

  const summary =
    typeof raw.summary === "string" && raw.summary.trim().length > 0 ? raw.summary : undefined;
  const confidence = normalizeNonNegativeNumber(raw.confidence, 0);
  const updatedAt = normalizeNonNegativeNumber(raw.updatedAt, timestamp);
  const unitCount = Array.isArray(raw.unitIds)
    ? raw.unitIds.length
    : normalizeNonNegativeInteger(raw.unitCount, 0);

  return {
    id,
    topic,
    summary,
    unitCount,
    confidence,
    updatedAt,
  };
}

function reduceCostState(
  state: ReplayCostState,
  payload: JsonRecord,
  timestamp: number,
  eventTurn: number,
): ReplayCostState {
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (!model) return state;

  const inputTokens = normalizeNonNegativeNumber(payload.inputTokens, -1);
  const outputTokens = normalizeNonNegativeNumber(payload.outputTokens, -1);
  const cacheReadTokens = normalizeNonNegativeNumber(payload.cacheReadTokens, -1);
  const cacheWriteTokens = normalizeNonNegativeNumber(payload.cacheWriteTokens, -1);
  const totalTokens = normalizeNonNegativeNumber(payload.totalTokens, -1);
  const costUsd = normalizeNonNegativeNumber(payload.costUsd, -1);
  if (
    inputTokens < 0 ||
    outputTokens < 0 ||
    cacheReadTokens < 0 ||
    cacheWriteTokens < 0 ||
    totalTokens < 0 ||
    costUsd < 0
  ) {
    return state;
  }

  const summary = cloneCostSummary(state.summary);
  summary.inputTokens += inputTokens;
  summary.outputTokens += outputTokens;
  summary.cacheReadTokens += cacheReadTokens;
  summary.cacheWriteTokens += cacheWriteTokens;
  summary.totalTokens += totalTokens;
  summary.totalCostUsd += costUsd;

  const modelTotals = summary.models[model] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  };
  modelTotals.inputTokens += inputTokens;
  modelTotals.outputTokens += outputTokens;
  modelTotals.cacheReadTokens += cacheReadTokens;
  modelTotals.cacheWriteTokens += cacheWriteTokens;
  modelTotals.totalTokens += totalTokens;
  modelTotals.totalCostUsd += costUsd;
  summary.models[model] = modelTotals;

  const skillName =
    typeof payload.skill === "string" && payload.skill.trim().length > 0
      ? payload.skill.trim()
      : "(none)";
  const skillTotals = summary.skills[skillName] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    usageCount: 0,
    turns: 0,
  };
  skillTotals.inputTokens += inputTokens;
  skillTotals.outputTokens += outputTokens;
  skillTotals.cacheReadTokens += cacheReadTokens;
  skillTotals.cacheWriteTokens += cacheWriteTokens;
  skillTotals.totalTokens += totalTokens;
  skillTotals.totalCostUsd += costUsd;
  skillTotals.usageCount += 1;
  if (eventTurn > 0) {
    const lastTurn = state.skillLastTurnByName[skillName];
    if (lastTurn !== eventTurn) {
      skillTotals.turns += 1;
    }
  }
  summary.skills[skillName] = skillTotals;

  summary.budget = parseBudget(payload.budget, summary.budget);

  const skillLastTurnByName = { ...state.skillLastTurnByName };
  if (eventTurn > 0) {
    skillLastTurnByName[skillName] = eventTurn;
  }

  return {
    summary,
    updatedAt: Math.max(state.updatedAt ?? 0, timestamp),
    skillLastTurnByName,
  };
}

function reduceCostAlert(
  state: ReplayCostState,
  payload: JsonRecord,
  timestamp: number,
): ReplayCostState {
  const kind =
    payload.kind === "session_threshold" ||
    payload.kind === "session_cap" ||
    payload.kind === "skill_cap"
      ? payload.kind
      : null;
  const scope = payload.scope === "session" || payload.scope === "skill" ? payload.scope : null;
  if (!kind || !scope) return state;

  const costUsd = normalizeNonNegativeNumber(payload.costUsd, -1);
  const thresholdUsd = normalizeNonNegativeNumber(payload.thresholdUsd, -1);
  if (costUsd < 0 || thresholdUsd < 0) return state;

  const summary = cloneCostSummary(state.summary);
  summary.alerts.push({
    kind,
    scope,
    scopeId: typeof payload.scopeId === "string" ? payload.scopeId : undefined,
    costUsd,
    thresholdUsd,
    timestamp,
  });

  const nextBudget = parseBudget(payload.budget, summary.budget);
  const action =
    payload.action === "warn" || payload.action === "block_tools"
      ? payload.action
      : nextBudget.action;
  nextBudget.action = action;
  if (kind === "session_cap") {
    nextBudget.sessionExceeded = true;
  }
  if (kind === "skill_cap") {
    nextBudget.skillExceeded = true;
  }
  nextBudget.blocked =
    nextBudget.action === "block_tools" && (nextBudget.sessionExceeded || nextBudget.skillExceeded);
  summary.budget = nextBudget;
  return {
    ...state,
    summary,
  };
}

function reduceEvidenceState(
  state: ReplayEvidenceState,
  payload: JsonRecord,
  timestamp: number,
  eventTurn: number,
): ReplayEvidenceState {
  const verdict =
    payload.verdict === "pass" || payload.verdict === "fail" || payload.verdict === "inconclusive"
      ? payload.verdict
      : null;
  if (!verdict) return state;

  const next: ReplayEvidenceState = {
    ...state,
    totalRecords: state.totalRecords + 1,
    failureRecords: state.failureRecords + (verdict === "fail" ? 1 : 0),
    recentFailures: state.recentFailures.map((entry) => cloneToolFailureEntry(entry)),
  };

  if (verdict === "fail") {
    const fallbackTurn = normalizeToolFailureTurn(payload.turn, eventTurn);
    const failure = parseFailureContext(payload, fallbackTurn, timestamp, next.anchorEpoch);
    if (failure && !TOOL_FAILURE_INFRASTRUCTURE_TOOLS.has(failure.toolName)) {
      next.recentFailures.push(failure);
      next.recentFailures = pruneToolFailures(next.recentFailures, next.anchorEpoch);
    }
  }
  return next;
}

function reduceMemoryState(
  state: ReplayMemoryState,
  payload: JsonRecord,
  timestamp: number,
): ReplayMemoryState {
  const crystal = coerceMemoryCrystalFromEvent(payload, timestamp);
  if (!crystal) return state;

  const crystals = state.crystals.map((item) => ({ ...item }));
  const index = crystals.findIndex((item) => item.id === crystal.id);
  if (index >= 0) {
    crystals[index] = crystal;
  } else {
    crystals.push(crystal);
  }

  crystals.sort((left, right) => right.updatedAt - left.updatedAt);
  if (crystals.length > MAX_MEMORY_CRYSTALS) {
    crystals.length = MAX_MEMORY_CRYSTALS;
  }

  return {
    updatedAt: Math.max(state.updatedAt ?? 0, crystal.updatedAt),
    crystals,
  };
}

function checkpointEvidenceToReplay(state: TapeCheckpointEvidenceState): ReplayEvidenceState {
  const base: ReplayEvidenceState = {
    totalRecords: state.totalRecords,
    failureRecords: state.failureRecords,
    anchorEpoch: state.anchorEpoch,
    recentFailures: state.recentFailures.map((entry) => ({
      toolName: entry.toolName,
      args: JSON.parse(JSON.stringify(entry.args)) as Record<string, unknown>,
      outputText: entry.outputText,
      turn: entry.turn,
      anchorEpoch: entry.anchorEpoch,
      timestamp: entry.timestamp,
    })),
  };
  base.recentFailures = pruneToolFailures(base.recentFailures, base.anchorEpoch);
  return base;
}

function checkpointMemoryToReplay(state: TapeCheckpointMemoryState): ReplayMemoryState {
  const crystals: ReplayMemoryCrystalState[] = [];
  for (const crystal of state.crystals.slice(0, MAX_MEMORY_CRYSTALS)) {
    crystals.push({
      id: crystal.id,
      topic: crystal.topic,
      summary: crystal.summary,
      unitCount: crystal.unitCount,
      confidence: crystal.confidence,
      updatedAt: crystal.updatedAt,
    });
  }
  return {
    updatedAt: state.updatedAt,
    crystals,
  };
}

function replayEvidenceToCheckpoint(state: ReplayEvidenceState): TapeCheckpointEvidenceState {
  return {
    totalRecords: state.totalRecords,
    failureRecords: state.failureRecords,
    anchorEpoch: state.anchorEpoch,
    recentFailures: state.recentFailures.map((entry) => ({
      toolName: entry.toolName,
      args: JSON.parse(JSON.stringify(entry.args)) as Record<string, unknown>,
      outputText: entry.outputText,
      turn: entry.turn,
      anchorEpoch: entry.anchorEpoch,
      timestamp: entry.timestamp,
    })),
  };
}

function replayMemoryToCheckpoint(state: ReplayMemoryState): TapeCheckpointMemoryState {
  return {
    updatedAt: state.updatedAt,
    crystals: state.crystals.map((crystal) => ({ ...crystal })),
  };
}

function applyEventToView(
  previous: TurnReplayView,
  event: BrewvaEventRecord,
  getTurn: (sessionId: string) => number,
): TurnReplayView {
  if (event.type === TAPE_CHECKPOINT_EVENT_TYPE) {
    const payload = coerceTapeCheckpointPayload(event.payload);
    if (!payload) {
      return {
        ...previous,
        turn: getTurn(event.sessionId),
        latestEventId: event.id,
      };
    }
    return {
      turn: getTurn(event.sessionId),
      latestEventId: event.id,
      checkpointEventId: event.id,
      taskState: cloneTaskState(payload.state.task),
      truthState: cloneTruthState(payload.state.truth),
      costState: {
        summary: cloneCostSummary(payload.state.cost),
        updatedAt: event.timestamp,
        skillLastTurnByName: cloneCostSkillLastTurnByName(payload.state.costSkillLastTurnByName),
      },
      evidenceState: checkpointEvidenceToReplay(payload.state.evidence),
      memoryState: checkpointMemoryToReplay(payload.state.memory),
    };
  }

  let taskState = previous.taskState;
  let truthState = previous.truthState;
  let costState = previous.costState;
  let evidenceState = previous.evidenceState;
  let memoryState = previous.memoryState;

  if (event.type === TASK_EVENT_TYPE) {
    const payload = coerceTaskLedgerPayload(event.payload);
    if (payload) {
      taskState = reduceTaskState(taskState, payload, event.timestamp);
    }
  } else if (event.type === TRUTH_EVENT_TYPE) {
    const payload = coerceTruthLedgerPayload(event.payload);
    if (payload) {
      truthState = reduceTruthState(truthState, payload, event.timestamp);
    }
  } else if (event.type === TAPE_ANCHOR_EVENT_TYPE) {
    const nextAnchorEpoch = evidenceState.anchorEpoch + 1;
    evidenceState = {
      ...evidenceState,
      anchorEpoch: nextAnchorEpoch,
      recentFailures: pruneToolFailures(
        evidenceState.recentFailures.map((entry) => cloneToolFailureEntry(entry)),
        nextAnchorEpoch,
      ),
    };
  } else if (event.type === "tool_result_recorded") {
    if (isRecord(event.payload)) {
      evidenceState = reduceEvidenceState(
        evidenceState,
        event.payload,
        event.timestamp,
        normalizeToolFailureTurn(event.turn, 0),
      );
    }
  } else if (event.type === "cost_update") {
    if (isRecord(event.payload)) {
      costState = reduceCostState(
        costState,
        event.payload,
        event.timestamp,
        normalizeToolFailureTurn(event.turn, 0),
      );
    }
  } else if (event.type === "budget_alert") {
    if (isRecord(event.payload)) {
      costState = reduceCostAlert(costState, event.payload, event.timestamp);
    }
  } else if (event.type === "memory_crystal_compiled") {
    if (isRecord(event.payload)) {
      memoryState = reduceMemoryState(memoryState, event.payload, event.timestamp);
    }
  }

  return {
    turn: getTurn(event.sessionId),
    latestEventId: event.id,
    checkpointEventId: previous.checkpointEventId,
    taskState,
    truthState,
    costState,
    evidenceState,
    memoryState,
  };
}

export class TurnReplayEngine {
  private readonly listEvents: (sessionId: string) => BrewvaEventRecord[];
  private readonly getTurn: (sessionId: string) => number;
  private readonly viewBySession = new Map<string, TurnReplayView>();

  constructor(options: TurnReplayEngineOptions) {
    this.listEvents = options.listEvents;
    this.getTurn = options.getTurn;
  }

  replay(sessionId: string): TurnReplayView {
    const turn = this.getTurn(sessionId);
    const cached = this.viewBySession.get(sessionId);
    if (cached) {
      if (cached.turn !== turn) {
        const withTurn = {
          ...cached,
          turn,
        };
        this.viewBySession.set(sessionId, withTurn);
        return withTurn;
      }
      return cached;
    }

    const events = this.listEvents(sessionId);
    const view = this.buildView(sessionId, events);
    this.viewBySession.set(sessionId, view);
    return view;
  }

  observeEvent(event: BrewvaEventRecord): void {
    const cached = this.viewBySession.get(event.sessionId);
    if (!cached) return;
    if (cached.latestEventId === event.id) return;
    this.viewBySession.set(event.sessionId, applyEventToView(cached, event, this.getTurn));
  }

  getTaskState(sessionId: string): TaskState {
    return cloneTaskState(this.replay(sessionId).taskState);
  }

  getTruthState(sessionId: string): TruthState {
    return cloneTruthState(this.replay(sessionId).truthState);
  }

  getCostSummary(sessionId: string): SessionCostSummary {
    return cloneCostSummary(this.replay(sessionId).costState.summary);
  }

  getCostSkillLastTurnByName(sessionId: string): Record<string, number> {
    return cloneCostSkillLastTurnByName(this.replay(sessionId).costState.skillLastTurnByName);
  }

  getRecentToolFailures(sessionId: string, maxEntries?: number): ToolFailureEntry[] {
    const view = this.replay(sessionId);
    const limit = Math.max(1, Math.floor(maxEntries ?? MAX_RECENT_TOOL_FAILURES));
    return view.evidenceState.recentFailures.slice(-limit).map((entry) => ({
      toolName: entry.toolName,
      args: JSON.parse(JSON.stringify(entry.args)) as Record<string, unknown>,
      outputText: entry.outputText,
      turn: entry.turn,
    }));
  }

  getCheckpointEvidenceState(sessionId: string): TapeCheckpointEvidenceState {
    return replayEvidenceToCheckpoint(this.replay(sessionId).evidenceState);
  }

  getCheckpointMemoryState(sessionId: string): TapeCheckpointMemoryState {
    return replayMemoryToCheckpoint(this.replay(sessionId).memoryState);
  }

  invalidate(sessionId: string): void {
    this.viewBySession.delete(sessionId);
  }

  clear(sessionId: string): void {
    this.invalidate(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.viewBySession.has(sessionId);
  }

  private buildView(sessionId: string, events: BrewvaEventRecord[]): TurnReplayView {
    let checkpointIndex = -1;
    let checkpointEventId: string | null = null;
    let taskState: TaskState = createEmptyTaskState();
    let truthState: TruthState = createEmptyTruthState();
    let costState: ReplayCostState = createEmptyCostState();
    let evidenceState: ReplayEvidenceState = createEmptyEvidenceState();
    let memoryState: ReplayMemoryState = createEmptyMemoryState();

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== TAPE_CHECKPOINT_EVENT_TYPE) continue;
      const payload = coerceTapeCheckpointPayload(event.payload);
      if (!payload) continue;
      checkpointIndex = index;
      checkpointEventId = event.id;
      taskState = cloneTaskState(payload.state.task);
      truthState = cloneTruthState(payload.state.truth);
      costState = {
        summary: cloneCostSummary(payload.state.cost),
        updatedAt: event.timestamp,
        skillLastTurnByName: cloneCostSkillLastTurnByName(payload.state.costSkillLastTurnByName),
      };
      evidenceState = checkpointEvidenceToReplay(payload.state.evidence);
      memoryState = checkpointMemoryToReplay(payload.state.memory);
      break;
    }

    let view: TurnReplayView = {
      turn: this.getTurn(sessionId),
      latestEventId: checkpointEventId,
      checkpointEventId,
      taskState,
      truthState,
      costState,
      evidenceState,
      memoryState,
    };

    const replayStartIndex = checkpointIndex >= 0 ? checkpointIndex + 1 : 0;
    for (let index = replayStartIndex; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
      view = applyEventToView(view, event, this.getTurn);
    }
    return view;
  }
}
