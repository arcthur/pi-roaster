import { resolve } from "node:path";
import { TurnWALStore } from "./channels/turn-wal.js";
import type { TurnEnvelope } from "./channels/turn.js";
import { loadBrewvaConfig } from "./config/loader.js";
import { resolveWorkspaceRootDir } from "./config/paths.js";
import { ContextBudgetManager } from "./context/budget.js";
import { normalizeAgentId } from "./context/identity.js";
import { ContextInjectionCollector, type ContextInjectionEntry } from "./context/injection.js";
import type { ToolOutputDistillationEntry } from "./context/tool-output-distilled.js";
import { SessionCostTracker } from "./cost/tracker.js";
import {
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
} from "./events/event-types.js";
import { BrewvaEventStore } from "./events/store.js";
import type { GovernancePort } from "./governance/port.js";
import { EvidenceLedger } from "./ledger/evidence-ledger.js";
import { ParallelBudgetManager } from "./parallel/budget.js";
import { ParallelResultStore } from "./parallel/results.js";
import { ProjectionEngine } from "./projection/engine.js";
import { createRuntimeDomainApis, type RuntimeDomainApis } from "./runtime-domains.js";
import {
  buildSkillCandidateBlock,
  buildSkillCascadeGateBlock,
  buildSkillDispatchGateBlock,
  buildTaskStateBlock,
  inferEventCategory,
} from "./runtime-helpers.js";
import { SchedulerService } from "./schedule/service.js";
import {
  CONTEXT_CRITICAL_ALLOWED_TOOLS,
  CONTROL_PLANE_TOOLS,
} from "./security/control-plane-tools.js";
import { sanitizeContextText } from "./security/sanitize.js";
import { ContextService } from "./services/context.js";
import { CostService } from "./services/cost.js";
import { EventPipelineService, type RuntimeRecordEventInput } from "./services/event-pipeline.js";
import { FileChangeService } from "./services/file-change.js";
import { LedgerService } from "./services/ledger.js";
import { ParallelService } from "./services/parallel.js";
import { ProposalAdmissionService } from "./services/proposal-admission.js";
import { ScanConvergenceService } from "./services/scan-convergence.js";
import { ScheduleIntentService } from "./services/schedule-intent.js";
import { SessionLifecycleService } from "./services/session-lifecycle.js";
import { RuntimeSessionStateStore } from "./services/session-state.js";
import { SkillCascadeService } from "./services/skill-cascade.js";
import { SkillLifecycleService } from "./services/skill-lifecycle.js";
import { TapeService } from "./services/tape.js";
import { TaskService } from "./services/task.js";
import { ToolGateService } from "./services/tool-gate.js";
import { TruthService } from "./services/truth.js";
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
  DecisionReceipt,
  SkillDocument,
  SkillDispatchDecision,
  SkillChainIntent,
  SkillCascadeChainSource,
  SkillCascadeControlResult,
  ProposalEnvelope,
  ProposalKind,
  ProposalListQuery,
  ProposalRecord,
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
  parallelService: ParallelService;
  costService: CostService;
  verificationService: VerificationService;
  contextService: ContextService;
  scanConvergenceService: ScanConvergenceService;
  tapeService: TapeService;
  eventPipeline: EventPipelineService;
  scheduleIntentService: ScheduleIntentService;
  fileChangeService: FileChangeService;
  sessionLifecycleService: SessionLifecycleService;
  toolGateService: ToolGateService;
};

type BaseServiceContext = {
  getCurrentTurn(this: void, sessionId: string): number;
  getTaskState(this: void, sessionId: string): TaskState;
  getTruthState(this: void, sessionId: string): TruthState;
  recordEvent(this: void, input: RuntimeRecordEventInput): BrewvaEventRecord | undefined;
};

