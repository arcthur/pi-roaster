import { resolve } from "node:path";
import { TurnWALRecovery } from "./channels/turn-wal-recovery.js";
import { TurnWALStore } from "./channels/turn-wal.js";
import type { TurnEnvelope } from "./channels/turn.js";
import type {
  CognitivePort,
  CognitiveTokenBudgetStatus,
  CognitiveUsage,
} from "./cognitive/port.js";
import { cognitiveBudgetPayload, cognitiveUsagePayload } from "./cognitive/usage.js";
import { loadBrewvaConfigWithDiagnostics, type BrewvaConfigDiagnostic } from "./config/loader.js";
import { resolveWorkspaceRootDir } from "./config/paths.js";
import { ContextBudgetManager } from "./context/budget.js";
import { normalizeAgentId } from "./context/identity.js";
import { ContextInjectionCollector } from "./context/injection.js";
import { SessionCostTracker } from "./cost/tracker.js";
import { BrewvaEventStore } from "./events/store.js";
import { EvidenceLedger } from "./ledger/evidence-ledger.js";
import { MemoryEngine } from "./memory/engine.js";
import type { MemorySearchResult, WorkingMemorySnapshot } from "./memory/types.js";
import { ParallelBudgetManager } from "./parallel/budget.js";
import { ParallelResultStore } from "./parallel/results.js";
import {
  ALWAYS_ALLOWED_TOOLS,
  buildContextSourceTokenLimits,
  buildSkillCandidateBlock,
  buildTaskStateBlock,
  inferEventCategory,
} from "./runtime-helpers.js";
import { SchedulerService } from "./schedule/service.js";
import { sanitizeContextText } from "./security/sanitize.js";
import { ContextService } from "./services/context.js";
import { CostService } from "./services/cost.js";
import { EventPipelineService, type RuntimeRecordEventInput } from "./services/event-pipeline.js";
import { FileChangeService } from "./services/file-change.js";
import { LedgerService } from "./services/ledger.js";
import { MemoryAccessService } from "./services/memory-access.js";
import { ParallelService } from "./services/parallel.js";
import { ScheduleIntentService } from "./services/schedule-intent.js";
import { SessionLifecycleService } from "./services/session-lifecycle.js";
import { RuntimeSessionStateStore } from "./services/session-state.js";
import { SkillLifecycleService } from "./services/skill-lifecycle.js";
import { TapeService } from "./services/tape.js";
import { TaskService } from "./services/task.js";
import { ToolGateService } from "./services/tool-gate.js";
import { TruthService } from "./services/truth.js";
import { VerificationService } from "./services/verification.js";
import { SkillRegistry } from "./skills/registry.js";
import { selectTopKSkills } from "./skills/selector.js";
import { FileChangeTracker } from "./state/file-change-tracker.js";
import { TurnReplayEngine } from "./tape/replay-engine.js";
import type {
  ContextPressureLevel,
  ContextPressureStatus,
  ContextCompactionGateStatus,
  ContextBudgetUsage,
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
  SkillDocument,
  SkillSelection,
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
import { VerificationGate } from "./verification/gate.js";

export interface BrewvaRuntimeOptions {
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
  cognitivePort?: CognitivePort;
  agentId?: string;
}

export interface VerifyCompletionOptions {
  executeCommands?: boolean;
  timeoutMs?: number;
}

type RuntimeConfigState = {
  config: BrewvaConfig;
  diagnostics: BrewvaConfigDiagnostic[];
};

type RuntimeCoreDependencies = {
  skillRegistry: SkillRegistry;
  ledger: EvidenceLedger;
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
  memoryEngine: MemoryEngine;
};

type RuntimeServiceDependencies = {
  skillLifecycleService: SkillLifecycleService;
  taskService: TaskService;
  truthService: TruthService;
  ledgerService: LedgerService;
  parallelService: ParallelService;
  costService: CostService;
  verificationService: VerificationService;
  contextService: ContextService;
  tapeService: TapeService;
  eventPipeline: EventPipelineService;
  memoryAccessService: MemoryAccessService;
  scheduleIntentService: ScheduleIntentService;
  fileChangeService: FileChangeService;
  sessionLifecycleService: SessionLifecycleService;
  toolGateService: ToolGateService;
};

export class BrewvaRuntime {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly agentId: string;
  readonly config: BrewvaConfig;
  readonly configDiagnostics: BrewvaConfigDiagnostic[];
  readonly skills: {
    refresh(): void;
    list(): SkillDocument[];
    get(name: string): SkillDocument | undefined;
    select(message: string): SkillSelection[];
    activate(
      sessionId: string,
      name: string,
    ): { ok: boolean; reason?: string; skill?: SkillDocument };
    getActive(sessionId: string): SkillDocument | undefined;
    validateOutputs(
      sessionId: string,
      outputs: Record<string, unknown>,
    ): { ok: boolean; missing: string[] };
    validateComposePlan(plan: {
      steps: Array<{ skill: string; consumes?: string[]; produces?: string[] }>;
    }): { valid: boolean; warnings: string[]; errors: string[] };
    complete(
      sessionId: string,
      output: Record<string, unknown>,
      options?: { proof?: string; summary?: string; notes?: string },
    ): { ok: boolean; missing: string[] };
    getOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined;
    getConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown>;
  };
  readonly context: {
    onTurnStart(sessionId: string, turnIndex: number): void;
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
      accepted: boolean;
      originalTokens: number;
      finalTokens: number;
      truncated: boolean;
    }>;
    planSupplementalInjection(
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
    commitSupplementalInjection(
      sessionId: string,
      finalTokens: number,
      injectionScopeId?: string,
    ): void;
    shouldRequestCompaction(sessionId: string, usage: ContextBudgetUsage | undefined): boolean;
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
      success: boolean;
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
      success: boolean;
    }): void;
    rollbackLastPatchSet(sessionId: string): RollbackResult;
    resolveUndoSessionId(preferredSessionId?: string): string | undefined;
    recordResult(input: {
      sessionId: string;
      toolName: string;
      args: Record<string, unknown>;
      outputText: string;
      success: boolean;
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
    getLedgerDigest(sessionId: string): string;
    queryLedger(sessionId: string, query: EvidenceQuery): string;
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
  readonly memory: {
    getWorking(sessionId: string): WorkingMemorySnapshot | undefined;
    search(
      sessionId: string,
      input: { query: string; limit?: number },
    ): Promise<MemorySearchResult>;
    dismissInsight(
      sessionId: string,
      insightId: string,
    ): { ok: boolean; error?: "missing_id" | "not_found" };
    reviewEvolvesEdge(
      sessionId: string,
      input: { edgeId: string; decision: "accept" | "reject" },
    ): { ok: boolean; error?: "missing_id" | "not_found" | "already_set" };
    refreshIfNeeded(input: {
      sessionId: string;
      force?: boolean;
    }): WorkingMemorySnapshot | undefined;
    clearSessionCache(sessionId: string): void;
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
  };

  readonly ledger: EvidenceLedger;
  readonly parallel: ParallelBudgetManager;
  readonly parallelResults: ParallelResultStore;
  readonly contextBudget: ContextBudgetManager;
  readonly contextInjection: ContextInjectionCollector;
  readonly fileChanges: FileChangeTracker;
  readonly costTracker: SessionCostTracker;

  private readonly skillRegistry: SkillRegistry;
  private readonly verificationGate: VerificationGate;
  private readonly eventStore: BrewvaEventStore;
  private readonly turnWalStore: TurnWALStore;
  private readonly memoryEngine: MemoryEngine;

  private readonly sessionState = new RuntimeSessionStateStore();
  private readonly contextService: ContextService;
  private readonly costService: CostService;
  private readonly eventPipeline: EventPipelineService;
  private readonly fileChangeService: FileChangeService;
  private readonly ledgerService: LedgerService;
  private readonly memoryAccessService: MemoryAccessService;
  private readonly parallelService: ParallelService;
  private readonly scheduleIntentService: ScheduleIntentService;
  private readonly sessionLifecycleService: SessionLifecycleService;
  private readonly skillLifecycleService: SkillLifecycleService;
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
    this.configDiagnostics = configState.diagnostics;
    const coreDependencies = this.createCoreDependencies(options);
    this.skillRegistry = coreDependencies.skillRegistry;
    this.ledger = coreDependencies.ledger;
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
    this.memoryEngine = coreDependencies.memoryEngine;

    const serviceDependencies = this.createServiceDependencies(options);
    this.skillLifecycleService = serviceDependencies.skillLifecycleService;
    this.taskService = serviceDependencies.taskService;
    this.truthService = serviceDependencies.truthService;
    this.ledgerService = serviceDependencies.ledgerService;
    this.parallelService = serviceDependencies.parallelService;
    this.costService = serviceDependencies.costService;
    this.verificationService = serviceDependencies.verificationService;
    this.contextService = serviceDependencies.contextService;
    this.tapeService = serviceDependencies.tapeService;
    this.eventPipeline = serviceDependencies.eventPipeline;
    this.memoryAccessService = serviceDependencies.memoryAccessService;
    this.scheduleIntentService = serviceDependencies.scheduleIntentService;
    this.fileChangeService = serviceDependencies.fileChangeService;
    this.sessionLifecycleService = serviceDependencies.sessionLifecycleService;
    this.toolGateService = serviceDependencies.toolGateService;

    const domainApis = this.createDomainApis();
    this.skills = domainApis.skills;
    this.context = domainApis.context;
    this.tools = domainApis.tools;
    this.task = domainApis.task;
    this.truth = domainApis.truth;
    this.memory = domainApis.memory;
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
        diagnostics: [],
      };
    }
    const loaded = loadBrewvaConfigWithDiagnostics({
      cwd: this.cwd,
      configPath: options.configPath,
    });
    return {
      config: loaded.config,
      diagnostics: loaded.diagnostics,
    };
  }

  private createCoreDependencies(options: BrewvaRuntimeOptions): RuntimeCoreDependencies {
    const skillRegistry = new SkillRegistry({
      rootDir: this.cwd,
      config: this.config,
    });
    skillRegistry.load();
    skillRegistry.writeIndex();

    const ledger = new EvidenceLedger(resolve(this.workspaceRoot, this.config.ledger.path));
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
      sourceTokenLimits: this.isContextBudgetEnabled()
        ? buildContextSourceTokenLimits(
            this.config.infrastructure.contextBudget.maxInjectionTokens,
            {
              toolFailureInjection: this.config.infrastructure.toolFailureInjection,
            },
          )
        : {},
      truncationStrategy: this.config.infrastructure.contextBudget.truncationStrategy,
    });
    const turnReplay = new TurnReplayEngine({
      listEvents: (sessionId) => eventStore.list(sessionId),
      getTurn: (sessionId) => this.getCurrentTurn(sessionId),
    });
    const fileChanges = new FileChangeTracker(this.cwd, {
      artifactsBaseDir: this.workspaceRoot,
    });
    const costTracker = new SessionCostTracker(this.config.infrastructure.costTracking, {
      cognitiveTokensBudget: this.config.memory.cognitive.maxTokensPerTurn,
    });
    const memoryEngine = new MemoryEngine({
      enabled: this.config.memory.enabled,
      rootDir: resolve(this.workspaceRoot, this.config.memory.dir),
      workingFile: this.config.memory.workingFile,
      maxWorkingChars: this.config.memory.maxWorkingChars,
      dailyRefreshHourLocal: this.config.memory.dailyRefreshHourLocal,
      crystalMinUnits: this.config.memory.crystalMinUnits,
      retrievalTopK: this.config.memory.retrievalTopK,
      retrievalWeights: this.config.memory.retrievalWeights,
      evolvesMode: this.config.memory.evolvesMode,
      cognitiveMode: this.config.memory.cognitive.mode,
      cognitivePort: options.cognitivePort,
      getCognitiveBudgetStatus: (sessionId) => this.getCognitiveBudgetStatus(sessionId),
      recordCognitiveUsage: (input) => this.recordCognitiveUsage(input),
      globalEnabled: this.config.memory.global.enabled,
      globalMinConfidence: this.config.memory.global.minConfidence,
      recordEvent: (eventInput) => this.recordEvent(eventInput),
    });

    return {
      skillRegistry,
      ledger,
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
      memoryEngine,
    };
  }

  private createServiceDependencies(options: BrewvaRuntimeOptions): RuntimeServiceDependencies {
    const skillLifecycleService = new SkillLifecycleService({
      skills: this.skillRegistry,
      sessionState: this.sessionState,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    const taskService = new TaskService({
      config: this.config,
      isContextBudgetEnabled: () => this.isContextBudgetEnabled(),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      evaluateCompletion: (sessionId, level) => this.evaluateCompletion(sessionId, level),
      recordEvent: (input) => this.recordEvent(input),
    });
    const truthService = new TruthService({
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    const ledgerService = new LedgerService({
      cwd: this.cwd,
      config: this.config,
      ledger: this.ledger,
      verification: this.verificationGate,
      sessionState: this.sessionState,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getActiveSkill: (sessionId) => skillLifecycleService.getActiveSkill(sessionId),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      upsertTruthFact: (sessionId, input) => truthService.upsertTruthFact(sessionId, input),
      resolveTruthFact: (sessionId, truthFactId) =>
        truthService.resolveTruthFact(sessionId, truthFactId),
      recordTaskBlocker: (sessionId, input) => taskService.recordTaskBlocker(sessionId, input),
      resolveTaskBlocker: (sessionId, blockerId) =>
        taskService.resolveTaskBlocker(sessionId, blockerId),
      recordEvent: (input) => this.recordEvent(input),
    });
    const parallelService = new ParallelService({
      securityConfig: this.config.security,
      parallel: this.parallel,
      parallelResults: this.parallelResults,
      sessionState: this.sessionState,
      getActiveSkill: (sessionId) => skillLifecycleService.getActiveSkill(sessionId),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    const costService = new CostService({
      costTracker: this.costTracker,
      ledger: this.ledger,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getActiveSkill: (sessionId) => skillLifecycleService.getActiveSkill(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    const verificationService = new VerificationService({
      cwd: this.cwd,
      config: this.config,
      verification: this.verificationGate,
      cognitiveMode: this.config.memory.cognitive.mode,
      cognitivePort: options.cognitivePort,
      getCognitiveBudgetStatus: (sessionId) => this.getCognitiveBudgetStatus(sessionId),
      recordCognitiveUsage: (input) => this.recordCognitiveUsage(input),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      getActiveSkillName: (sessionId) => skillLifecycleService.getActiveSkill(sessionId)?.name,
      recordEvent: (input) => this.recordEvent(input),
      upsertTruthFact: (sessionId, input) => truthService.upsertTruthFact(sessionId, input),
      resolveTruthFact: (sessionId, truthFactId) =>
        truthService.resolveTruthFact(sessionId, truthFactId),
      recordTaskBlocker: (sessionId, input) => taskService.recordTaskBlocker(sessionId, input),
      resolveTaskBlocker: (sessionId, blockerId) =>
        taskService.resolveTaskBlocker(sessionId, blockerId),
      recordToolResult: (input) => ledgerService.recordToolResult(input),
    });
    const contextService = new ContextService({
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      agentId: this.agentId,
      config: this.config,
      contextBudget: this.contextBudget,
      contextInjection: this.contextInjection,
      memory: this.memoryEngine,
      fileChanges: this.fileChanges,
      ledger: this.ledger,
      sessionState: this.sessionState,
      queryEvents: (sessionId, query) => this.eventStore.list(sessionId, query),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      selectSkills: (message) => this.selectSkills(message),
      buildSkillCandidateBlock: (selected) => buildSkillCandidateBlock(selected),
      buildTaskStateBlock: (state) => buildTaskStateBlock(state),
      maybeAlignTaskStatus: (input) => taskService.maybeAlignTaskStatus(input),
      getLedgerDigest: (sessionId) => ledgerService.getLedgerDigest(sessionId),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getActiveSkill: (sessionId) => skillLifecycleService.getActiveSkill(sessionId),
      sanitizeInput: (text) => this.sanitizeInput(text),
      getFoldedToolFailures: (sessionId) => this.turnReplay.getRecentToolFailures(sessionId, 12),
      recordEvent: (input) => this.recordEvent(input),
    });
    const tapeService = new TapeService({
      tapeConfig: this.config.tape,
      sessionState: this.sessionState,
      queryEvents: (sessionId, query) => this.eventStore.list(sessionId, query),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      getCostSummary: (sessionId) => this.resolveCheckpointCostSummary(sessionId),
      getCostSkillLastTurnByName: (sessionId) =>
        this.resolveCheckpointCostSkillLastTurnByName(sessionId),
      getCheckpointEvidenceState: (sessionId) =>
        this.turnReplay.getCheckpointEvidenceState(sessionId),
      getCheckpointMemoryState: (sessionId) => this.turnReplay.getCheckpointMemoryState(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    const eventPipeline = new EventPipelineService({
      events: this.eventStore,
      level: this.config.infrastructure.events.level,
      inferEventCategory,
      observeReplayEvent: (event) => this.turnReplay.observeEvent(event),
      ingestMemoryEvent: (event) => this.memoryEngine.ingestEvent(event),
      maybeRecordTapeCheckpoint: (event) => tapeService.maybeRecordTapeCheckpoint(event),
    });
    const memoryAccessService = new MemoryAccessService({
      memory: this.memoryEngine,
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
            getTruthState: (sessionId) => this.getTruthState(sessionId),
            getTaskState: (sessionId) => this.getTaskState(sessionId),
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
      ledger: this.ledger,
      getActiveSkill: (sessionId) => skillLifecycleService.getActiveSkill(sessionId),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      recordEvent: (input) => this.recordEvent(input),
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
      memory: this.memoryEngine,
      turnReplay: this.turnReplay,
      events: this.eventStore,
      ledger: this.ledger,
    });
    const toolGateService = new ToolGateService({
      securityConfig: this.config.security,
      costTracker: this.costTracker,
      sessionState: this.sessionState,
      alwaysAllowedTools: ALWAYS_ALLOWED_TOOLS,
      getActiveSkill: (sessionId) => skillLifecycleService.getActiveSkill(sessionId),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      recordEvent: (input) => this.recordEvent(input),
      checkContextCompactionGate: (sessionId, toolName, usage) =>
        contextService.checkContextCompactionGate(sessionId, toolName, usage),
      observeContextUsage: (sessionId, usage) =>
        contextService.observeContextUsage(sessionId, usage),
      markToolCall: (sessionId, toolName) => fileChangeService.markToolCall(sessionId, toolName),
      trackToolCallStart: (input) => fileChangeService.trackToolCallStart(input),
      recordToolResult: (input) => ledgerService.recordToolResult(input),
      trackToolCallEnd: (input) => fileChangeService.trackToolCallEnd(input),
    });

    return {
      skillLifecycleService,
      taskService,
      truthService,
      ledgerService,
      parallelService,
      costService,
      verificationService,
      contextService,
      tapeService,
      eventPipeline,
      memoryAccessService,
      scheduleIntentService,
      fileChangeService,
      sessionLifecycleService,
      toolGateService,
    };
  }

  private createDomainApis(): {
    skills: BrewvaRuntime["skills"];
    context: BrewvaRuntime["context"];
    tools: BrewvaRuntime["tools"];
    task: BrewvaRuntime["task"];
    truth: BrewvaRuntime["truth"];
    memory: BrewvaRuntime["memory"];
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
        list: () => this.skillRegistry.list(),
        get: (name) => this.skillRegistry.get(name),
        select: (message) => this.selectSkills(message),
        activate: (sessionId, name) => this.skillLifecycleService.activateSkill(sessionId, name),
        getActive: (sessionId) => this.skillLifecycleService.getActiveSkill(sessionId),
        validateOutputs: (sessionId, outputs) =>
          this.skillLifecycleService.validateSkillOutputs(sessionId, outputs),
        validateComposePlan: (plan) => this.skillLifecycleService.validateComposePlan(plan),
        complete: (sessionId, output) =>
          this.skillLifecycleService.completeSkill(sessionId, output),
        getOutputs: (sessionId, skillName) =>
          this.skillLifecycleService.getSkillOutputs(sessionId, skillName),
        getConsumedOutputs: (sessionId, targetSkillName) =>
          this.skillLifecycleService.getAvailableConsumedOutputs(sessionId, targetSkillName),
      },
      context: {
        onTurnStart: (sessionId, turnIndex) =>
          this.sessionLifecycleService.onTurnStart(sessionId, turnIndex),
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
        buildInjection: (sessionId, prompt, usage, injectionScopeId) =>
          this.contextService.buildContextInjection(sessionId, prompt, usage, injectionScopeId),
        planSupplementalInjection: (sessionId, inputText, usage, injectionScopeId) =>
          this.contextService.planSupplementalContextInjection(
            sessionId,
            inputText,
            usage,
            injectionScopeId,
          ),
        commitSupplementalInjection: (sessionId, finalTokens, injectionScopeId) =>
          this.contextService.commitSupplementalContextInjection(
            sessionId,
            finalTokens,
            injectionScopeId,
          ),
        shouldRequestCompaction: (sessionId, usage) =>
          this.contextService.shouldRequestCompaction(sessionId, usage),
        getCompactionInstructions: () => this.contextService.getCompactionInstructions(),
        getCompactionWindowTurns: () => this.contextService.getRecentCompactionWindowTurns(),
        markCompacted: (sessionId, input) =>
          this.contextService.markContextCompacted(sessionId, input),
      },
      tools: {
        checkAccess: (sessionId, toolName) =>
          this.toolGateService.checkToolAccess(sessionId, toolName),
        start: (input) => this.toolGateService.startToolCall(input),
        finish: (input) => {
          this.toolGateService.finishToolCall(input);
        },
        acquireParallelSlot: (sessionId, runId) =>
          this.parallelService.acquireParallelSlot(sessionId, runId),
        releaseParallelSlot: (sessionId, runId) =>
          this.parallelService.releaseParallelSlot(sessionId, runId),
        markCall: (sessionId, toolName) => this.fileChangeService.markToolCall(sessionId, toolName),
        trackCallStart: (input) => this.fileChangeService.trackToolCallStart(input),
        trackCallEnd: (input) => this.fileChangeService.trackToolCallEnd(input),
        rollbackLastPatchSet: (sessionId) => this.fileChangeService.rollbackLastPatchSet(sessionId),
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
        getState: (sessionId) => this.turnReplay.getTaskState(sessionId),
      },
      truth: {
        getState: (sessionId) => this.turnReplay.getTruthState(sessionId),
        getLedgerDigest: (sessionId) => this.ledgerService.getLedgerDigest(sessionId),
        queryLedger: (sessionId, query) => this.ledgerService.queryLedger(sessionId, query),
        upsertFact: (sessionId, input) => this.truthService.upsertTruthFact(sessionId, input),
        resolveFact: (sessionId, truthFactId) =>
          this.truthService.resolveTruthFact(sessionId, truthFactId),
      },
      memory: {
        getWorking: (sessionId) => this.memoryAccessService.getWorkingMemory(sessionId),
        search: (sessionId, input) => this.memoryAccessService.search(sessionId, input),
        dismissInsight: (sessionId, insightId) =>
          this.memoryAccessService.dismissMemoryInsight(sessionId, insightId),
        reviewEvolvesEdge: (sessionId, input) =>
          this.memoryAccessService.reviewMemoryEvolvesEdge(sessionId, input),
        refreshIfNeeded: (input) => this.memoryEngine.refreshIfNeeded(input),
        clearSessionCache: (sessionId) => this.memoryEngine.clearSessionCache(sessionId),
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
            recordEvent: (input) => {
              this.recordEvent({
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
        evaluate: (sessionId, level) => this.verificationGate.evaluate(sessionId, level),
        verify: (sessionId, level, options) =>
          this.verificationService.verifyCompletion(sessionId, level, options ?? {}),
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
        clearState: (sessionId) => this.sessionLifecycleService.clearSessionState(sessionId),
      },
    };
  }

  private selectSkills(message: string): SkillSelection[] {
    const input = this.config.security.sanitizeContext ? sanitizeContextText(message) : message;
    return selectTopKSkills(input, this.skillRegistry.buildIndex(), this.config.skills.selector.k);
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

  private getCognitiveBudgetStatus(sessionId: string): CognitiveTokenBudgetStatus {
    return this.costTracker.getCognitiveBudgetStatus(sessionId, this.getCurrentTurn(sessionId));
  }

  private recordCognitiveUsage(input: {
    sessionId: string;
    stage: string;
    usage: CognitiveUsage;
  }): CognitiveTokenBudgetStatus {
    const turn = this.getCurrentTurn(input.sessionId);
    const budget = this.costTracker.recordCognitiveUsage(input.sessionId, {
      turn,
      usage: input.usage,
    });
    this.recordEvent({
      sessionId: input.sessionId,
      type: "cognitive_usage_recorded",
      turn,
      payload: {
        stage: input.stage,
        usage: cognitiveUsagePayload(input.usage),
        budget: cognitiveBudgetPayload(budget),
      },
    });
    return budget;
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

  private isContextBudgetEnabled(): boolean {
    return this.config.infrastructure.contextBudget.enabled;
  }
}
