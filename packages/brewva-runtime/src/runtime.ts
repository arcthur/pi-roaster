import { resolve } from "node:path";
import { TurnWALRecovery } from "./channels/turn-wal-recovery.js";
import { TurnWALStore } from "./channels/turn-wal.js";
import type { TurnEnvelope } from "./channels/turn.js";
import { loadBrewvaConfig } from "./config/loader.js";
import { resolveWorkspaceRootDir } from "./config/paths.js";
import { ContextBudgetManager } from "./context/budget.js";
import { registerBuiltInContextSourceProviders } from "./context/builtins.js";
import { normalizeAgentId } from "./context/identity.js";
import { ContextInjectionCollector, type ContextInjectionEntry } from "./context/injection.js";
import {
  ContextSourceProviderRegistry,
  type ContextSourceProvider,
  type ContextSourceProviderDescriptor,
} from "./context/provider.js";
import type { ToolOutputDistillationEntry } from "./context/tool-output-distilled.js";
import { SessionCostTracker } from "./cost/tracker.js";
import {
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "./events/event-types.js";
import { BrewvaEventStore } from "./events/store.js";
import type { GovernancePort } from "./governance/port.js";
import { EvidenceLedger } from "./ledger/evidence-ledger.js";
import { ParallelBudgetManager } from "./parallel/budget.js";
import { ParallelResultStore } from "./parallel/results.js";
import { ProjectionEngine } from "./projection/engine.js";
import { inferEventCategory } from "./runtime-helpers.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";
import { SchedulerService } from "./schedule/service.js";
import {
  CONTEXT_CRITICAL_ALLOWED_TOOLS,
  CONTROL_PLANE_TOOLS,
} from "./security/control-plane-tools.js";
import { sanitizeContextText } from "./security/sanitize.js";
import { ContextService } from "./services/context.js";
import { CostService } from "./services/cost.js";
import { EffectCommitmentDeskService } from "./services/effect-commitment-desk.js";
import { EventPipelineService, type RuntimeRecordEventInput } from "./services/event-pipeline.js";
import { ExplorationSupervisorService } from "./services/exploration-supervisor.js";
import { FileChangeService } from "./services/file-change.js";
import { LedgerService } from "./services/ledger.js";
import { MutationRollbackService } from "./services/mutation-rollback.js";
import { ParallelService } from "./services/parallel.js";
import type { EffectCommitmentAuthorizationDecision } from "./services/proposal-admission-effect-commitment.js";
import { ProposalAdmissionService } from "./services/proposal-admission.js";
import { ResourceLeaseService } from "./services/resource-lease.js";
import { ReversibleMutationService } from "./services/reversible-mutation.js";
import { ScheduleIntentService } from "./services/schedule-intent.js";
import { SessionLifecycleService } from "./services/session-lifecycle.js";
import { RuntimeSessionStateStore } from "./services/session-state.js";
import { SkillCascadeService } from "./services/skill-cascade.js";
import { SkillLifecycleService } from "./services/skill-lifecycle.js";
import { TapeService } from "./services/tape.js";
import { TaskWatchdogService } from "./services/task-watchdog-service.js";
import { TaskService } from "./services/task.js";
import { ToolGateService } from "./services/tool-gate.js";
import { TrustMeterService } from "./services/trust-meter.js";
import { TruthProjectorService } from "./services/truth-projector.js";
import { TruthService } from "./services/truth.js";
import { VerificationProjectorService } from "./services/verification-projector.js";
import { VerificationService } from "./services/verification.js";
import { SkillRegistry, type SkillRegistryLoadReport } from "./skills/registry.js";
import { FileChangeTracker } from "./state/file-change-tracker.js";
import { TurnReplayEngine } from "./tape/replay-engine.js";
import type {
  ContextCompactionReason,
  ContextPressureLevel,
  ContextPressureStatus,
  ContextCompactionGateStatus,
  ContextBudgetUsage,
  ResourceLeaseCancelResult,
  ResourceLeaseQuery,
  ResourceLeaseRecord,
  ResourceLeaseRequest,
  ResourceLeaseResult,
  EvidenceLedgerRow,
  EvidenceQuery,
  ParallelAcquireResult,
  RollbackResult,
  ScheduleIntentCancelInput,
  ScheduleIntentCancelResult,
  ScheduleIntentCreateInput,
  ScheduleIntentCreateResult,
  ScheduleIntentListQuery,
  ScheduleIntentProjectionRecord,
  ScheduleIntentUpdateInput,
  ScheduleIntentUpdateResult,
  ScheduleProjectionSnapshot,
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaReplaySession,
  BrewvaConfig,
  BrewvaStructuredEvent,
  DecideEffectCommitmentInput,
  DecideEffectCommitmentResult,
  DecisionReceipt,
  PendingEffectCommitmentRequest,
  ToolInvocationPosture,
  ToolMutationReceipt,
  ToolMutationRollbackResult,
  ToolGovernanceDescriptor,
  SkillDocument,
  SkillDispatchDecision,
  SkillChainIntent,
  SkillCascadeChainSource,
  SkillCascadeControlResult,
  ProposalEnvelope,
  ProposalKind,
  ProposalListQuery,
  ProposalRecord,
  SessionHydrationState,
  SessionCostSummary,
  TapeSearchResult,
  TapeSearchScope,
  TapeStatusState,
  TaskSpec,
  TaskState,
  TurnWALRecord,
  TurnWALRecoveryResult,
  TurnWALSource,
  VerificationLevel,
  VerificationReport,
  WorkerMergeReport,
  WorkerResult,
} from "./types.js";
import type { TaskItemStatus } from "./types.js";
import type { TruthFact, TruthFactSeverity, TruthFactStatus, TruthState } from "./types.js";
import { normalizeToolResultVerdict } from "./utils/tool-result.js";
import { VerificationGate } from "./verification/gate.js";

export interface BrewvaRuntimeOptions {
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
  governancePort?: GovernancePort;
  agentId?: string;
  skillCascadeChainSources?: SkillCascadeChainSource[];
}

export interface VerifyCompletionOptions {
  executeCommands?: boolean;
  timeoutMs?: number;
}

type RuntimeConfigState = {
  config: BrewvaConfig;
};

type RuntimeCoreDependencies = {
  skillRegistry: SkillRegistry;
  evidenceLedger: EvidenceLedger;
  verificationGate: VerificationGate;
  parallel: ParallelBudgetManager;
  parallelResults: ParallelResultStore;
  eventStore: BrewvaEventStore;
  turnWalStore: TurnWALStore;
  contextBudget: ContextBudgetManager;
  contextInjection: ContextInjectionCollector;
  turnReplay: TurnReplayEngine;
  fileChanges: FileChangeTracker;
  costTracker: SessionCostTracker;
  projectionEngine: ProjectionEngine;
};

type RuntimeServiceDependencies = {
  proposalAdmissionService: ProposalAdmissionService;
  skillLifecycleService: SkillLifecycleService;
  skillCascadeService: SkillCascadeService;
  taskService: TaskService;
  truthService: TruthService;
  ledgerService: LedgerService;
  resourceLeaseService: ResourceLeaseService;
  parallelService: ParallelService;
  costService: CostService;
  verificationService: VerificationService;
  contextService: ContextService;
  explorationSupervisorService: ExplorationSupervisorService;
  taskWatchdogService: TaskWatchdogService;
  tapeService: TapeService;
  eventPipeline: EventPipelineService;
  truthProjectorService: TruthProjectorService;
  verificationProjectorService: VerificationProjectorService;
  scheduleIntentService: ScheduleIntentService;
  fileChangeService: FileChangeService;
  mutationRollbackService: MutationRollbackService;
  sessionLifecycleService: SessionLifecycleService;
  toolGateService: ToolGateService;
  effectCommitmentDeskService: EffectCommitmentDeskService;
};

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function normalizeReasonList(
  input: { reason?: string; reasons?: string[] } | undefined,
  fallback: string,
): string[] {
  const values = [
    ...(input?.reasons ?? []),
    ...(typeof input?.reason === "string" ? [input.reason] : []),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    return [fallback];
  }
  return [...new Set(values)];
}

function normalizePolicyBasis(values: readonly string[] | undefined, fallback: string): string[] {
  const normalized = (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (normalized.length === 0) {
    return [fallback];
  }
  return [...new Set(normalized)];
}

function buildKernelEffectCommitmentDecision(input: {
  descriptor: ToolGovernanceDescriptor;
  toolName: string;
}): EffectCommitmentAuthorizationDecision {
  const effectSet = new Set(input.descriptor.effects);
  const toolName = input.toolName;
  const policySuffix =
    effectSet.has("external_network") || effectSet.has("external_side_effect")
      ? "effect_commitment_external_requires_port"
      : effectSet.has("schedule_mutation")
        ? "effect_commitment_schedule_requires_port"
        : effectSet.has("local_exec")
          ? "effect_commitment_local_exec_requires_port"
          : "effect_commitment_unknown_requires_port";

  return {
    decision: "defer",
    policyBasis: ["effect_commitment_kernel_policy", policySuffix],
    reasons: [`effect_commitment_requires_governance_port:${toolName}`],
  };
}

export class BrewvaRuntime {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly agentId: string;
  readonly config: BrewvaConfig;
  readonly skills: {
    refresh(): void;
    getLoadReport(): SkillRegistryLoadReport;
    list(): SkillDocument[];
    get(name: string): SkillDocument | undefined;
    getPendingDispatch(sessionId: string): SkillDispatchDecision | undefined;
    clearPendingDispatch(sessionId: string): SkillDispatchDecision | undefined;
    reconcilePendingDispatch(sessionId: string, turn: number): void;
    activate(
      sessionId: string,
      name: string,
    ): { ok: boolean; reason?: string; skill?: SkillDocument };
    getActive(sessionId: string): SkillDocument | undefined;
    validateOutputs(
      sessionId: string,
      outputs: Record<string, unknown>,
    ): {
      ok: boolean;
      missing: string[];
      invalid: Array<{ name: string; reason: string }>;
    };
    complete(
      sessionId: string,
      output: Record<string, unknown>,
      options?: { proof?: string; summary?: string; notes?: string },
    ): {
      ok: boolean;
      missing: string[];
      invalid: Array<{ name: string; reason: string }>;
    };
    getOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined;
    getConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown>;
    getCascadeIntent(sessionId: string): SkillChainIntent | undefined;
    pauseCascade(sessionId: string, reason?: string): SkillCascadeControlResult;
    resumeCascade(sessionId: string, reason?: string): SkillCascadeControlResult;
    cancelCascade(sessionId: string, reason?: string): SkillCascadeControlResult;
    startCascade(
      sessionId: string,
      input: {
        steps: Array<{
          skill: string;
          consumes?: string[];
          produces?: string[];
          lane?: string;
        }>;
      },
    ): SkillCascadeControlResult;
  };
  readonly proposals: {
    submit<K extends ProposalKind>(
      sessionId: string,
      proposal: ProposalEnvelope<K>,
    ): DecisionReceipt;
    list(sessionId: string, query?: ProposalListQuery): ProposalRecord[];
    listPendingEffectCommitments(sessionId: string): PendingEffectCommitmentRequest[];
    decideEffectCommitment(
      sessionId: string,
      requestId: string,
      input: DecideEffectCommitmentInput,
    ): DecideEffectCommitmentResult;
  };
  readonly context: {
    onTurnStart(sessionId: string, turnIndex: number): void;
    onTurnEnd(sessionId: string): void;
    onUserInput(sessionId: string): void;
    sanitizeInput(text: string): string;
    observeUsage(sessionId: string, usage: ContextBudgetUsage | undefined): void;
    getUsage(sessionId: string): ContextBudgetUsage | undefined;
    getUsageRatio(usage: ContextBudgetUsage | undefined): number | null;
    getHardLimitRatio(): number;
    getCompactionThresholdRatio(): number;
    getPressureStatus(sessionId: string, usage?: ContextBudgetUsage): ContextPressureStatus;
    getPressureLevel(sessionId: string, usage?: ContextBudgetUsage): ContextPressureLevel;
    getCompactionGateStatus(
      sessionId: string,
      usage?: ContextBudgetUsage,
    ): ContextCompactionGateStatus;
    checkCompactionGate(
      sessionId: string,
      toolName: string,
      usage?: ContextBudgetUsage,
    ): { allowed: boolean; reason?: string };
    registerProvider(provider: ContextSourceProvider): void;
    unregisterProvider(source: string): boolean;
    listProviders(): readonly ContextSourceProviderDescriptor[];
    buildInjection(
      sessionId: string,
      prompt: string,
      usage?: ContextBudgetUsage,
      injectionScopeId?: string,
    ): Promise<{
      text: string;
      entries: ContextInjectionEntry[];
      accepted: boolean;
      originalTokens: number;
      finalTokens: number;
      truncated: boolean;
    }>;
    appendSupplementalInjection(
      sessionId: string,
      inputText: string,
      usage?: ContextBudgetUsage,
      injectionScopeId?: string,
    ): {
      accepted: boolean;
      text: string;
      originalTokens: number;
      finalTokens: number;
      truncated: boolean;
      droppedReason?: "hard_limit" | "budget_exhausted";
    };
    checkAndRequestCompaction(sessionId: string, usage: ContextBudgetUsage | undefined): boolean;
    requestCompaction(sessionId: string, reason: ContextCompactionReason): void;
    getPendingCompactionReason(sessionId: string): ContextCompactionReason | null;
    getCompactionInstructions(): string;
    getCompactionWindowTurns(): number;
    markCompacted(
      sessionId: string,
      input: {
        fromTokens?: number | null;
        toTokens?: number | null;
        summary?: string;
        entryId?: string;
      },
    ): void;
  };
  readonly tools: {
    checkAccess(sessionId: string, toolName: string): { allowed: boolean; reason?: string };
    explainAccess(input: { sessionId: string; toolName: string; usage?: ContextBudgetUsage }): {
      allowed: boolean;
      reason?: string;
      warning?: string;
    };
    start(input: {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
      usage?: ContextBudgetUsage;
      recordLifecycleEvent?: boolean;
      effectCommitmentRequestId?: string;
    }): {
      allowed: boolean;
      reason?: string;
      advisory?: string;
      posture?: ToolInvocationPosture;
      commitmentReceipt?: DecisionReceipt;
      effectCommitmentRequestId?: string;
      mutationReceipt?: ToolMutationReceipt;
    };
    finish(input: {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      outputText: string;
      channelSuccess: boolean;
      verdict?: "pass" | "fail" | "inconclusive";
      metadata?: Record<string, unknown>;
    }): void;
    acquireParallelSlot(sessionId: string, runId: string): ParallelAcquireResult;
    acquireParallelSlotAsync(
      sessionId: string,
      runId: string,
      options?: { timeoutMs?: number },
    ): Promise<ParallelAcquireResult>;
    releaseParallelSlot(sessionId: string, runId: string): void;
    requestResourceLease(sessionId: string, request: ResourceLeaseRequest): ResourceLeaseResult;
    listResourceLeases(sessionId: string, query?: ResourceLeaseQuery): ResourceLeaseRecord[];
    cancelResourceLease(
      sessionId: string,
      leaseId: string,
      reason?: string,
    ): ResourceLeaseCancelResult;
    markCall(sessionId: string, toolName: string): void;
    trackCallStart(input: {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
    }): void;
    trackCallEnd(input: {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      channelSuccess: boolean;
    }): void;
    rollbackLastPatchSet(sessionId: string): RollbackResult;
    rollbackLastMutation(sessionId: string): ToolMutationRollbackResult;
    resolveUndoSessionId(preferredSessionId?: string): string | undefined;
    recordResult(input: {
      sessionId: string;
      toolName: string;
      args: Record<string, unknown>;
      outputText: string;
      channelSuccess: boolean;
      verdict?: "pass" | "fail" | "inconclusive";
      metadata?: Record<string, unknown>;
    }): string;
  };
  readonly task: {
    setSpec(sessionId: string, spec: TaskSpec): void;
    addItem(
      sessionId: string,
      input: { text: string; status?: TaskItemStatus; id?: string },
    ): { ok: boolean; itemId?: string; error?: string };
    updateItem(
      sessionId: string,
      input: { id: string; text?: string; status?: TaskItemStatus },
    ): { ok: boolean; error?: string };
    recordBlocker(
      sessionId: string,
      input: { id?: string; message: string; source?: string; truthFactId?: string },
    ): { ok: boolean; blockerId?: string; error?: string };
    resolveBlocker(sessionId: string, blockerId: string): { ok: boolean; error?: string };
    getState(sessionId: string): TaskState;
  };
  readonly truth: {
    getState(sessionId: string): TruthState;
    upsertFact(
      sessionId: string,
      input: {
        id: string;
        kind: string;
        severity: TruthFactSeverity;
        summary: string;
        details?: Record<string, unknown>;
        evidenceIds?: string[];
        status?: TruthFactStatus;
      },
    ): { ok: boolean; fact?: TruthFact; error?: string };
    resolveFact(sessionId: string, truthFactId: string): { ok: boolean; error?: string };
  };
  readonly ledger: {
    getDigest(sessionId: string): string;
    query(sessionId: string, query: EvidenceQuery): string;
    listRows(sessionId?: string): EvidenceLedgerRow[];
    verifyChain(sessionId: string): { valid: boolean; reason?: string };
    getPath(): string;
  };
  readonly schedule: {
    createIntent(
      sessionId: string,
      input: ScheduleIntentCreateInput,
    ): Promise<ScheduleIntentCreateResult>;
    cancelIntent(
      sessionId: string,
      input: ScheduleIntentCancelInput,
    ): Promise<ScheduleIntentCancelResult>;
    updateIntent(
      sessionId: string,
      input: ScheduleIntentUpdateInput,
    ): Promise<ScheduleIntentUpdateResult>;
    listIntents(query?: ScheduleIntentListQuery): Promise<ScheduleIntentProjectionRecord[]>;
    getProjectionSnapshot(): Promise<ScheduleProjectionSnapshot>;
  };
  readonly turnWal: {
    appendPending(
      envelope: TurnEnvelope,
      source: TurnWALSource,
      options?: { ttlMs?: number; dedupeKey?: string },
    ): TurnWALRecord;
    markInflight(walId: string): TurnWALRecord | undefined;
    markDone(walId: string): TurnWALRecord | undefined;
    markFailed(walId: string, error?: string): TurnWALRecord | undefined;
    markExpired(walId: string): TurnWALRecord | undefined;
    listPending(): TurnWALRecord[];
    recover(): Promise<TurnWALRecoveryResult>;
    compact(): {
      scope: string;
      filePath: string;
      scanned: number;
      retained: number;
      dropped: number;
    };
  };
  readonly events: {
    record(input: RuntimeRecordEventInput): BrewvaEventRecord | undefined;
    query(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
    queryStructured(sessionId: string, query?: BrewvaEventQuery): BrewvaStructuredEvent[];
    getTapeStatus(sessionId: string): TapeStatusState;
    getTapePressureThresholds(): TapeStatusState["thresholds"];
    recordTapeHandoff(
      sessionId: string,
      input: { name: string; summary?: string; nextSteps?: string },
    ): {
      ok: boolean;
      eventId?: string;
      createdAt?: number;
      error?: string;
      tapeStatus?: TapeStatusState;
    };
    searchTape(
      sessionId: string,
      input: { query: string; scope?: TapeSearchScope; limit?: number },
    ): TapeSearchResult;
    listReplaySessions(limit?: number): BrewvaReplaySession[];
    subscribe(listener: (event: BrewvaStructuredEvent) => void): () => void;
    toStructured(event: BrewvaEventRecord): BrewvaStructuredEvent;
    list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
    listSessionIds(): string[];
  };
  readonly verification: {
    evaluate(sessionId: string, level?: VerificationLevel): VerificationReport;
    verify(
      sessionId: string,
      level?: VerificationLevel,
      options?: VerifyCompletionOptions,
    ): Promise<VerificationReport>;
  };
  readonly cost: {
    recordAssistantUsage(input: {
      sessionId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      costUsd: number;
      stopReason?: string;
    }): void;
    getSummary(sessionId: string): SessionCostSummary;
  };
  readonly session: {
    recordWorkerResult(sessionId: string, result: WorkerResult): void;
    listWorkerResults(sessionId: string): WorkerResult[];
    mergeWorkerResults(sessionId: string): WorkerMergeReport;
    clearWorkerResults(sessionId: string): void;
    pollStall(
      sessionId: string,
      input?: {
        now?: number;
        thresholdsMs?: Partial<Record<"investigate" | "execute" | "verify", number>>;
      },
    ): void;
    clearState(sessionId: string): void;
    onClearState(listener: (sessionId: string) => void): () => void;
    getHydration(sessionId: string): SessionHydrationState;
  };

  private readonly evidenceLedger: EvidenceLedger;
  private readonly parallel: ParallelBudgetManager;
  private readonly parallelResults: ParallelResultStore;
  private readonly contextBudget: ContextBudgetManager;
  private readonly contextInjection: ContextInjectionCollector;
  private readonly fileChanges: FileChangeTracker;
  private readonly costTracker: SessionCostTracker;

  private readonly skillRegistry: SkillRegistry;
  private readonly verificationGate: VerificationGate;
  private readonly eventStore: BrewvaEventStore;
  private readonly turnWalStore: TurnWALStore;
  private readonly projectionEngine: ProjectionEngine;

  private readonly sessionState = new RuntimeSessionStateStore();
  private readonly kernel: RuntimeKernelContext;
  private readonly contextService: ContextService;
  private readonly costService: CostService;
  private readonly eventPipeline: EventPipelineService;
  private readonly effectCommitmentDeskService: EffectCommitmentDeskService;
  private readonly fileChangeService: FileChangeService;
  private readonly resourceLeaseService: ResourceLeaseService;
  private readonly ledgerService: LedgerService;
  private readonly mutationRollbackService: MutationRollbackService;
  private readonly parallelService: ParallelService;
  private readonly proposalAdmissionService: ProposalAdmissionService;
  private readonly explorationSupervisorService: ExplorationSupervisorService;
  private readonly taskWatchdogService: TaskWatchdogService;
  private readonly scheduleIntentService: ScheduleIntentService;
  private readonly sessionLifecycleService: SessionLifecycleService;
  private readonly skillLifecycleService: SkillLifecycleService;
  private readonly skillCascadeService: SkillCascadeService;
  private readonly taskService: TaskService;
  private readonly tapeService: TapeService;
  private readonly truthService: TruthService;
  private readonly truthProjectorService: TruthProjectorService;
  private readonly toolGateService: ToolGateService;
  private readonly verificationProjectorService: VerificationProjectorService;
  private readonly verificationService: VerificationService;
  private turnReplay: TurnReplayEngine;

  constructor(options: BrewvaRuntimeOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.workspaceRoot = resolveWorkspaceRootDir(this.cwd);
    this.agentId = normalizeAgentId(options.agentId ?? process.env["BREWVA_AGENT_ID"]);
    const configState = this.resolveRuntimeConfig(options);
    this.config = configState.config;
    const coreDependencies = this.createCoreDependencies(options);
    this.skillRegistry = coreDependencies.skillRegistry;
    this.evidenceLedger = coreDependencies.evidenceLedger;
    this.verificationGate = coreDependencies.verificationGate;
    this.parallel = coreDependencies.parallel;
    this.parallelResults = coreDependencies.parallelResults;
    this.eventStore = coreDependencies.eventStore;
    this.turnWalStore = coreDependencies.turnWalStore;
    this.contextBudget = coreDependencies.contextBudget;
    this.contextInjection = coreDependencies.contextInjection;
    this.turnReplay = coreDependencies.turnReplay;
    this.fileChanges = coreDependencies.fileChanges;
    this.costTracker = coreDependencies.costTracker;
    this.projectionEngine = coreDependencies.projectionEngine;
    this.kernel = this.createKernelContext(options);

    const serviceDependencies = this.createServiceDependencies(options);
    this.proposalAdmissionService = serviceDependencies.proposalAdmissionService;
    this.skillLifecycleService = serviceDependencies.skillLifecycleService;
    this.skillCascadeService = serviceDependencies.skillCascadeService;
    this.taskService = serviceDependencies.taskService;
    this.truthService = serviceDependencies.truthService;
    this.ledgerService = serviceDependencies.ledgerService;
    this.resourceLeaseService = serviceDependencies.resourceLeaseService;
    this.parallelService = serviceDependencies.parallelService;
    this.costService = serviceDependencies.costService;
    this.verificationService = serviceDependencies.verificationService;
    this.contextService = serviceDependencies.contextService;
    this.explorationSupervisorService = serviceDependencies.explorationSupervisorService;
    this.taskWatchdogService = serviceDependencies.taskWatchdogService;
    this.tapeService = serviceDependencies.tapeService;
    this.eventPipeline = serviceDependencies.eventPipeline;
    this.effectCommitmentDeskService = serviceDependencies.effectCommitmentDeskService;
    this.truthProjectorService = serviceDependencies.truthProjectorService;
    this.verificationProjectorService = serviceDependencies.verificationProjectorService;
    this.scheduleIntentService = serviceDependencies.scheduleIntentService;
    this.fileChangeService = serviceDependencies.fileChangeService;
    this.mutationRollbackService = serviceDependencies.mutationRollbackService;
    this.sessionLifecycleService = serviceDependencies.sessionLifecycleService;
    this.toolGateService = serviceDependencies.toolGateService;
    this.eventPipeline.subscribeEvents((event) =>
      this.skillCascadeService.handleRuntimeEvent(event),
    );

    const domainApis = this.createDomainApis();
    this.skills = domainApis.skills;
    this.proposals = domainApis.proposals;
    this.context = domainApis.context;
    this.tools = domainApis.tools;
    this.task = domainApis.task;
    this.truth = domainApis.truth;
    this.ledger = domainApis.ledger;
    this.schedule = domainApis.schedule;
    this.turnWal = domainApis.turnWal;
    this.events = domainApis.events;
    this.verification = domainApis.verification;
    this.cost = domainApis.cost;
    this.session = domainApis.session;
  }

  private resolveRuntimeConfig(options: BrewvaRuntimeOptions): RuntimeConfigState {
    if (options.config) {
      return {
        config: options.config,
      };
    }
    return {
      config: loadBrewvaConfig({
        cwd: this.cwd,
        configPath: options.configPath,
      }),
    };
  }

  private createCoreDependencies(_options: BrewvaRuntimeOptions): RuntimeCoreDependencies {
    const skillRegistry = new SkillRegistry({
      rootDir: this.cwd,
      config: this.config,
    });
    skillRegistry.load();
    skillRegistry.writeIndex();

    const evidenceLedger = new EvidenceLedger(resolve(this.workspaceRoot, this.config.ledger.path));
    const verificationGate = new VerificationGate(this.config);
    const parallel = new ParallelBudgetManager(this.config.parallel);
    const parallelResults = new ParallelResultStore();
    const eventStore = new BrewvaEventStore(this.config.infrastructure.events, this.workspaceRoot);
    const turnWalStore = new TurnWALStore({
      workspaceRoot: this.workspaceRoot,
      config: this.config.infrastructure.turnWal,
      scope: "runtime",
      recordEvent: (input) => {
        this.recordEvent({
          sessionId: input.sessionId,
          type: input.type,
          payload: input.payload,
          skipTapeCheckpoint: true,
        });
      },
    });
    const contextBudget = new ContextBudgetManager(this.config.infrastructure.contextBudget);
    const contextInjection = new ContextInjectionCollector({
      sourceTokenLimits: {},
      maxEntriesPerSession: this.config.infrastructure.contextBudget.arena.maxEntriesPerSession,
    });
    const turnReplay = new TurnReplayEngine({
      listEvents: (sessionId) => eventStore.list(sessionId),
      getTurn: (sessionId) => this.getCurrentTurn(sessionId),
    });
    const fileChanges = new FileChangeTracker(this.cwd, {
      artifactsBaseDir: this.workspaceRoot,
    });
    const costTracker = new SessionCostTracker(this.config.infrastructure.costTracking);
    const projectionEngine = new ProjectionEngine({
      enabled: this.config.projection.enabled,
      rootDir: resolve(this.workspaceRoot, this.config.projection.dir),
      workingFile: this.config.projection.workingFile,
      maxWorkingChars: this.config.projection.maxWorkingChars,
      recordEvent: (eventInput) => this.recordEvent(eventInput),
    });

    return {
      skillRegistry,
      evidenceLedger,
      verificationGate,
      parallel,
      parallelResults,
      eventStore,
      turnWalStore,
      contextBudget,
      contextInjection,
      turnReplay,
      fileChanges,
      costTracker,
      projectionEngine,
    };
  }

  private createKernelContext(options: BrewvaRuntimeOptions): RuntimeKernelContext {
    return {
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      agentId: this.agentId,
      config: this.config,
      governancePort: options.governancePort,
      sessionState: this.sessionState,
      contextBudget: this.contextBudget,
      contextInjection: this.contextInjection,
      projectionEngine: this.projectionEngine,
      turnReplay: this.turnReplay,
      eventStore: this.eventStore,
      evidenceLedger: this.evidenceLedger,
      verificationGate: this.verificationGate,
      parallel: this.parallel,
      parallelResults: this.parallelResults,
      fileChanges: this.fileChanges,
      costTracker: this.costTracker,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      recordEvent: (input) => this.recordEvent(input),
      sanitizeInput: (text) => this.sanitizeInput(text),
      getRecentToolOutputDistillations: (sessionId, maxEntries) =>
        this.getRecentToolOutputDistillations(sessionId, maxEntries),
      getLatestVerificationOutcome: (sessionId) => this.getLatestVerificationOutcome(sessionId),
      isContextBudgetEnabled: () => this.isContextBudgetEnabled(),
    };
  }

  private createServiceDependencies(options: BrewvaRuntimeOptions): RuntimeServiceDependencies {
    const taskService = new TaskService({
      config: this.config,
      isContextBudgetEnabled: () => this.kernel.isContextBudgetEnabled(),
      getTaskState: (sessionId) => this.kernel.getTaskState(sessionId),
      getTruthState: (sessionId) => this.kernel.getTruthState(sessionId),
      evaluateCompletion: (sessionId, level) => this.evaluateCompletion(sessionId, level),
      recordEvent: (input) => this.kernel.recordEvent(input),
    });
    const skillLifecycleService = new SkillLifecycleService({
      skills: this.skillRegistry,
      sessionState: this.sessionState,
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      getTaskState: (sessionId) => this.kernel.getTaskState(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      setTaskSpec: (sessionId, spec) => taskService.setTaskSpec(sessionId, spec),
    });
    const skillCascadeService = new SkillCascadeService({
      config: this.config.skills.cascade,
      skills: this.skillRegistry,
      sessionState: this.sessionState,
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      getActiveSkill: (sessionId) => skillLifecycleService.getActiveSkill(sessionId),
      activateSkill: (sessionId, name) => skillLifecycleService.activateSkill(sessionId, name),
      getSkillOutputs: (sessionId, skillName) =>
        skillLifecycleService.getSkillOutputs(sessionId, skillName),
      listProducedOutputKeys: (sessionId) =>
        skillLifecycleService.listProducedOutputKeys(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      chainSources: options.skillCascadeChainSources,
    });
    const truthService = new TruthService({
      getTruthState: (sessionId) => this.kernel.getTruthState(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
    });
    const ledgerService = new LedgerService({
      config: this.config,
      evidenceLedger: this.evidenceLedger,
      sessionState: this.sessionState,
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      skillLifecycleService,
    });
    const resourceLeaseService = new ResourceLeaseService({
      sessionState: this.sessionState,
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      skillLifecycleService,
    });
    const parallelService = new ParallelService({
      securityConfig: this.config.security,
      parallel: this.parallel,
      parallelResults: this.parallelResults,
      sessionState: this.sessionState,
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      resourceLeaseService,
      skillLifecycleService,
    });
    const costService = new CostService({
      costTracker: this.costTracker,
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      ledgerService,
      skillLifecycleService,
      governancePort: options.governancePort,
    });
    const trustMeterService = new TrustMeterService();
    const verificationService = new VerificationService({
      cwd: this.cwd,
      config: this.config,
      verificationGate: this.verificationGate,
      getTaskState: (sessionId) => this.kernel.getTaskState(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      governancePort: options.governancePort,
      skillLifecycleService,
      ledgerService,
      trustMeterService,
    });
    const effectCommitmentDeskService = new EffectCommitmentDeskService({
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      listEvents: (sessionId) => this.eventStore.list(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
    });
    const proposalAdmissionService = new ProposalAdmissionService({
      listDecisionReceiptEvents: (sessionId) =>
        this.eventStore.list(sessionId, { type: DECISION_RECEIPT_RECORDED_EVENT_TYPE }),
      recordEvent: (input) => this.kernel.recordEvent(input),
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      skillRegistry: this.skillRegistry,
      skillLifecycleService,
      effectCommitmentAuthorizer: ({ sessionId, proposal, descriptor, turn }) => {
        const toolName = proposal.payload.toolName.trim() || proposal.subject.trim();
        const governanceDecision = options.governancePort?.authorizeEffectCommitment?.({
          sessionId,
          proposal,
          turn,
        });
        if (governanceDecision !== undefined) {
          if (isPromiseLike(governanceDecision)) {
            return {
              decision: "defer",
              policyBasis: [
                "effect_commitment_governance_port",
                "effect_commitment_async_unsupported",
              ],
              reasons: [`effect_commitment_async_authorization_not_supported:${toolName}`],
            };
          }
          const decision =
            governanceDecision.decision === "accept" ||
            governanceDecision.decision === "reject" ||
            governanceDecision.decision === "defer"
              ? governanceDecision.decision
              : "reject";
          return {
            decision,
            policyBasis: normalizePolicyBasis(
              governanceDecision.policyBasis,
              "effect_commitment_governance_port",
            ),
            reasons: normalizeReasonList(
              governanceDecision,
              `effect_commitment_${decision}:${toolName}`,
            ),
          };
        }
        if (options.governancePort) {
          return buildKernelEffectCommitmentDecision({
            descriptor,
            toolName,
          });
        }
        return effectCommitmentDeskService.authorize({
          sessionId,
          proposal,
          descriptor,
          turn,
        });
      },
    });
    const contextSourceProviders = new ContextSourceProviderRegistry();
    registerBuiltInContextSourceProviders(contextSourceProviders, {
      workspaceRoot: this.workspaceRoot,
      agentId: this.agentId,
      kernel: this.kernel,
      proposalAdmissionService,
      skillLifecycleService,
      skillCascadeService,
    });
    const contextService = new ContextService({
      config: this.config,
      contextBudget: this.contextBudget,
      contextInjection: this.contextInjection,
      sessionState: this.sessionState,
      getTruthState: (sessionId) => this.kernel.getTruthState(sessionId),
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      sanitizeInput: (text) => this.kernel.sanitizeInput(text),
      recordEvent: (input) => this.kernel.recordEvent(input),
      alwaysAllowedTools: CONTEXT_CRITICAL_ALLOWED_TOOLS,
      contextSourceProviders,
      ledgerService,
      skillLifecycleService,
      taskService,
      governancePort: options.governancePort,
    });
    const explorationSupervisorService = new ExplorationSupervisorService({
      sessionState: this.sessionState,
      listEvents: (sessionId, query) => this.eventStore.list(sessionId, query),
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      skillLifecycleService,
      trustMeterService,
    });
    const taskWatchdogService = new TaskWatchdogService({
      listEvents: (sessionId, query) => this.eventStore.list(sessionId, query),
      getTaskState: (sessionId) => this.kernel.getTaskState(sessionId),
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      taskService,
    });
    const reversibleMutationService = new ReversibleMutationService({
      getTaskState: (sessionId) => this.kernel.getTaskState(sessionId),
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
    });
    const tapeService = new TapeService({
      tapeConfig: this.config.tape,
      sessionState: this.sessionState,
      queryEvents: (sessionId, query) => this.eventStore.list(sessionId, query),
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      getTaskState: (sessionId) => this.kernel.getTaskState(sessionId),
      getTruthState: (sessionId) => this.kernel.getTruthState(sessionId),
      getCostSummary: (sessionId) => this.resolveCheckpointCostSummary(sessionId),
      getCostSkillLastTurnByName: (sessionId) =>
        this.resolveCheckpointCostSkillLastTurnByName(sessionId),
      getCheckpointEvidenceState: (sessionId) =>
        this.turnReplay.getCheckpointEvidenceState(sessionId),
      getCheckpointProjectionState: (sessionId) =>
        this.turnReplay.getCheckpointProjectionState(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
    });
    const eventPipeline = new EventPipelineService({
      events: this.eventStore,
      level: this.config.infrastructure.events.level,
      inferEventCategory,
      observeReplayEvent: (event) => this.turnReplay.observeEvent(event),
      ingestProjectionEvent: (event) => this.projectionEngine.ingestEvent(event),
      maybeRecordTapeCheckpoint: (event) => tapeService.maybeRecordTapeCheckpoint(event),
    });
    const truthProjectorService = new TruthProjectorService({
      cwd: this.cwd,
      getTaskState: (sessionId) => this.kernel.getTaskState(sessionId),
      getTruthState: (sessionId) => this.kernel.getTruthState(sessionId),
      eventPipeline,
      taskService,
      truthService,
    });
    const verificationProjectorService = new VerificationProjectorService({
      getTaskState: (sessionId) => this.kernel.getTaskState(sessionId),
      getTruthState: (sessionId) => this.kernel.getTruthState(sessionId),
      verificationStateStore: this.verificationGate.stateStore,
      eventPipeline,
      taskService,
      truthService,
    });
    const scheduleIntentService = new ScheduleIntentService({
      createManager: () =>
        new SchedulerService({
          runtime: {
            workspaceRoot: this.workspaceRoot,
            scheduleConfig: this.config.schedule,
            listSessionIds: () => this.eventStore.listSessionIds(),
            listEvents: (sessionId, query) => this.eventStore.list(sessionId, query),
            recordEvent: (input) => eventPipeline.recordEvent(input),
            subscribeEvents: (listener) => eventPipeline.subscribeEvents(listener),
            getTruthState: (sessionId) => this.kernel.getTruthState(sessionId),
            getTaskState: (sessionId) => this.kernel.getTaskState(sessionId),
            turnWal: {
              appendPending: (envelope, source, walOptions) =>
                this.turnWalStore.appendPending(envelope, source, walOptions),
              markInflight: (walId) => this.turnWalStore.markInflight(walId),
              markDone: (walId) => this.turnWalStore.markDone(walId),
              markFailed: (walId, error) => this.turnWalStore.markFailed(walId, error),
              markExpired: (walId) => this.turnWalStore.markExpired(walId),
              listPending: () => this.turnWalStore.listPending(),
            },
          },
          enableExecution: false,
        }),
    });
    const fileChangeService = new FileChangeService({
      sessionState: this.sessionState,
      fileChanges: this.fileChanges,
      costTracker: this.costTracker,
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      ledgerService,
      skillLifecycleService,
      trustMeterService,
      reversibleMutationService,
    });
    const mutationRollbackService = new MutationRollbackService({
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      reversibleMutationService,
      fileChangeService,
      trustMeterService,
    });
    const sessionLifecycleService = new SessionLifecycleService({
      sessionState: this.sessionState,
      contextBudget: this.contextBudget,
      contextInjection: this.contextInjection,
      fileChanges: this.fileChanges,
      verificationGate: this.verificationGate,
      parallel: this.parallel,
      parallelResults: this.parallelResults,
      costTracker: this.costTracker,
      projectionEngine: this.projectionEngine,
      turnReplay: this.turnReplay,
      eventStore: this.eventStore,
      evidenceLedger: this.evidenceLedger,
      recordEvent: (input) => this.kernel.recordEvent(input),
      contextService,
    });
    const toolGateService = new ToolGateService({
      securityConfig: this.config.security,
      costTracker: this.costTracker,
      sessionState: this.sessionState,
      getCurrentTurn: (sessionId) => this.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => this.kernel.recordEvent(input),
      alwaysAllowedTools: CONTROL_PLANE_TOOLS,
      resourceLeaseService,
      skillLifecycleService,
      contextService,
      fileChangeService,
      ledgerService,
      proposalAdmissionService,
      effectCommitmentDeskService,
      reversibleMutationService,
      explorationSupervisorService,
    });
    sessionLifecycleService.onClearState((sessionId) => {
      trustMeterService.clear(sessionId);
      taskWatchdogService.clear(sessionId);
      reversibleMutationService.clear(sessionId);
      effectCommitmentDeskService.clear(sessionId);
    });

    return {
      proposalAdmissionService,
      skillLifecycleService,
      skillCascadeService,
      taskService,
      truthService,
      ledgerService,
      resourceLeaseService,
      parallelService,
      costService,
      verificationService,
      contextService,
      explorationSupervisorService,
      taskWatchdogService,
      tapeService,
      eventPipeline,
      effectCommitmentDeskService,
      truthProjectorService,
      verificationProjectorService,
      scheduleIntentService,
      fileChangeService,
      mutationRollbackService,
      sessionLifecycleService,
      toolGateService,
    };
  }

  private createDomainApis(): {
    skills: BrewvaRuntime["skills"];
    proposals: BrewvaRuntime["proposals"];
    context: BrewvaRuntime["context"];
    tools: BrewvaRuntime["tools"];
    task: BrewvaRuntime["task"];
    truth: BrewvaRuntime["truth"];
    ledger: BrewvaRuntime["ledger"];
    schedule: BrewvaRuntime["schedule"];
    turnWal: BrewvaRuntime["turnWal"];
    events: BrewvaRuntime["events"];
    verification: BrewvaRuntime["verification"];
    cost: BrewvaRuntime["cost"];
    session: BrewvaRuntime["session"];
  } {
    return {
      skills: {
        refresh: () => {
          this.skillRegistry.load();
          this.skillRegistry.writeIndex();
        },
        getLoadReport: () => this.skillRegistry.getLoadReport(),
        list: () => this.skillRegistry.list(),
        get: (name) => this.skillRegistry.get(name),
        getPendingDispatch: (sessionId) => this.skillLifecycleService.getPendingDispatch(sessionId),
        clearPendingDispatch: (sessionId) =>
          this.skillLifecycleService.clearPendingDispatch(sessionId),
        reconcilePendingDispatch: (sessionId, turn) =>
          this.skillLifecycleService.reconcilePendingDispatchOnTurnEnd(sessionId, turn),
        activate: (sessionId, name) => this.skillLifecycleService.activateSkill(sessionId, name),
        getActive: (sessionId) => this.skillLifecycleService.getActiveSkill(sessionId),
        validateOutputs: (sessionId, outputs) =>
          this.skillLifecycleService.validateSkillOutputs(sessionId, outputs),
        complete: (sessionId, output) =>
          this.skillLifecycleService.completeSkill(sessionId, output),
        getOutputs: (sessionId, skillName) =>
          this.skillLifecycleService.getSkillOutputs(sessionId, skillName),
        getConsumedOutputs: (sessionId, targetSkillName) =>
          this.skillLifecycleService.getAvailableConsumedOutputs(sessionId, targetSkillName),
        getCascadeIntent: (sessionId) => this.skillCascadeService.getIntent(sessionId),
        pauseCascade: (sessionId, reason) =>
          this.skillCascadeService.pauseIntent(sessionId, reason),
        resumeCascade: (sessionId, reason) =>
          this.skillCascadeService.resumeIntent(sessionId, reason),
        cancelCascade: (sessionId, reason) =>
          this.skillCascadeService.cancelIntent(sessionId, reason),
        startCascade: (sessionId, input) =>
          this.skillCascadeService.createExplicitIntent(sessionId, input),
      },
      proposals: {
        submit: (sessionId, proposal) =>
          this.proposalAdmissionService.submitProposal(sessionId, proposal),
        list: (sessionId, query) =>
          this.proposalAdmissionService.listProposalRecords(sessionId, query),
        listPendingEffectCommitments: (sessionId) =>
          this.effectCommitmentDeskService.listPending(sessionId),
        decideEffectCommitment: (sessionId, requestId, input) =>
          this.effectCommitmentDeskService.decide(sessionId, requestId, input),
      },
      context: {
        onTurnStart: (sessionId, turnIndex) => {
          this.sessionLifecycleService.onTurnStart(sessionId, turnIndex);
          this.taskWatchdogService.onTurnStart(sessionId);
        },
        onTurnEnd: (sessionId) => this.explorationSupervisorService.onTurnEnd(sessionId),
        onUserInput: (sessionId) => this.explorationSupervisorService.onUserInput(sessionId),
        sanitizeInput: (text) => this.sanitizeInput(text),
        observeUsage: (sessionId, usage) =>
          this.contextService.observeContextUsage(sessionId, usage),
        getUsage: (sessionId) => this.contextService.getContextUsage(sessionId),
        getUsageRatio: (usage) => this.contextService.getContextUsageRatio(usage),
        getHardLimitRatio: () => this.contextService.getContextHardLimitRatio(),
        getCompactionThresholdRatio: () => this.contextService.getContextCompactionThresholdRatio(),
        getPressureStatus: (sessionId, usage) =>
          this.contextService.getContextPressureStatus(sessionId, usage),
        getPressureLevel: (sessionId, usage) =>
          this.contextService.getContextPressureLevel(sessionId, usage),
        getCompactionGateStatus: (sessionId, usage) =>
          this.contextService.getContextCompactionGateStatus(sessionId, usage),
        checkCompactionGate: (sessionId, toolName, usage) =>
          this.contextService.checkContextCompactionGate(sessionId, toolName, usage),
        registerProvider: (provider) => this.contextService.registerContextSourceProvider(provider),
        unregisterProvider: (source) => this.contextService.unregisterContextSourceProvider(source),
        listProviders: () => this.contextService.listContextSourceProviders(),
        buildInjection: (sessionId, prompt, usage, injectionScopeId) =>
          this.contextService.buildContextInjection(sessionId, prompt, usage, injectionScopeId),
        appendSupplementalInjection: (sessionId, inputText, usage, injectionScopeId) =>
          this.contextService.appendSupplementalContextInjection(
            sessionId,
            inputText,
            usage,
            injectionScopeId,
          ),
        checkAndRequestCompaction: (sessionId, usage) =>
          this.contextService.checkAndRequestCompaction(sessionId, usage),
        requestCompaction: (sessionId, reason) =>
          this.contextService.requestCompaction(sessionId, reason),
        getPendingCompactionReason: (sessionId) =>
          this.contextService.getPendingCompactionReason(sessionId),
        getCompactionInstructions: () => this.contextService.getCompactionInstructions(),
        getCompactionWindowTurns: () => this.contextService.getRecentCompactionWindowTurns(),
        markCompacted: (sessionId, input) =>
          this.contextService.markContextCompacted(sessionId, input),
      },
      tools: {
        checkAccess: (sessionId, toolName) =>
          this.toolGateService.checkToolAccess(sessionId, toolName),
        explainAccess: (input) => {
          const access = this.toolGateService.explainToolAccess(input.sessionId, input.toolName);
          if (!access.allowed) {
            return {
              allowed: false,
              reason: access.reason,
              warning: access.warning,
            };
          }
          const compaction = this.contextService.explainContextCompactionGate(
            input.sessionId,
            input.toolName,
            input.usage,
          );
          if (!compaction.allowed) {
            return {
              allowed: false,
              reason: compaction.reason,
            };
          }
          const warnings = [access.warning].filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          );
          return warnings.length > 0
            ? { allowed: true, warning: warnings.join("; ") }
            : { allowed: true };
        },
        start: (input) => this.toolGateService.startToolCall(input),
        finish: (input) => {
          this.toolGateService.finishToolCall(input);
        },
        acquireParallelSlot: (sessionId, runId) =>
          this.parallelService.acquireParallelSlot(sessionId, runId),
        acquireParallelSlotAsync: (sessionId, runId, options) =>
          this.parallelService.acquireParallelSlotAsync(sessionId, runId, options),
        releaseParallelSlot: (sessionId, runId) =>
          this.parallelService.releaseParallelSlot(sessionId, runId),
        requestResourceLease: (sessionId, request) =>
          this.resourceLeaseService.requestLease(sessionId, request),
        listResourceLeases: (sessionId, query) =>
          this.resourceLeaseService.listLeases(sessionId, query),
        cancelResourceLease: (sessionId, leaseId, reason) =>
          this.resourceLeaseService.cancelLease(sessionId, leaseId, reason),
        markCall: (sessionId, toolName) => this.fileChangeService.markToolCall(sessionId, toolName),
        trackCallStart: (input) => this.fileChangeService.trackToolCallStart(input),
        trackCallEnd: (input) => this.fileChangeService.trackToolCallEnd(input),
        rollbackLastPatchSet: (sessionId) => this.fileChangeService.rollbackLastPatchSet(sessionId),
        rollbackLastMutation: (sessionId) => this.mutationRollbackService.rollbackLast(sessionId),
        resolveUndoSessionId: (preferredSessionId) =>
          this.fileChangeService.resolveUndoSessionId(preferredSessionId),
        recordResult: (input) => this.ledgerService.recordToolResult(input),
      },
      task: {
        setSpec: (sessionId, spec) => this.taskService.setTaskSpec(sessionId, spec),
        addItem: (sessionId, input) => this.taskService.addTaskItem(sessionId, input),
        updateItem: (sessionId, input) => this.taskService.updateTaskItem(sessionId, input),
        recordBlocker: (sessionId, input) => this.taskService.recordTaskBlocker(sessionId, input),
        resolveBlocker: (sessionId, blockerId) =>
          this.taskService.resolveTaskBlocker(sessionId, blockerId),
        getState: (sessionId) => this.getTaskState(sessionId),
      },
      truth: {
        getState: (sessionId) => this.getTruthState(sessionId),
        upsertFact: (sessionId, input) => this.truthService.upsertTruthFact(sessionId, input),
        resolveFact: (sessionId, truthFactId) =>
          this.truthService.resolveTruthFact(sessionId, truthFactId),
      },
      ledger: {
        getDigest: (sessionId) => this.ledgerService.getLedgerDigest(sessionId),
        query: (sessionId, query) => this.ledgerService.queryLedger(sessionId, query),
        listRows: (sessionId) => this.ledgerService.listLedgerRows(sessionId),
        verifyChain: (sessionId) => this.ledgerService.verifyLedgerChain(sessionId),
        getPath: () => this.ledgerService.getLedgerPath(),
      },
      schedule: {
        createIntent: (sessionId, input) =>
          this.scheduleIntentService.createScheduleIntent(sessionId, input),
        cancelIntent: (sessionId, input) =>
          this.scheduleIntentService.cancelScheduleIntent(sessionId, input),
        updateIntent: (sessionId, input) =>
          this.scheduleIntentService.updateScheduleIntent(sessionId, input),
        listIntents: (query) => this.scheduleIntentService.listScheduleIntents(query),
        getProjectionSnapshot: () => this.scheduleIntentService.getScheduleProjectionSnapshot(),
      },
      turnWal: {
        appendPending: (envelope, source, options) =>
          this.turnWalStore.appendPending(envelope, source, options),
        markInflight: (walId) => this.turnWalStore.markInflight(walId),
        markDone: (walId) => this.turnWalStore.markDone(walId),
        markFailed: (walId, error) => this.turnWalStore.markFailed(walId, error),
        markExpired: (walId) => this.turnWalStore.markExpired(walId),
        listPending: () => this.turnWalStore.listPending(),
        recover: async () => {
          const recovery = new TurnWALRecovery({
            workspaceRoot: this.workspaceRoot,
            config: this.config.infrastructure.turnWal,
            recordEvent: (input: {
              sessionId: string;
              type: string;
              payload?: Record<string, unknown>;
            }) => {
              this.eventPipeline.recordEvent({
                sessionId: input.sessionId,
                type: input.type,
                payload: input.payload,
                skipTapeCheckpoint: true,
              });
            },
          });
          return await recovery.recover();
        },
        compact: () => this.turnWalStore.compact(),
      },
      events: {
        record: (input) => this.eventPipeline.recordEvent(input),
        query: (sessionId, query) => this.eventPipeline.queryEvents(sessionId, query),
        queryStructured: (sessionId, query) =>
          this.eventPipeline.queryStructuredEvents(sessionId, query),
        getTapeStatus: (sessionId) => this.tapeService.getTapeStatus(sessionId),
        getTapePressureThresholds: () => this.tapeService.getPressureThresholds(),
        recordTapeHandoff: (sessionId, input) =>
          this.tapeService.recordTapeHandoff(sessionId, input),
        searchTape: (sessionId, input) => this.tapeService.searchTape(sessionId, input),
        listReplaySessions: (limit) => this.eventPipeline.listReplaySessions(limit),
        subscribe: (listener) => this.eventPipeline.subscribeEvents(listener),
        toStructured: (event) => this.eventPipeline.toStructuredEvent(event),
        list: (sessionId, query) => this.eventStore.list(sessionId, query),
        listSessionIds: () => this.eventStore.listSessionIds(),
      },
      verification: {
        evaluate: (sessionId, level) => this.evaluateCompletion(sessionId, level),
        verify: (sessionId, level, options) => {
          this.sessionLifecycleService.ensureHydrated(sessionId);
          return this.verificationService.verifyCompletion(sessionId, level, options);
        },
      },
      cost: {
        recordAssistantUsage: (input) => this.costService.recordAssistantUsage(input),
        getSummary: (sessionId) => this.costService.getCostSummary(sessionId),
      },
      session: {
        recordWorkerResult: (sessionId, result) =>
          this.parallelService.recordWorkerResult(sessionId, result),
        listWorkerResults: (sessionId) => this.parallelService.listWorkerResults(sessionId),
        mergeWorkerResults: (sessionId) => this.parallelService.mergeWorkerResults(sessionId),
        clearWorkerResults: (sessionId) => this.parallelService.clearWorkerResults(sessionId),
        pollStall: (sessionId, input) =>
          this.taskWatchdogService.pollTaskProgress({
            sessionId,
            now: input?.now,
            thresholdsMs: input?.thresholdsMs,
          }),
        clearState: (sessionId) => this.sessionLifecycleService.clearSessionState(sessionId),
        onClearState: (listener) => this.sessionLifecycleService.onClearState(listener),
        getHydration: (sessionId) => {
          this.sessionLifecycleService.ensureHydrated(sessionId);
          return this.sessionLifecycleService.getHydrationState(sessionId);
        },
      },
    };
  }

  private getTaskState(sessionId: string): TaskState {
    return this.turnReplay.getTaskState(sessionId);
  }

  private getTruthState(sessionId: string): TruthState {
    return this.turnReplay.getTruthState(sessionId);
  }

  private recordEvent(input: RuntimeRecordEventInput): BrewvaEventRecord | undefined {
    return this.eventPipeline.recordEvent(input);
  }

  private evaluateCompletion(sessionId: string, level?: VerificationLevel): VerificationReport {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    return this.verificationGate.evaluate(sessionId, level);
  }

  private sanitizeInput(text: string): string {
    if (!this.config.security.sanitizeContext) {
      return text;
    }
    return sanitizeContextText(text);
  }

  private resolveCheckpointCostSummary(sessionId: string): SessionCostSummary {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    return this.costService.getCostSummary(sessionId);
  }

  private resolveCheckpointCostSkillLastTurnByName(sessionId: string): Record<string, number> {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    return this.costTracker.getSkillLastTurnByName(sessionId);
  }

  private getCurrentTurn(sessionId: string): number {
    return this.sessionState.getCurrentTurn(sessionId);
  }

  private getRecentToolOutputDistillations(
    sessionId: string,
    maxEntries = 12,
  ): ToolOutputDistillationEntry[] {
    const limit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 12;
    const candidateEvents = this.eventStore.list(sessionId, {
      type: TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
      last: Math.max(limit * 4, limit),
    });

    const entries: ToolOutputDistillationEntry[] = [];
    for (const event of candidateEvents) {
      const payload = event.payload;
      if (!payload) continue;

      const toolNameRaw = payload.toolName;
      const toolName =
        typeof toolNameRaw === "string" && toolNameRaw.trim().length > 0
          ? toolNameRaw.trim()
          : "(unknown)";

      const strategyRaw = payload.strategy;
      const strategy =
        typeof strategyRaw === "string" && strategyRaw.trim().length > 0
          ? strategyRaw.trim()
          : "unknown";

      const summaryTextRaw = payload.summaryText;
      const summaryText = typeof summaryTextRaw === "string" ? summaryTextRaw : "";
      const artifactRefRaw = payload.artifactRef;
      const artifactRef =
        typeof artifactRefRaw === "string" && artifactRefRaw.trim().length > 0
          ? artifactRefRaw.trim()
          : null;

      const rawTokens =
        typeof payload.rawTokens === "number" && Number.isFinite(payload.rawTokens)
          ? Math.max(0, Math.floor(payload.rawTokens))
          : null;
      const summaryTokens =
        typeof payload.summaryTokens === "number" && Number.isFinite(payload.summaryTokens)
          ? Math.max(0, Math.floor(payload.summaryTokens))
          : null;
      const compressionRatio =
        typeof payload.compressionRatio === "number" && Number.isFinite(payload.compressionRatio)
          ? Math.max(0, Math.min(1, payload.compressionRatio))
          : null;
      const isError = payload.isError === true;
      const verdict = normalizeToolResultVerdict(payload.verdict);
      const turn =
        typeof event.turn === "number" && Number.isFinite(event.turn)
          ? Math.max(0, Math.floor(event.turn))
          : 0;
      const timestamp = Number.isFinite(event.timestamp) ? event.timestamp : Date.now();

      entries.push({
        toolName,
        strategy,
        summaryText,
        rawTokens,
        summaryTokens,
        compressionRatio,
        artifactRef,
        isError,
        verdict,
        turn,
        timestamp,
      });
    }

    return entries.slice(-limit);
  }

  private getLatestVerificationOutcome(sessionId: string):
    | {
        timestamp: number;
        level?: string;
        outcome?: string;
        failedChecks?: string[];
        missingEvidence?: string[];
        reason?: string | null;
        commandsFresh?: string[];
        commandsStale?: string[];
      }
    | undefined {
    const event = this.eventStore.list(sessionId, {
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      last: 1,
    })[0];
    if (!event?.payload) return undefined;

    const payload = event.payload;
    const failedChecks = Array.isArray(payload.failedChecks)
      ? payload.failedChecks.filter((value): value is string => typeof value === "string")
      : [];
    const missingEvidence = Array.isArray(payload.missingEvidence)
      ? payload.missingEvidence.filter((value): value is string => typeof value === "string")
      : [];
    const commandsFresh = Array.isArray(payload.commandsFresh)
      ? payload.commandsFresh.filter((value): value is string => typeof value === "string")
      : [];
    const commandsStale = Array.isArray(payload.commandsStale)
      ? payload.commandsStale.filter((value): value is string => typeof value === "string")
      : [];

    return {
      timestamp: event.timestamp,
      level: typeof payload.level === "string" ? payload.level : undefined,
      outcome: typeof payload.outcome === "string" ? payload.outcome : undefined,
      failedChecks,
      missingEvidence,
      reason:
        typeof payload.reason === "string" && payload.reason.trim().length > 0
          ? payload.reason
          : null,
      commandsFresh,
      commandsStale,
    };
  }

  private isContextBudgetEnabled(): boolean {
    return this.config.infrastructure.contextBudget.enabled;
  }
}