type SkillAwareServiceContext = BaseServiceContext & {
  getActiveSkill(this: void, sessionId: string): SkillDocument | undefined;
};

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
    overridePendingDispatch(
      sessionId: string,
      input?: { reason?: string; targetSkillName?: string },
    ): { ok: boolean; reason?: string; decision?: SkillDispatchDecision };
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
    }): { allowed: boolean; reason?: string };
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
    releaseParallelSlot(sessionId: string, runId: string): void;
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
    clearState(sessionId: string): void;
    onClearState(listener: (sessionId: string) => void): () => void;
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
  private readonly contextService: ContextService;
  private readonly costService: CostService;
  private readonly eventPipeline: EventPipelineService;
  private readonly fileChangeService: FileChangeService;
  private readonly ledgerService: LedgerService;
  private readonly parallelService: ParallelService;
  private readonly proposalAdmissionService: ProposalAdmissionService;
  private readonly scanConvergenceService: ScanConvergenceService;
  private readonly scheduleIntentService: ScheduleIntentService;
  private readonly sessionLifecycleService: SessionLifecycleService;
  private readonly skillLifecycleService: SkillLifecycleService;
  private readonly skillCascadeService: SkillCascadeService;
  private readonly taskService: TaskService;
  private readonly tapeService: TapeService;
  private readonly truthService: TruthService;
  private readonly toolGateService: ToolGateService;
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

    const serviceDependencies = this.createServiceDependencies(options);
    this.proposalAdmissionService = serviceDependencies.proposalAdmissionService;
    this.skillLifecycleService = serviceDependencies.skillLifecycleService;
    this.skillCascadeService = serviceDependencies.skillCascadeService;
    this.taskService = serviceDependencies.taskService;
    this.truthService = serviceDependencies.truthService;
    this.ledgerService = serviceDependencies.ledgerService;
    this.parallelService = serviceDependencies.parallelService;
    this.costService = serviceDependencies.costService;
    this.verificationService = serviceDependencies.verificationService;
    this.contextService = serviceDependencies.contextService;
    this.scanConvergenceService = serviceDependencies.scanConvergenceService;
    this.tapeService = serviceDependencies.tapeService;
    this.eventPipeline = serviceDependencies.eventPipeline;
    this.scheduleIntentService = serviceDependencies.scheduleIntentService;
    this.fileChangeService = serviceDependencies.fileChangeService;
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

  private createBaseServiceContext(): BaseServiceContext {
    return {
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    };
  }

  private withActiveSkillServiceContext(
    context: BaseServiceContext,
    getActiveSkill: (sessionId: string) => SkillDocument | undefined,
  ): SkillAwareServiceContext {
    return {
      ...context,
      getActiveSkill,
    };
  }

  private createServiceDependencies(options: BrewvaRuntimeOptions): RuntimeServiceDependencies {
    const baseServiceContext = this.createBaseServiceContext();
    const taskService = new TaskService({
      config: this.config,
      isContextBudgetEnabled: () => this.isContextBudgetEnabled(),
      getTaskState: baseServiceContext.getTaskState,
      getTruthState: baseServiceContext.getTruthState,
      evaluateCompletion: (sessionId, level) => this.evaluateCompletion(sessionId, level),
      recordEvent: baseServiceContext.recordEvent,
    });
    const skillLifecycleService = new SkillLifecycleService({
      skills: this.skillRegistry,
      sessionState: this.sessionState,
      getCurrentTurn: baseServiceContext.getCurrentTurn,
      getTaskState: baseServiceContext.getTaskState,
      recordEvent: baseServiceContext.recordEvent,
      setTaskSpec: (sessionId, spec) => taskService.setTaskSpec(sessionId, spec),
    });
    const skillAwareServiceContext = this.withActiveSkillServiceContext(
      baseServiceContext,
      (sessionId) => skillLifecycleService.getActiveSkill(sessionId),
    );
    const skillCascadeService = new SkillCascadeService({
      config: this.config.skills.cascade,
      skills: this.skillRegistry,
      sessionState: this.sessionState,
      getCurrentTurn: baseServiceContext.getCurrentTurn,
      getActiveSkill: skillAwareServiceContext.getActiveSkill,
      activateSkill: (sessionId, name) => skillLifecycleService.activateSkill(sessionId, name),
      getSkillOutputs: (sessionId, skillName) =>
        skillLifecycleService.getSkillOutputs(sessionId, skillName),
      listProducedOutputKeys: (sessionId) =>
        skillLifecycleService.listProducedOutputKeys(sessionId),
      recordEvent: baseServiceContext.recordEvent,
      chainSources: options.skillCascadeChainSources,
    });
    const truthService = new TruthService({
      getTruthState: baseServiceContext.getTruthState,
      recordEvent: baseServiceContext.recordEvent,
    });
    const ledgerService = new LedgerService({
      cwd: this.cwd,
      config: this.config,
      ledger: this.evidenceLedger,
      verification: this.verificationGate,
      sessionState: this.sessionState,
      getCurrentTurn: baseServiceContext.getCurrentTurn,
      getActiveSkill: skillAwareServiceContext.getActiveSkill,
      getTaskState: baseServiceContext.getTaskState,
      getTruthState: baseServiceContext.getTruthState,
      upsertTruthFact: (sessionId, input) => truthService.upsertTruthFact(sessionId, input),
      resolveTruthFact: (sessionId, truthFactId) =>
        truthService.resolveTruthFact(sessionId, truthFactId),
      recordTaskBlocker: (sessionId, input) => taskService.recordTaskBlocker(sessionId, input),
      resolveTaskBlocker: (sessionId, blockerId) =>
        taskService.resolveTaskBlocker(sessionId, blockerId),
      recordEvent: baseServiceContext.recordEvent,
    });
    const parallelService = new ParallelService({
      securityConfig: this.config.security,
      parallel: this.parallel,
      parallelResults: this.parallelResults,
      sessionState: this.sessionState,
      getActiveSkill: skillAwareServiceContext.getActiveSkill,
      getCurrentTurn: baseServiceContext.getCurrentTurn,
      recordEvent: baseServiceContext.recordEvent,
    });
    const costService = new CostService({
      costTracker: this.costTracker,
      recordInfrastructureRow: (input) => ledgerService.recordInfrastructureRow(input),
      governancePort: options.governancePort,
      getCurrentTurn: baseServiceContext.getCurrentTurn,
      getActiveSkill: skillAwareServiceContext.getActiveSkill,
      recordEvent: baseServiceContext.recordEvent,
    });
    const verificationService = new VerificationService({
      cwd: this.cwd,
      config: this.config,
      verification: this.verificationGate,
      governancePort: options.governancePort,
      getTaskState: baseServiceContext.getTaskState,
      getTruthState: baseServiceContext.getTruthState,
      getActiveSkillName: (sessionId) => skillAwareServiceContext.getActiveSkill(sessionId)?.name,
      recordEvent: baseServiceContext.recordEvent,
      upsertTruthFact: (sessionId, input) => truthService.upsertTruthFact(sessionId, input),
      resolveTruthFact: (sessionId, truthFactId) =>
        truthService.resolveTruthFact(sessionId, truthFactId),
      recordTaskBlocker: (sessionId, input) => taskService.recordTaskBlocker(sessionId, input),
      resolveTaskBlocker: (sessionId, blockerId) =>
        taskService.resolveTaskBlocker(sessionId, blockerId),
      recordToolResult: (input) => ledgerService.recordToolResult(input),
    });
    const proposalAdmissionService = new ProposalAdmissionService({
      listDecisionReceiptEvents: (sessionId) =>
        this.eventStore.list(sessionId, { type: DECISION_RECEIPT_RECORDED_EVENT_TYPE }),
      recordEvent: baseServiceContext.recordEvent,
      getCurrentTurn: baseServiceContext.getCurrentTurn,
      getSkill: (name) => this.skillRegistry.get(name),
      setPendingDispatch: (sessionId, decision) =>
        this.skillLifecycleService.setPendingDispatch(sessionId, decision, { emitEvent: true }),
      listProducedOutputKeys: (sessionId) =>
        this.skillLifecycleService.listProducedOutputKeys(sessionId),
    });
    const contextService = new ContextService({
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      agentId: this.agentId,
      config: this.config,
      alwaysAllowedTools: CONTEXT_CRITICAL_ALLOWED_TOOLS,
      contextBudget: this.contextBudget,
      contextInjection: this.contextInjection,
      projectionEngine: this.projectionEngine,
      recordInfrastructureRow: (input) => ledgerService.recordInfrastructureRow(input),
      sessionState: this.sessionState,
      getTaskState: baseServiceContext.getTaskState,
      getTruthState: baseServiceContext.getTruthState,
      getLatestSkillSelectionProposal: (sessionId) =>
        proposalAdmissionService.getLatestProposalRecord(sessionId, "skill_selection", "accept") as
          | ProposalRecord<"skill_selection">
          | undefined,
      getAcceptedContextPackets: (sessionId, injectionScopeId) =>
        proposalAdmissionService.listInjectableContextPackets(sessionId, injectionScopeId),
      getPendingSkillDispatch: (sessionId) =>
        this.skillLifecycleService.getPendingDispatch(sessionId),
      buildSkillCandidateBlock: (selected) => buildSkillCandidateBlock(selected),
      buildSkillDispatchGateBlock: (decision) => buildSkillDispatchGateBlock(decision),
      getSkillCascadeIntent: (sessionId) => skillCascadeService.getIntent(sessionId),
      buildSkillCascadeGateBlock: (intent) => buildSkillCascadeGateBlock(intent),
      buildTaskStateBlock: (state) => buildTaskStateBlock(state),
      maybeAlignTaskStatus: (input) => taskService.maybeAlignTaskStatus(input),
      getCurrentTurn: baseServiceContext.getCurrentTurn,
      getActiveSkill: skillAwareServiceContext.getActiveSkill,
      sanitizeInput: (text) => this.sanitizeInput(text),
      getFoldedToolFailures: (sessionId) => this.turnReplay.getRecentToolFailures(sessionId, 12),
      getRecentToolOutputDistillations: (sessionId) =>
        this.getRecentToolOutputDistillations(sessionId, 12),
      recordEvent: baseServiceContext.recordEvent,
      governancePort: options.governancePort,
    });
    const scanConvergenceService = new ScanConvergenceService({
      sessionState: this.sessionState,
      listEvents: (sessionId, query) => this.eventStore.list(sessionId, query),
      getTaskState: baseServiceContext.getTaskState,
      getCurrentTurn: baseServiceContext.getCurrentTurn,
      getActiveSkillName: (sessionId) => skillAwareServiceContext.getActiveSkill(sessionId)?.name,
      recordTaskBlocker: (sessionId, input) => taskService.recordTaskBlocker(sessionId, input),
      resolveTaskBlocker: (sessionId, blockerId) =>
        taskService.resolveTaskBlocker(sessionId, blockerId),
      recordEvent: baseServiceContext.recordEvent,
    });
    const tapeService = new TapeService({
      tapeConfig: this.config.tape,
      sessionState: this.sessionState,
      queryEvents: (sessionId, query) => this.eventStore.list(sessionId, query),
      getCurrentTurn: baseServiceContext.getCurrentTurn,
      getTaskState: baseServiceContext.getTaskState,
      getTruthState: baseServiceContext.getTruthState,
      getCostSummary: (sessionId) => this.resolveCheckpointCostSummary(sessionId),
      getCostSkillLastTurnByName: (sessionId) =>
        this.resolveCheckpointCostSkillLastTurnByName(sessionId),
      getCheckpointEvidenceState: (sessionId) =>
        this.turnReplay.getCheckpointEvidenceState(sessionId),
      getCheckpointProjectionState: (sessionId) =>
        this.turnReplay.getCheckpointProjectionState(sessionId),
      recordEvent: baseServiceContext.recordEvent,
    });
    const eventPipeline = new EventPipelineService({
      events: this.eventStore,
      level: this.config.infrastructure.events.level,
      inferEventCategory,
      observeReplayEvent: (event) => this.turnReplay.observeEvent(event),
      ingestProjectionEvent: (event) => this.projectionEngine.ingestEvent(event),
      maybeRecordTapeCheckpoint: (event) => tapeService.maybeRecordTapeCheckpoint(event),
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
            getTruthState: baseServiceContext.getTruthState,
            getTaskState: baseServiceContext.getTaskState,
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
      verification: this.verificationGate,
      recordInfrastructureRow: (input) => ledgerService.recordInfrastructureRow(input),
      getActiveSkill: skillAwareServiceContext.getActiveSkill,
      getCurrentTurn: baseServiceContext.getCurrentTurn,
      recordEvent: baseServiceContext.recordEvent,
    });
    const sessionLifecycleService = new SessionLifecycleService({
      sessionState: this.sessionState,
      contextBudget: this.contextBudget,
      contextInjection: this.contextInjection,
      clearReservedInjectionTokensForSession: (sessionId) =>
        contextService.clearReservedInjectionTokensForSession(sessionId),
      fileChanges: this.fileChanges,
      verification: this.verificationGate,
      parallel: this.parallel,
      parallelResults: this.parallelResults,
      costTracker: this.costTracker,
      projectionEngine: this.projectionEngine,
      turnReplay: this.turnReplay,
      events: this.eventStore,
      ledger: this.evidenceLedger,
      resolveTaskBlocker: (sessionId, blockerId) =>
        taskService.resolveTaskBlocker(sessionId, blockerId),
      recordEvent: baseServiceContext.recordEvent,
    });
    const toolGateService = new ToolGateService({
      securityConfig: this.config.security,
      costTracker: this.costTracker,
      sessionState: this.sessionState,
      alwaysAllowedTools: CONTROL_PLANE_TOOLS,
      getActiveSkill: skillAwareServiceContext.getActiveSkill,
      getPendingDispatch: (sessionId) => skillLifecycleService.getPendingDispatch(sessionId),
      getCurrentTurn: baseServiceContext.getCurrentTurn,
      recordEvent: baseServiceContext.recordEvent,
      checkContextCompactionGate: (sessionId, toolName, usage) =>
        contextService.checkContextCompactionGate(sessionId, toolName, usage),
      observeContextUsage: (sessionId, usage) =>
        contextService.observeContextUsage(sessionId, usage),
      markToolCall: (sessionId, toolName) => fileChangeService.markToolCall(sessionId, toolName),
      trackToolCallStart: (input) => fileChangeService.trackToolCallStart(input),
      recordToolResult: (input) => ledgerService.recordToolResult(input),
      trackToolCallEnd: (input) => fileChangeService.trackToolCallEnd(input),
      checkScanConvergence: (input) => scanConvergenceService.checkToolCall(input),
      observeScanConvergenceToolResult: (input) => scanConvergenceService.observeToolResult(input),
    });

    return {
      proposalAdmissionService,
      skillLifecycleService,
      skillCascadeService,
      taskService,
      truthService,
      ledgerService,
      parallelService,
      costService,
      verificationService,
      contextService,
      scanConvergenceService,
      tapeService,
      eventPipeline,
      scheduleIntentService,
      fileChangeService,
      sessionLifecycleService,
      toolGateService,
    };
  }

  private createDomainApis(): RuntimeDomainApis {
    return createRuntimeDomainApis({
      workspaceRoot: this.workspaceRoot,
      config: this.config,
      skillRegistry: this.skillRegistry,
      verificationGate: this.verificationGate,
      turnWalStore: this.turnWalStore,
      eventStore: this.eventStore,
      proposalAdmissionService: this.proposalAdmissionService,
      skillLifecycleService: this.skillLifecycleService,
      skillCascadeService: this.skillCascadeService,
      taskService: this.taskService,
      truthService: this.truthService,
      ledgerService: this.ledgerService,
      parallelService: this.parallelService,
      costService: this.costService,
      verificationService: this.verificationService,
      contextService: this.contextService,
      scanConvergenceService: this.scanConvergenceService,
      tapeService: this.tapeService,
      eventPipeline: this.eventPipeline,
      scheduleIntentService: this.scheduleIntentService,
      fileChangeService: this.fileChangeService,
      sessionLifecycleService: this.sessionLifecycleService,
      toolGateService: this.toolGateService,
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      sanitizeInput: (text) => this.sanitizeInput(text),
    });
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
    const liveSummary = this.costService.getCostSummary(sessionId);
    if (this.hasCostSummaryData(liveSummary)) {
      return liveSummary;
    }
    return this.turnReplay.getCostSummary(sessionId);
  }

  private resolveCheckpointCostSkillLastTurnByName(sessionId: string): Record<string, number> {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    const liveSummary = this.costService.getCostSummary(sessionId);
    if (this.hasCostSummaryData(liveSummary)) {
      return this.costTracker.getSkillLastTurnByName(sessionId);
    }
    return this.turnReplay.getCostSkillLastTurnByName(sessionId);
  }

  private hasCostSummaryData(summary: SessionCostSummary): boolean {
    return (
      summary.totalTokens > 0 ||
      summary.totalCostUsd > 0 ||
      summary.alerts.length > 0 ||
      Object.keys(summary.models).length > 0 ||
      Object.keys(summary.skills).length > 0 ||
      Object.keys(summary.tools).length > 0
    );
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

  private isContextBudgetEnabled(): boolean {
    return this.config.infrastructure.contextBudget.enabled;
  }
}
