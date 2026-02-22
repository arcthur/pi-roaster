import { resolve } from "node:path";
import { loadBrewvaConfigWithDiagnostics, type BrewvaConfigDiagnostic } from "./config/loader.js";
import { resolveWorkspaceRootDir } from "./config/paths.js";
import { ContextBudgetManager } from "./context/budget.js";
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
}

export interface VerifyCompletionOptions {
  executeCommands?: boolean;
  timeoutMs?: number;
}

export class BrewvaRuntime {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly config: BrewvaConfig;
  readonly configDiagnostics: BrewvaConfigDiagnostic[];
  readonly skills: SkillRegistry;
  readonly ledger: EvidenceLedger;
  readonly verification: VerificationGate;
  readonly parallel: ParallelBudgetManager;
  readonly parallelResults: ParallelResultStore;
  readonly events: BrewvaEventStore;
  readonly contextBudget: ContextBudgetManager;
  readonly contextInjection: ContextInjectionCollector;
  readonly memory: MemoryEngine;
  readonly fileChanges: FileChangeTracker;
  readonly costTracker: SessionCostTracker;

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
    if (options.config) {
      this.config = options.config;
      this.configDiagnostics = [];
    } else {
      const loaded = loadBrewvaConfigWithDiagnostics({
        cwd: this.cwd,
        configPath: options.configPath,
      });
      this.config = loaded.config;
      this.configDiagnostics = loaded.diagnostics;
    }

    this.skills = new SkillRegistry({
      rootDir: this.cwd,
      config: this.config,
    });
    this.skills.load();
    this.skills.writeIndex();

