import type {
  ContextBudgetUsage,
  ContextPressureStatus,
  EvidenceQuery,
  BrewvaConfig,
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
  SessionCostSummary,
  SkillDocument,
  TapeSearchResult,
  TapeSearchScope,
  TapeStatusState,
  TaskItemStatus,
  TaskSpec,
  TaskState,
  VerificationLevel,
  VerificationReport,
} from "@brewva/brewva-runtime";

export interface BrewvaToolRuntime {
  readonly config?: Pick<BrewvaConfig, "parallel" | "infrastructure" | "schedule" | "security">;
  skills: {
    activate(
      sessionId: string,
      name: string,
    ): { ok: boolean; reason?: string; skill?: SkillDocument };
    validateOutputs(
      sessionId: string,
      outputs: Record<string, unknown>,
    ): {
      ok: boolean;
      missing: string[];
    };
    complete(
      sessionId: string,
      outputs: Record<string, unknown>,
    ): { ok: boolean; missing: string[] };
    getConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown>;
  };
  verification: {
    verify(
      sessionId: string,
      level?: VerificationLevel,
      options?: { executeCommands?: boolean; timeoutMs?: number },
    ): Promise<VerificationReport>;
  };
  tools: {
    rollbackLastPatchSet(sessionId: string): RollbackResult;
  };
  truth: {
    queryLedger(sessionId: string, query: EvidenceQuery): string;
  };
  cost: {
    getSummary(sessionId: string): SessionCostSummary;
  };
  context: {
    getCompactionInstructions?(): string;
    getUsage(sessionId: string): ContextBudgetUsage | undefined;
    getPressureStatus(sessionId: string, usage?: ContextBudgetUsage): ContextPressureStatus;
  };
  events: {
    getTapeStatus(sessionId: string): TapeStatusState;
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
    record?(input: {
      sessionId: string;
      type: string;
      turn?: number;
      payload?: Record<string, unknown>;
      timestamp?: number;
    }): unknown;
  };
  task: {
    setSpec(sessionId: string, spec: TaskSpec): void;
    getState(sessionId: string): TaskState;
    addItem(
      sessionId: string,
      input: { id?: string; text: string; status?: TaskItemStatus },
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
  };
  memory: {
    dismissInsight(
      sessionId: string,
      insightId: string,
    ): { ok: boolean; error?: "missing_id" | "not_found" };
    reviewEvolvesEdge(
      sessionId: string,
      input: { edgeId: string; decision: "accept" | "reject" },
    ): { ok: boolean; error?: "missing_id" | "not_found" | "already_set" };
  };
  schedule: {
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
}

export interface BrewvaToolOptions {
  runtime: BrewvaToolRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}
