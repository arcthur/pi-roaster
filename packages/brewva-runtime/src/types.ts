import type { TurnEnvelope } from "./channels/turn.js";
import type { JsonValue } from "./utils/json.js";

export type VerificationLevel = "quick" | "standard" | "strict";
export type SkillTier = "base" | "pack" | "project";
export type SkillCostHint = "low" | "medium" | "high";

export interface SkillContract {
  name: string;
  tier: SkillTier;
  tags: string[];
  antiTags?: string[];
  tools: {
    required: string[];
    optional: string[];
    denied: string[];
  };
  budget: {
    maxToolCalls: number;
    maxTokens: number;
  };
  outputs?: string[];
  composableWith?: string[];
  consumes?: string[];
  escalationPath?: Record<string, string>;
  maxParallel?: number;
  stability?: "experimental" | "stable" | "deprecated";
  version?: string;
  description?: string;
  costHint?: SkillCostHint;
}

export interface SkillContractOverride extends Omit<Partial<SkillContract>, "tools" | "budget"> {
  tools?: Partial<SkillContract["tools"]>;
  budget?: Partial<SkillContract["budget"]>;
}

export interface SkillDocument {
  name: string;
  description: string;
  tier: SkillTier;
  filePath: string;
  baseDir: string;
  markdown: string;
  contract: SkillContract;
}

export interface SkillsIndexEntry {
  name: string;
  tier: SkillTier;
  description: string;
  tags: string[];
  antiTags: string[];
  toolsRequired: string[];
  costHint: SkillCostHint;
  stability: "experimental" | "stable" | "deprecated";
  composableWith: string[];
  consumes: string[];
}

export interface SkillSelection {
  name: string;
  score: number;
  reason: string;
}

export interface SkillOutputRecord {
  skillName: string;
  completedAt: number;
  outputs: Record<string, unknown>;
}

export interface CreateBrewvaSessionOptions {
  cwd?: string;
  configPath?: string;
  model?: string;
  activePacks?: string[];
  enableExtensions?: boolean;
}

export type TaskSpecSchema = "brewva.task.v1";

export interface TaskSpec {
  schema: TaskSpecSchema;
  goal: string;
  targets?: {
    files?: string[];
    symbols?: string[];
  };
  expectedBehavior?: string;
  constraints?: string[];
  verification?: {
    level?: VerificationLevel;
    commands?: string[];
  };
}

export type TaskItemStatus = "todo" | "doing" | "done" | "blocked";

export type TaskPhase = "align" | "investigate" | "execute" | "verify" | "blocked" | "done";

export type TaskHealth =
  | "ok"
  | "needs_spec"
  | "blocked"
  | "verification_failed"
  | "budget_pressure"
  | "unknown";

export interface TaskStatus {
  phase: TaskPhase;
  health: TaskHealth;
  reason?: string;
  updatedAt: number;
  truthFactIds?: string[];
}