    const ledgerPath = resolve(this.workspaceRoot, this.config.ledger.path);
    this.ledger = new EvidenceLedger(ledgerPath);
    this.verification = new VerificationGate(this.config);
    this.parallel = new ParallelBudgetManager(this.config.parallel);
    this.parallelResults = new ParallelResultStore();
    this.events = new BrewvaEventStore(this.config.infrastructure.events, this.workspaceRoot);
    this.contextBudget = new ContextBudgetManager(this.config.infrastructure.contextBudget);
    this.contextInjection = new ContextInjectionCollector({
      sourceTokenLimits: this.isContextBudgetEnabled()
        ? buildContextSourceTokenLimits(this.config.infrastructure.contextBudget.maxInjectionTokens)
        : {},
      truncationStrategy: this.config.infrastructure.contextBudget.truncationStrategy,
    });
    this.turnReplay = new TurnReplayEngine({
      listEvents: (sessionId) => this.events.list(sessionId),
      getTurn: (sessionId) => this.getCurrentTurn(sessionId),
    });
    this.fileChanges = new FileChangeTracker(this.cwd, {
      artifactsBaseDir: this.workspaceRoot,
    });
    this.costTracker = new SessionCostTracker(this.config.infrastructure.costTracking);
    this.memory = new MemoryEngine({
      enabled: this.config.memory.enabled,
      rootDir: resolve(this.workspaceRoot, this.config.memory.dir),
      workingFile: this.config.memory.workingFile,
      maxWorkingChars: this.config.memory.maxWorkingChars,
      dailyRefreshHourLocal: this.config.memory.dailyRefreshHourLocal,
      crystalMinUnits: this.config.memory.crystalMinUnits,
      retrievalTopK: this.config.memory.retrievalTopK,
      retrievalWeights: this.config.memory.retrievalWeights,
      evolvesMode: this.config.memory.evolvesMode,
      recordEvent: (eventInput) => this.recordEvent(eventInput),
    });
    this.skillLifecycleService = new SkillLifecycleService({
      skills: this.skills,
      sessionState: this.sessionState,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    this.taskService = new TaskService({
      config: this.config,
      isContextBudgetEnabled: () => this.isContextBudgetEnabled(),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      evaluateCompletion: (sessionId, level) => this.evaluateCompletion(sessionId, level),
      recordEvent: (input) => this.recordEvent(input),
    });
    this.truthService = new TruthService({
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    this.ledgerService = new LedgerService({
      cwd: this.cwd,
      config: this.config,
      ledger: this.ledger,
      verification: this.verification,
      sessionState: this.sessionState,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getActiveSkill: (sessionId) => this.skillLifecycleService.getActiveSkill(sessionId),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      upsertTruthFact: (sessionId, input) => this.truthService.upsertTruthFact(sessionId, input),
      resolveTruthFact: (sessionId, truthFactId) =>
        this.truthService.resolveTruthFact(sessionId, truthFactId),
      recordTaskBlocker: (sessionId, input) => this.taskService.recordTaskBlocker(sessionId, input),
      resolveTaskBlocker: (sessionId, blockerId) =>
        this.taskService.resolveTaskBlocker(sessionId, blockerId),
      recordEvent: (input) => this.recordEvent(input),
    });
    this.parallelService = new ParallelService({
      securityConfig: this.config.security,
      parallel: this.parallel,
      parallelResults: this.parallelResults,
      sessionState: this.sessionState,
      getActiveSkill: (sessionId) => this.skillLifecycleService.getActiveSkill(sessionId),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    this.costService = new CostService({
      costTracker: this.costTracker,
      ledger: this.ledger,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getActiveSkill: (sessionId) => this.skillLifecycleService.getActiveSkill(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    this.verificationService = new VerificationService({
      cwd: this.cwd,
      config: this.config,
      verification: this.verification,
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      upsertTruthFact: (sessionId, input) => this.truthService.upsertTruthFact(sessionId, input),
      resolveTruthFact: (sessionId, truthFactId) =>
        this.truthService.resolveTruthFact(sessionId, truthFactId),
      recordTaskBlocker: (sessionId, input) => this.taskService.recordTaskBlocker(sessionId, input),
      resolveTaskBlocker: (sessionId, blockerId) =>
        this.taskService.resolveTaskBlocker(sessionId, blockerId),
      recordToolResult: (input) => this.ledgerService.recordToolResult(input),
    });
    this.contextService = new ContextService({
      cwd: this.cwd,
      config: this.config,
      contextBudget: this.contextBudget,
      contextInjection: this.contextInjection,
      memory: this.memory,
      fileChanges: this.fileChanges,
      ledger: this.ledger,
      sessionState: this.sessionState,
      queryEvents: (sessionId, query) => this.events.list(sessionId, query),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      selectSkills: (message) => this.selectSkills(message),
      buildSkillCandidateBlock: (selected) => buildSkillCandidateBlock(selected),
      buildTaskStateBlock: (state) => buildTaskStateBlock(state),
      maybeAlignTaskStatus: (input) => this.taskService.maybeAlignTaskStatus(input),
      getLedgerDigest: (sessionId) => this.ledgerService.getLedgerDigest(sessionId),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getActiveSkill: (sessionId) => this.skillLifecycleService.getActiveSkill(sessionId),
      sanitizeInput: (text) => this.sanitizeInput(text),
      recordEvent: (input) => this.recordEvent(input),
    });
    this.tapeService = new TapeService({
      tapeConfig: this.config.tape,
      sessionState: this.sessionState,
      queryEvents: (sessionId, query) => this.events.list(sessionId, query),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    this.eventPipeline = new EventPipelineService({
      events: this.events,
      inferEventCategory,
      invalidateReplay: (sessionId) => this.turnReplay.invalidate(sessionId),
      ingestMemoryEvent: (event) => this.memory.ingestEvent(event),
      maybeRecordTapeCheckpoint: (event) => this.tapeService.maybeRecordTapeCheckpoint(event),
    });
    this.memoryAccessService = new MemoryAccessService({
      memory: this.memory,
    });
    this.scheduleIntentService = new ScheduleIntentService({
      createManager: () =>
        new SchedulerService({
          runtime: {
            workspaceRoot: this.workspaceRoot,
            scheduleConfig: this.config.schedule,
            listSessionIds: () => this.events.listSessionIds(),
            listEvents: (sessionId, query) => this.events.list(sessionId, query),
            recordEvent: (input) => this.eventPipeline.recordEvent(input),
            subscribeEvents: (listener) => this.eventPipeline.subscribeEvents(listener),
            getTruthState: (sessionId) => this.getTruthState(sessionId),
            getTaskState: (sessionId) => this.getTaskState(sessionId),
          },
          enableExecution: false,
        }),
    });
    this.fileChangeService = new FileChangeService({
      sessionState: this.sessionState,
      fileChanges: this.fileChanges,
      costTracker: this.costTracker,
      verification: this.verification,
      ledger: this.ledger,
      getActiveSkill: (sessionId) => this.skillLifecycleService.getActiveSkill(sessionId),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    this.sessionLifecycleService = new SessionLifecycleService({
      sessionState: this.sessionState,
      contextBudget: this.contextBudget,
      contextInjection: this.contextInjection,
      clearReservedInjectionTokensForSession: (sessionId) =>
        this.contextService.clearReservedInjectionTokensForSession(sessionId),
      fileChanges: this.fileChanges,
      verification: this.verification,
      parallel: this.parallel,
      parallelResults: this.parallelResults,
      costTracker: this.costTracker,
      memory: this.memory,
      turnReplay: this.turnReplay,
      events: this.events,
      ledger: this.ledger,
    });
    this.toolGateService = new ToolGateService({
      securityConfig: this.config.security,
      costTracker: this.costTracker,
      sessionState: this.sessionState,
      alwaysAllowedTools: ALWAYS_ALLOWED_TOOLS,
      getActiveSkill: (sessionId) => this.skillLifecycleService.getActiveSkill(sessionId),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      recordEvent: (input) => this.recordEvent(input),
      checkContextCompactionGate: (sessionId, toolName, usage) =>
        this.contextService.checkContextCompactionGate(sessionId, toolName, usage),
      observeContextUsage: (sessionId, usage) =>
        this.contextService.observeContextUsage(sessionId, usage),
      markToolCall: (sessionId, toolName) =>
        this.fileChangeService.markToolCall(sessionId, toolName),
      trackToolCallStart: (input) => this.fileChangeService.trackToolCallStart(input),
      recordToolResult: (input) => this.ledgerService.recordToolResult(input),
      trackToolCallEnd: (input) => this.fileChangeService.trackToolCallEnd(input),
    });
  }

  refreshSkills(): void {
    this.skills.load();
    this.skills.writeIndex();
  }

  listSkills(): SkillDocument[] {
    return this.skills.list();
  }

  getSkill(name: string): SkillDocument | undefined {
    return this.skills.get(name);
  }

  selectSkills(message: string): SkillSelection[] {
    const input = this.config.security.sanitizeContext ? sanitizeContextText(message) : message;
    return selectTopKSkills(input, this.skills.buildIndex(), this.config.skills.selector.k);
  }

  onTurnStart(sessionId: string, turnIndex: number): void {
    this.sessionLifecycleService.onTurnStart(sessionId, turnIndex);
  }

  observeContextUsage(sessionId: string, usage: ContextBudgetUsage | undefined): void {
    this.contextService.observeContextUsage(sessionId, usage);
  }

  getContextUsage(sessionId: string): ContextBudgetUsage | undefined {
    return this.contextService.getContextUsage(sessionId);
  }

  getContextUsageRatio(usage: ContextBudgetUsage | undefined): number | null {
    return this.contextService.getContextUsageRatio(usage);
  }

  getContextHardLimitRatio(): number {
    return this.contextService.getContextHardLimitRatio();
  }

  getContextCompactionThresholdRatio(): number {
    return this.contextService.getContextCompactionThresholdRatio();
  }

  getContextPressureStatus(sessionId: string, usage?: ContextBudgetUsage): ContextPressureStatus {
    return this.contextService.getContextPressureStatus(sessionId, usage);
  }

  getContextPressureLevel(sessionId: string, usage?: ContextBudgetUsage): ContextPressureLevel {
    return this.contextService.getContextPressureLevel(sessionId, usage);
  }

  getContextCompactionGateStatus(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextCompactionGateStatus {
    return this.contextService.getContextCompactionGateStatus(sessionId, usage);
  }

  checkContextCompactionGate(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): { allowed: boolean; reason?: string } {
    return this.contextService.checkContextCompactionGate(sessionId, toolName, usage);
  }

  buildContextInjection(
    sessionId: string,
    prompt: string,
    usage?: ContextBudgetUsage,
    injectionScopeId?: string,
  ): {
    text: string;
    accepted: boolean;
    originalTokens: number;
    finalTokens: number;
    truncated: boolean;
  } {
    return this.contextService.buildContextInjection(sessionId, prompt, usage, injectionScopeId);
  }

  planSupplementalContextInjection(
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
  } {
    return this.contextService.planSupplementalContextInjection(
      sessionId,
      inputText,
      usage,
      injectionScopeId,
    );
  }

  commitSupplementalContextInjection(
    sessionId: string,
    finalTokens: number,
    injectionScopeId?: string,
  ): void {
    this.contextService.commitSupplementalContextInjection(
      sessionId,
      finalTokens,
      injectionScopeId,
    );
  }

  shouldRequestCompaction(sessionId: string, usage: ContextBudgetUsage | undefined): boolean {
    return this.contextService.shouldRequestCompaction(sessionId, usage);
  }

  getCompactionInstructions(): string {
    return this.contextService.getCompactionInstructions();
  }

  markContextCompacted(
    sessionId: string,
    input: {
      fromTokens?: number | null;
      toTokens?: number | null;
      summary?: string;
      entryId?: string;
    },
  ): void {
    this.contextService.markContextCompacted(sessionId, input);
  }

  activateSkill(
    sessionId: string,
    name: string,
  ): { ok: boolean; reason?: string; skill?: SkillDocument } {
    return this.skillLifecycleService.activateSkill(sessionId, name);
  }

  getActiveSkill(sessionId: string): SkillDocument | undefined {
    return this.skillLifecycleService.getActiveSkill(sessionId);
  }

  validateSkillOutputs(
    sessionId: string,
    outputs: Record<string, unknown>,
  ): { ok: boolean; missing: string[] } {
    return this.skillLifecycleService.validateSkillOutputs(sessionId, outputs);
  }

  validateComposePlan(plan: {
    steps: Array<{ skill: string; consumes?: string[]; produces?: string[] }>;
  }): { valid: boolean; errors: string[]; warnings: string[] } {
    return this.skillLifecycleService.validateComposePlan(plan);
  }

  completeSkill(
    sessionId: string,
    outputs: Record<string, unknown>,
  ): { ok: boolean; missing: string[] } {
    return this.skillLifecycleService.completeSkill(sessionId, outputs);
  }

  getSkillOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined {
    return this.skillLifecycleService.getSkillOutputs(sessionId, skillName);
  }

  getAvailableConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown> {
    return this.skillLifecycleService.getAvailableConsumedOutputs(sessionId, targetSkillName);
  }

  checkToolAccess(sessionId: string, toolName: string): { allowed: boolean; reason?: string } {
    return this.toolGateService.checkToolAccess(sessionId, toolName);
  }

  startToolCall(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
    usage?: ContextBudgetUsage;
    recordLifecycleEvent?: boolean;
  }): { allowed: boolean; reason?: string } {
    return this.toolGateService.startToolCall(input);
  }

  finishToolCall(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    outputText: string;
    success: boolean;
    verdict?: "pass" | "fail" | "inconclusive";
    metadata?: Record<string, unknown>;
  }): string {
    return this.toolGateService.finishToolCall(input);
  }

  acquireParallelSlot(sessionId: string, runId: string): ParallelAcquireResult {
    return this.parallelService.acquireParallelSlot(sessionId, runId);
  }

  releaseParallelSlot(sessionId: string, runId: string): void {
    this.parallelService.releaseParallelSlot(sessionId, runId);
  }

  markToolCall(sessionId: string, toolName: string): void {
    this.fileChangeService.markToolCall(sessionId, toolName);
  }

  trackToolCallStart(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }): void {
    this.fileChangeService.trackToolCallStart(input);
  }

  trackToolCallEnd(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    success: boolean;
  }): void {
    this.fileChangeService.trackToolCallEnd(input);
  }

  rollbackLastPatchSet(sessionId: string): RollbackResult {
    return this.fileChangeService.rollbackLastPatchSet(sessionId);
  }

  resolveUndoSessionId(preferredSessionId?: string): string | undefined {
    return this.fileChangeService.resolveUndoSessionId(preferredSessionId);
  }

  recordToolResult(input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    outputText: string;
    success: boolean;
    verdict?: "pass" | "fail" | "inconclusive";
    metadata?: Record<string, unknown>;
  }): string {
    return this.ledgerService.recordToolResult(input);
  }

  getLedgerDigest(sessionId: string): string {
    return this.ledgerService.getLedgerDigest(sessionId);
  }

  queryLedger(sessionId: string, query: EvidenceQuery): string {
    return this.ledgerService.queryLedger(sessionId, query);
  }

  setTaskSpec(sessionId: string, spec: TaskSpec): void {
    this.taskService.setTaskSpec(sessionId, spec);
  }

  addTaskItem(
    sessionId: string,
    input: { id?: string; text: string; status?: TaskItemStatus },
  ): { ok: boolean; itemId?: string; error?: string } {
    return this.taskService.addTaskItem(sessionId, input);
  }

  updateTaskItem(
    sessionId: string,
    input: { id: string; text?: string; status?: TaskItemStatus },
  ): { ok: boolean; error?: string } {
    return this.taskService.updateTaskItem(sessionId, input);
  }

  recordTaskBlocker(
    sessionId: string,
    input: {
      id?: string;
      message: string;
      source?: string;
      truthFactId?: string;
    },
  ): { ok: boolean; blockerId?: string; error?: string } {
    return this.taskService.recordTaskBlocker(sessionId, input);
  }

  resolveTaskBlocker(sessionId: string, blockerId: string): { ok: boolean; error?: string } {
    return this.taskService.resolveTaskBlocker(sessionId, blockerId);
  }

  getTapeStatus(sessionId: string): TapeStatusState {
    return this.tapeService.getTapeStatus(sessionId);
  }

  recordTapeHandoff(
    sessionId: string,
    input: { name: string; summary?: string; nextSteps?: string },
  ): {
    ok: boolean;
    eventId?: string;
    createdAt?: number;
    error?: string;
    tapeStatus?: TapeStatusState;
  } {
    return this.tapeService.recordTapeHandoff(sessionId, input);
  }

  searchTape(
    sessionId: string,
    input: { query: string; scope?: TapeSearchScope; limit?: number },
  ): TapeSearchResult {
    return this.tapeService.searchTape(sessionId, input);
  }

  getTaskState(sessionId: string): TaskState {
    return this.turnReplay.getTaskState(sessionId);
  }

  getTruthState(sessionId: string): TruthState {
    return this.turnReplay.getTruthState(sessionId);
  }

  getWorkingMemory(sessionId: string): WorkingMemorySnapshot | undefined {
    return this.memoryAccessService.getWorkingMemory(sessionId);
  }

  searchMemory(sessionId: string, input: { query: string; limit?: number }): MemorySearchResult {
    return this.memoryAccessService.searchMemory(sessionId, input);
  }

  dismissMemoryInsight(
    sessionId: string,
    insightId: string,
  ): { ok: boolean; error?: "missing_id" | "not_found" } {
    return this.memoryAccessService.dismissMemoryInsight(sessionId, insightId);
  }

  reviewMemoryEvolvesEdge(
    sessionId: string,
    input: { edgeId: string; decision: "accept" | "reject" },
  ): { ok: boolean; error?: "missing_id" | "not_found" | "already_set" } {
    return this.memoryAccessService.reviewMemoryEvolvesEdge(sessionId, input);
  }

  upsertTruthFact(
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
  ): { ok: boolean; fact?: TruthFact; error?: string } {
    return this.truthService.upsertTruthFact(sessionId, input);
  }

  resolveTruthFact(sessionId: string, truthFactId: string): { ok: boolean; error?: string } {
    return this.truthService.resolveTruthFact(sessionId, truthFactId);
  }

  async createScheduleIntent(
    sessionId: string,
    input: ScheduleIntentCreateInput,
  ): Promise<ScheduleIntentCreateResult> {
    return this.scheduleIntentService.createScheduleIntent(sessionId, input);
  }

  async cancelScheduleIntent(
    sessionId: string,
    input: ScheduleIntentCancelInput,
  ): Promise<ScheduleIntentCancelResult> {
    return this.scheduleIntentService.cancelScheduleIntent(sessionId, input);
  }

  async updateScheduleIntent(
    sessionId: string,
    input: ScheduleIntentUpdateInput,
  ): Promise<ScheduleIntentUpdateResult> {
    return this.scheduleIntentService.updateScheduleIntent(sessionId, input);
  }

  async listScheduleIntents(
    query: ScheduleIntentListQuery = {},
  ): Promise<ScheduleIntentProjectionRecord[]> {
    return this.scheduleIntentService.listScheduleIntents(query);
  }

  async getScheduleProjectionSnapshot(): Promise<ScheduleProjectionSnapshot> {
    return this.scheduleIntentService.getScheduleProjectionSnapshot();
  }

  recordEvent(input: RuntimeRecordEventInput): BrewvaEventRecord | undefined {
    return this.eventPipeline.recordEvent(input);
  }

  queryEvents(sessionId: string, query: BrewvaEventQuery = {}): BrewvaEventRecord[] {
    return this.eventPipeline.queryEvents(sessionId, query);
  }

  queryStructuredEvents(sessionId: string, query: BrewvaEventQuery = {}): BrewvaStructuredEvent[] {
    return this.eventPipeline.queryStructuredEvents(sessionId, query);
  }

  listReplaySessions(limit = 20): BrewvaReplaySession[] {
    return this.eventPipeline.listReplaySessions(limit);
  }

  subscribeEvents(listener: (event: BrewvaStructuredEvent) => void): () => void {
    return this.eventPipeline.subscribeEvents(listener);
  }

  toStructuredEvent(event: BrewvaEventRecord): BrewvaStructuredEvent {
    return this.eventPipeline.toStructuredEvent(event);
  }

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
  }): SessionCostSummary {
    return this.costService.recordAssistantUsage(input);
  }
  getCostSummary(sessionId: string): SessionCostSummary {
    return this.costService.getCostSummary(sessionId);
  }

  evaluateCompletion(sessionId: string, level?: VerificationLevel): VerificationReport {
    return this.verification.evaluate(sessionId, level);
  }

  recordWorkerResult(sessionId: string, result: WorkerResult): void {
    this.parallelService.recordWorkerResult(sessionId, result);
  }

  listWorkerResults(sessionId: string): WorkerResult[] {
    return this.parallelService.listWorkerResults(sessionId);
  }

  mergeWorkerResults(sessionId: string): WorkerMergeReport {
    return this.parallelService.mergeWorkerResults(sessionId);
  }

  clearWorkerResults(sessionId: string): void {
    this.parallelService.clearWorkerResults(sessionId);
  }

  clearSessionState(sessionId: string): void {
    this.sessionLifecycleService.clearSessionState(sessionId);
  }

  async verifyCompletion(
    sessionId: string,
    level?: VerificationLevel,
    options: VerifyCompletionOptions = {},
  ): Promise<VerificationReport> {
    return this.verificationService.verifyCompletion(sessionId, level, options);
  }

  sanitizeInput(text: string): string {
    if (!this.config.security.sanitizeContext) {
      return text;
    }
    return sanitizeContextText(text);
  }

  private getCurrentTurn(sessionId: string): number {
    return this.sessionState.getCurrentTurn(sessionId);
  }

  private isContextBudgetEnabled(): boolean {
    return this.config.infrastructure.contextBudget.enabled;
  }
}
