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

export interface CreateRoasterSessionOptions {
  cwd?: string;
  configPath?: string;
  model?: string;
  activePacks?: string[];
  enableExtensions?: boolean;
}

export type TaskSpecSchema = "roaster.task.v1";

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
}

export interface TaskState {
  spec?: TaskSpec;
  items: TaskItem[];
  blockers: TaskBlocker[];
  updatedAt: number | null;
}

export type TaskLedgerEventPayload =
  | {
      schema: "roaster.task.ledger.v1";
      kind: "spec_set";
      spec: TaskSpec;
    }
  | {
      schema: "roaster.task.ledger.v1";
      kind: "checkpoint_set";
      state: TaskState;
    }
  | {
      schema: "roaster.task.ledger.v1";
      kind: "item_added";
      item: {
        id: string;
        text: string;
        status?: TaskItemStatus;
      };
    }
  | {
      schema: "roaster.task.ledger.v1";
      kind: "item_updated";
      item: {
        id: string;
        text?: string;
        status?: TaskItemStatus;
      };
    }
  | {
      schema: "roaster.task.ledger.v1";
      kind: "blocker_recorded";
      blocker: {
        id: string;
        message: string;
        source?: string;
      };
    }
  | {
      schema: "roaster.task.ledger.v1";
      kind: "blocker_resolved";
      blockerId: string;
    };

export interface TaskSessionSnapshot {
  schema: "roaster.task.snapshot.v1";
  state: TaskState;
}

export interface RoasterConfig {
  skills: {
    packs: string[];
    disabled: string[];
    overrides: Record<string, Partial<SkillContract>>;
    selector: { k: number; maxDigestTokens: number };
  };
  verification: {
    defaultLevel: VerificationLevel;
    checks: Record<VerificationLevel, string[]>;
    commands: Record<string, string>;
  };
  ledger: { path: string; digestWindow: number; checkpointEveryTurns: number };
  security: {
    sanitizeContext: boolean;
    enforceDeniedTools: boolean;
    /**
     * Controls how (required + optional) tool allowlists are applied.
     * - off: only denied tools can block.
     * - warn: allow but emit a warning event the first time a disallowed tool is called per (session, skill, tool).
     * - enforce: block tool calls that are not in the allowlist (unless globally always-allowed).
     */
    allowedToolsMode: "off" | "warn" | "enforce";
    /**
     * Controls how per-skill budget.maxTokens is applied.
     * - off: no enforcement.
     * - warn: allow but emit a warning event when a skill exceeds its token budget.
     * - enforce: block tool calls (except always-allowed lifecycle tools) once the budget is exceeded.
     */
    skillMaxTokensMode: "off" | "warn" | "enforce";
    /**
     * Controls how per-skill maxParallel is applied when acquiring parallel slots.
     * - off: use global parallel config only.
     * - warn: allow but emit a warning event when a skill exceeds its parallel cap.
     * - enforce: reject parallel slot acquisitions once the cap is reached.
     */
    skillMaxParallelMode: "off" | "warn" | "enforce";
  };
  parallel: { enabled: boolean; maxConcurrent: number; maxTotal: number };
  infrastructure: {
    events: {
      enabled: boolean;
      dir: string;
    };
    contextBudget: {
      enabled: boolean;
      maxInjectionTokens: number;
      compactionThresholdPercent: number;
      hardLimitPercent: number;
      minTurnsBetweenCompaction: number;
      minSecondsBetweenCompaction: number;
      pressureBypassPercent: number;
      truncationStrategy: "drop-entry" | "summarize" | "tail";
      compactionInstructions: string;
      compactionCircuitBreaker: {
        enabled: boolean;
        maxConsecutiveFailures: number;
        cooldownTurns: number;
      };
    };
    interruptRecovery: {
      enabled: boolean;
      snapshotsDir: string;
      gracefulTimeoutMs: number;
      resumeHintInjectionEnabled: boolean;
      resumeHintInSystemPrompt?: boolean;
      sessionHandoff: {
        enabled: boolean;
        maxSummaryChars: number;
        relevance: {
          enabled: boolean;
          goalWeight: number;
          failureWeight: number;
          recencyWeight: number;
          artifactWeight: number;
        };
        hierarchy: {
          enabled: boolean;
          branchFactor: number;
          maxLevels: number;
          entriesPerLevel: number;
          maxCharsPerEntry: number;
          goalFilterEnabled: boolean;
          minGoalScore: number;
          maxInjectedEntries: number;
        };
        injectionBudget: {
          enabled: boolean;
          maxTotalChars: number;
          maxUserPreferencesChars: number;
          maxUserHandoffChars: number;
          maxHierarchyChars: number;
          maxUserDigestChars: number;
          maxSessionHandoffChars: number;
          maxSessionDigestChars: number;
        };
        circuitBreaker: {
          enabled: boolean;
          maxConsecutiveFailures: number;
          cooldownTurns: number;
        };
      };
    };
    costTracking: {
      enabled: boolean;
      maxCostUsdPerSession: number;
      maxCostUsdPerSkill: number;
      alertThresholdRatio: number;
      actionOnExceed: "warn" | "block_tools";
    };
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

export interface LedgerDigest {
  generatedAt: number;
  sessionId: string;
  records: Array<Pick<EvidenceLedgerRow, "id" | "timestamp" | "tool" | "skill" | "verdict" | "argsSummary" | "outputSummary">>;
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

export interface RoasterEventRecord {
  id: string;
  sessionId: string;
  type: string;
  timestamp: number;
  turn?: number;
  payload?: Record<string, JsonValue>;
}

export type RoasterEventCategory =
  | "session"
  | "turn"
  | "tool"
  | "context"
  | "cost"
  | "verification"
  | "state"
  | "other";

export interface RoasterStructuredEvent {
  schema: "roaster.event.v1";
  id: string;
  sessionId: string;
  type: string;
  category: RoasterEventCategory;
  timestamp: number;
  isoTime: string;
  turn?: number;
  payload?: Record<string, JsonValue>;
}

export interface RoasterEventQuery {
  type?: string;
  last?: number;
}

export interface RoasterReplaySession {
  sessionId: string;
  eventCount: number;
  lastEventAt: number;
}

export interface ParallelSessionSnapshot {
  activeRunIds: string[];
  totalStarted: number;
}

export interface RuntimeSessionSnapshot {
  version: 1;
  sessionId: string;
  createdAt: number;
  reason: "signal" | "shutdown" | "manual";
  interrupted: boolean;
  activeSkill?: string;
  toolCalls: number;
  turnCounter: number;
  verification?: VerificationSessionState;
  parallel?: ParallelSessionSnapshot;
  contextBudget?: ContextBudgetSessionState;
  cost?: SessionCostSummary;
  task?: TaskSessionSnapshot;
  lastEvent?: Pick<RoasterEventRecord, "id" | "type" | "timestamp">;
}

export interface RuntimeSessionRestoreResult {
  restored: boolean;
  snapshot?: RuntimeSessionSnapshot;
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