export interface TaskItem {
  id: string;
  text: string;
  status: TaskItemStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TaskBlocker {
  id: string;
  message: string;
  createdAt: number;
  source?: string;
  truthFactId?: string;
}

export interface TaskState {
  spec?: TaskSpec;
  status?: TaskStatus;
  items: TaskItem[];
  blockers: TaskBlocker[];
  updatedAt: number | null;
}

export type ScheduleContinuityMode = "inherit" | "fresh";

export type ConvergencePredicate =
  | { kind: "truth_resolved"; factId: string }
  | { kind: "task_phase"; phase: TaskPhase }
  | { kind: "max_runs"; limit: number }
  | { kind: "all_of"; predicates: ConvergencePredicate[] }
  | { kind: "any_of"; predicates: ConvergencePredicate[] };

export type ScheduleIntentEventKind =
  | "intent_created"
  | "intent_updated"
  | "intent_cancelled"
  | "intent_fired"
  | "intent_converged";

export interface ScheduleIntentEventPayload {
  schema: "brewva.schedule.v1";
  kind: ScheduleIntentEventKind;
  intentId: string;
  cron?: string;
  timeZone?: string;
  runAt?: number;
  reason: string;
  goalRef?: string;
  parentSessionId: string;
  continuityMode: ScheduleContinuityMode;
  maxRuns: number;
  convergenceCondition?: ConvergencePredicate;
  runIndex?: number;
  firedAt?: number;
  nextRunAt?: number;
  childSessionId?: string;
  error?: string;
}

export type ScheduleIntentStatus = "active" | "cancelled" | "converged" | "error";

export interface ScheduleIntentProjectionRecord {
  intentId: string;
  parentSessionId: string;
  reason: string;
  goalRef?: string;
  continuityMode: ScheduleContinuityMode;
  cron?: string;
  timeZone?: string;
  runAt?: number;
  maxRuns: number;
  runCount: number;
  nextRunAt?: number;
  status: ScheduleIntentStatus;
  convergenceCondition?: ConvergencePredicate;
  consecutiveErrors: number;
  leaseUntilMs?: number;
  lastError?: string;
  lastEvaluationSessionId?: string;
  updatedAt: number;
  eventOffset: number;
}

export type TurnWALStatus = "pending" | "inflight" | "done" | "failed" | "expired";

export type TurnWALSource = "channel" | "schedule" | "gateway" | "heartbeat";

export interface TurnWALRecord {
  schema: "brewva.turn-wal.v1";
  walId: string;
  turnId: string;
  sessionId: string;
  channel: string;
  conversationId: string;
  status: TurnWALStatus;
  envelope: TurnEnvelope;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  source: TurnWALSource;
  error?: string;
  ttlMs?: number;
  dedupeKey?: string;
}

export interface TurnWALRecoverySummaryBySource {
  scanned: number;
  retried: number;
  expired: number;
  failed: number;
  skipped: number;
}

export interface TurnWALRecoveryResult {
  recoveredAt: number;
  scanned: number;
  retried: number;
  expired: number;
  failed: number;
  skipped: number;
  compacted: number;
  bySource: Record<TurnWALSource, TurnWALRecoverySummaryBySource>;
}

export interface ScheduleProjectionSnapshot {
  schema: "brewva.schedule.projection.v1";
  generatedAt: number;
  watermarkOffset: number;
  intents: ScheduleIntentProjectionRecord[];
}

export interface ScheduleIntentCreateInput {
  reason: string;
  goalRef?: string;
  continuityMode?: ScheduleContinuityMode;
  runAt?: number;
  cron?: string;
  timeZone?: string;
  maxRuns?: number;
  intentId?: string;
  convergenceCondition?: ConvergencePredicate;
}

export type ScheduleIntentCreateResult =
  | { ok: true; intent: ScheduleIntentProjectionRecord }
  | { ok: false; error: string };

export interface ScheduleIntentCancelInput {
  intentId: string;
  reason?: string;
}

export interface ScheduleIntentCancelResult {
  ok: boolean;
  error?: string;
}

export interface ScheduleIntentUpdateInput {
  intentId: string;
  reason?: string;
  goalRef?: string;
  continuityMode?: ScheduleContinuityMode;
  runAt?: number;
  cron?: string;
  timeZone?: string;
  maxRuns?: number;
  convergenceCondition?: ConvergencePredicate;
}

export type ScheduleIntentUpdateResult =
  | { ok: true; intent: ScheduleIntentProjectionRecord }
  | { ok: false; error: string };

export interface ScheduleIntentListQuery {
  parentSessionId?: string;
  status?: ScheduleIntentStatus;
}

export type TaskLedgerEventPayload =
  | {
      schema: "brewva.task.ledger.v1";
      kind: "spec_set";
      spec: TaskSpec;
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "checkpoint_set";
      state: TaskState;
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "status_set";
      status: TaskStatus;
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "item_added";
      item: {
        id: string;
        text: string;
        status?: TaskItemStatus;
      };
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "item_updated";
      item: {
        id: string;
        text?: string;
        status?: TaskItemStatus;
      };
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "blocker_recorded";
      blocker: {
        id: string;
        message: string;
        source?: string;
        truthFactId?: string;
      };
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "blocker_resolved";
      blockerId: string;
    };

export interface BrewvaConfig {
  ui: {
    quietStartup: boolean;
  };
  skills: {
    roots?: string[];
    packs: string[];
    disabled: string[];
    overrides: Record<string, SkillContractOverride>;
    selector: { k: number };
  };
  verification: {
    defaultLevel: VerificationLevel;
    checks: Record<VerificationLevel, string[]>;
    commands: Record<string, string>;
  };
  ledger: { path: string; checkpointEveryTurns: number };
  tape: {
    checkpointIntervalEntries: number;
  };
  memory: {
    enabled: boolean;
    dir: string;
    workingFile: string;
    maxWorkingChars: number;
    dailyRefreshHourLocal: number;
    crystalMinUnits: number;
    retrievalTopK: number;
    retrievalWeights: {
      lexical: number;
      recency: number;
      confidence: number;
    };
    evolvesMode: "off" | "shadow";
    cognitive: {
      mode: "off" | "shadow" | "active";
      maxTokensPerTurn: number;
    };
    global: {
      enabled: boolean;
      minConfidence: number;
    };
  };
  security: {
    mode: "permissive" | "standard" | "strict";
    sanitizeContext: boolean;
    execution: {
      backend: "host" | "sandbox" | "auto";
      enforceIsolation: boolean;
      fallbackToHost: boolean;
      commandDenyList: string[];
      sandbox: {
        serverUrl: string;
        apiKey?: string;
        defaultImage: string;
        memory: number;
        cpus: number;
        timeout: number;
      };
    };
  };
  schedule: {
    enabled: boolean;
    projectionPath: string;
    leaseDurationMs: number;
    maxActiveIntentsPerSession: number;
    maxActiveIntentsGlobal: number;
    minIntervalMs: number;
    maxConsecutiveErrors: number;
    maxRecoveryCatchUps: number;
  };
  parallel: { enabled: boolean; maxConcurrent: number };
  infrastructure: {
    events: {
      enabled: boolean;
      dir: string;
      level: "audit" | "ops" | "debug";
    };
    contextBudget: {
      enabled: boolean;
      maxInjectionTokens: number;
      compactionThresholdPercent: number;
      hardLimitPercent: number;
      truncationStrategy: "drop-entry" | "summarize" | "tail";
      compactionInstructions: string;
    };
    toolFailureInjection: {
      enabled: boolean;
      maxEntries: number;
      maxOutputChars: number;
    };
    interruptRecovery: {
      enabled: boolean;
      gracefulTimeoutMs: number;
    };
    costTracking: {
      enabled: boolean;
      maxCostUsdPerSession: number;
      alertThresholdRatio: number;
      actionOnExceed: "warn" | "block_tools";
    };
    turnWal: {
      enabled: boolean;
      dir: string;
      defaultTtlMs: number;
      maxRetries: number;
      compactAfterMs: number;
      scheduleTurnTtlMs: number;
    };
  };
}

type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends (infer U)[]
    ? DeepPartial<U>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

// JSON file schema for `.brewva/brewva.json` (and global `$XDG_CONFIG_HOME/brewva/brewva.json`).
// This is a patch/overlay file: all fields are optional and merged on top of defaults.
export interface BrewvaConfigFile {
  $schema?: string;
  ui?: Partial<BrewvaConfig["ui"]>;
  skills?: Partial<Omit<BrewvaConfig["skills"], "selector" | "overrides">> & {
    overrides?: BrewvaConfig["skills"]["overrides"];
    selector?: Partial<BrewvaConfig["skills"]["selector"]>;
  };
  verification?: Partial<Omit<BrewvaConfig["verification"], "checks" | "commands">> & {
    checks?: Partial<BrewvaConfig["verification"]["checks"]>;
    commands?: BrewvaConfig["verification"]["commands"];
  };
  ledger?: Partial<BrewvaConfig["ledger"]>;
  tape?: Partial<BrewvaConfig["tape"]>;
  memory?: DeepPartial<BrewvaConfig["memory"]>;
  security?: Partial<Omit<BrewvaConfig["security"], "execution">> & {
    execution?: Partial<Omit<BrewvaConfig["security"]["execution"], "sandbox">> & {
      sandbox?: Partial<BrewvaConfig["security"]["execution"]["sandbox"]>;
    };
  };
  schedule?: Partial<BrewvaConfig["schedule"]>;
  parallel?: Partial<BrewvaConfig["parallel"]>;
  infrastructure?: Partial<
    Omit<
      BrewvaConfig["infrastructure"],
      | "events"
      | "contextBudget"
      | "toolFailureInjection"
      | "interruptRecovery"
      | "costTracking"
      | "turnWal"
    >
  > & {
    events?: Partial<BrewvaConfig["infrastructure"]["events"]>;
    contextBudget?: Partial<BrewvaConfig["infrastructure"]["contextBudget"]>;
    toolFailureInjection?: Partial<BrewvaConfig["infrastructure"]["toolFailureInjection"]>;
    interruptRecovery?: Partial<BrewvaConfig["infrastructure"]["interruptRecovery"]>;
    costTracking?: Partial<BrewvaConfig["infrastructure"]["costTracking"]>;
    turnWal?: Partial<BrewvaConfig["infrastructure"]["turnWal"]>;
  };
}

export interface EvidenceRecord {
  id: string;
  timestamp: number;
  turn: number;
  skill?: string;
  tool: string;
  argsSummary: string;
  outputSummary: string;
  outputHash: string;
  verdict: "pass" | "fail" | "inconclusive";
}

export interface EvidenceLedgerRow extends EvidenceRecord {
  sessionId: string;
  previousHash: string;
  hash: string;
  metadata?: Record<string, JsonValue>;
}

export interface EvidenceQuery {
  file?: string;
  skill?: string;
  verdict?: EvidenceRecord["verdict"];
  tool?: string;
  last?: number;
}

export type TruthFactStatus = "active" | "resolved";

export type TruthFactSeverity = "info" | "warn" | "error";

export interface TruthFact {
  id: string;
  kind: string;
  status: TruthFactStatus;
  severity: TruthFactSeverity;
  summary: string;
  details?: Record<string, JsonValue>;
  evidenceIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt?: number;
}

export interface TruthState {
  facts: TruthFact[];
  updatedAt: number | null;
}

export type TruthLedgerEventPayload =
  | {
      schema: "brewva.truth.ledger.v1";
      kind: "fact_upserted";
      fact: TruthFact;
    }
  | {
      schema: "brewva.truth.ledger.v1";
      kind: "fact_resolved";
      factId: string;
      resolvedAt?: number;
    };

export interface MemoryGlobalSyncSummary {
  schema: "brewva.memory.global.v1";
  generatedAt: number;
  unitCount: number;
  crystalCount: number;
}

export interface MemoryGlobalSyncEventPayload {
  stage: "refresh";
  scannedCandidates: number;
  promoted: number;
  refreshed: number;
  decayed: number;
  pruned: number;
  resolvedByPass: number;
  crystalsCompiled: number;
  crystalsRemoved: number;
  promotedUnitIds: string[];
  globalSummary: MemoryGlobalSyncSummary;
  globalSnapshotRef: string | null;
}

export interface LedgerDigest {
  generatedAt: number;
  sessionId: string;
  records: Array<
    Pick<
      EvidenceLedgerRow,
      "id" | "timestamp" | "tool" | "skill" | "verdict" | "argsSummary" | "outputSummary"
    >
  >;
  summary: {
    total: number;
    pass: number;
    fail: number;
    inconclusive: number;
  };
}

export type VerificationEvidenceKind = "lsp_clean" | "test_or_build_passed";

export type VerificationEvidenceMode = "heuristic" | "compiler" | "command" | "lsp_native";

export interface VerificationEvidence {
  kind: VerificationEvidenceKind;
  timestamp: number;
  tool: string;
  detail?: string;
  mode?: VerificationEvidenceMode;
}

export interface VerificationReport {
  passed: boolean;
  level: VerificationLevel;
  missingEvidence: string[];
  checks: Array<{ name: string; status: "pass" | "fail" | "skip"; evidence?: string }>;
}

export interface VerificationCheckRun {
  timestamp: number;
  ok: boolean;
  command: string;
  exitCode: number | null;
  durationMs: number;
  ledgerId?: string;
  outputSummary?: string;
}

export interface VerificationSessionState {
  lastWriteAt?: number;
  evidence: VerificationEvidence[];
  checkRuns: Record<string, VerificationCheckRun>;
  denialCount: number;
}

export interface ContextBudgetUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export type TapePressureLevel = "none" | "low" | "medium" | "high";

export type ContextPressureLevel = "none" | "low" | "medium" | "high" | "critical" | "unknown";

export interface ContextPressureStatus {
  level: ContextPressureLevel;
  usageRatio: number | null;
  hardLimitRatio: number;
  compactionThresholdRatio: number;
}

export interface ContextCompactionGateStatus {
  required: boolean;
  pressure: ContextPressureStatus;
  recentCompaction: boolean;
  windowTurns: number;
  lastCompactionTurn: number | null;
  turnsSinceCompaction: number | null;
}

export interface TapeAnchorState {
  id: string;
  name?: string;
  summary?: string;
  nextSteps?: string;
  turn?: number;
  timestamp: number;
}

export interface TapeStatusState {
  totalEntries: number;
  entriesSinceAnchor: number;
  entriesSinceCheckpoint: number;
  tapePressure: TapePressureLevel;
  thresholds: {
    low: number;
    medium: number;
    high: number;
  };
  lastAnchor?: TapeAnchorState;
  lastCheckpointId?: string;
}

export type TapeSearchScope = "current_phase" | "all_phases" | "anchors_only";

export interface TapeSearchMatch {
  eventId: string;
  type: string;
  turn?: number;
  timestamp: number;
  excerpt: string;
}

export interface TapeSearchResult {
  query: string;
  scope: TapeSearchScope;
  scannedEvents: number;
  totalEvents: number;
  matches: TapeSearchMatch[];
}

export interface ContextBudgetSessionState {
  turnIndex: number;
  lastCompactionTurn: number;
  lastCompactionAtMs?: number;
  lastContextUsage?: ContextBudgetUsage;
}

export interface ContextInjectionDecision {
  accepted: boolean;
  finalText: string;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
  droppedReason?: "hard_limit";
}

export interface ContextCompactionDecision {
  shouldCompact: boolean;
  reason?: "usage_threshold" | "hard_limit";
  usage?: ContextBudgetUsage;
}

export interface ToolAccessResult {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

export interface ParallelAcquireResult {
  accepted: boolean;
  reason?: "disabled" | "max_concurrent" | "max_total" | "skill_max_parallel";
}

export interface ParallelSnapshot {
  active: number;
  totalStarted: number;
  sessions: Record<string, { active: number; totalStarted: number }>;
}

export type PatchFileAction = "add" | "modify" | "delete";

export interface PatchFileChange {
  path: string;
  action: PatchFileAction;
  beforeHash?: string;
  afterHash?: string;
  diffText?: string;
}

export interface PatchSet {
  id: string;
  createdAt: number;
  summary?: string;
  changes: PatchFileChange[];
}

export type WorkerStatus = "ok" | "error" | "skipped";

export interface WorkerResult {
  workerId: string;
  status: WorkerStatus;
  summary: string;
  patches?: PatchSet;
  evidenceIds?: string[];
  errorMessage?: string;
}

export interface PatchConflict {
  path: string;
  workerIds: string[];
  patchSetIds: string[];
}

export interface WorkerMergeReport {
  status: "empty" | "conflicts" | "merged";
  workerIds: string[];
  conflicts: PatchConflict[];
  mergedPatchSet?: PatchSet;
}

export interface RollbackResult {
  ok: boolean;
  patchSetId?: string;
  restoredPaths: string[];
  failedPaths: string[];
  reason?: "no_patchset" | "restore_failed";
}

export interface BrewvaEventRecord {
  id: string;
  sessionId: string;
  type: string;
  timestamp: number;
  turn?: number;
  payload?: Record<string, JsonValue>;
}

export type BrewvaEventCategory =
  | "session"
  | "turn"
  | "tool"
  | "context"
  | "cost"
  | "verification"
  | "state"
  | "other";

export interface BrewvaStructuredEvent {
  schema: "brewva.event.v1";
  id: string;
  sessionId: string;
  type: string;
  category: BrewvaEventCategory;
  timestamp: number;
  isoTime: string;
  turn?: number;
  payload?: Record<string, JsonValue>;
}

export interface BrewvaEventQuery {
  type?: string;
  last?: number;
}

export interface BrewvaReplaySession {
  sessionId: string;
  eventCount: number;
  lastEventAt: number;
}

export interface ParallelSessionSnapshot {
  activeRunIds: string[];
  totalStarted: number;
}

export interface SessionCostTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface SessionCostSummary extends SessionCostTotals {
  models: Record<string, SessionCostTotals>;
  skills: Record<
    string,
    SessionCostTotals & {
      usageCount: number;
      turns: number;
    }
  >;
  tools: Record<
    string,
    {
      callCount: number;
      allocatedTokens: number;
      allocatedCostUsd: number;
    }
  >;
  alerts: Array<{
    timestamp: number;
    kind: "session_threshold" | "session_cap" | "skill_cap";
    scope: "session" | "skill";
    scopeId?: string;
    costUsd: number;
    thresholdUsd: number;
  }>;
  budget: {
    action: "warn" | "block_tools";
    sessionExceeded: boolean;
    skillExceeded: boolean;
    blocked: boolean;
  };
}
