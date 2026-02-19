import type {
  ContextBudgetUsage,
  ContextPressureStatus,
  EvidenceQuery,
  RoasterConfig,
  RollbackResult,
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
} from "@pi-roaster/roaster-runtime";

export interface RoasterToolRuntime {
  readonly config?: Pick<RoasterConfig, "parallel" | "infrastructure">;
  activateSkill(sessionId: string, name: string): { ok: boolean; reason?: string; skill?: SkillDocument };
  validateSkillOutputs(sessionId: string, outputs: Record<string, unknown>): { ok: boolean; missing: string[] };
  completeSkill(sessionId: string, outputs: Record<string, unknown>): { ok: boolean; missing: string[] };
  verifyCompletion(
    sessionId: string,
    level?: VerificationLevel,
    options?: { executeCommands?: boolean; timeoutMs?: number },
  ): Promise<VerificationReport>;
  rollbackLastPatchSet(sessionId: string): RollbackResult;
  queryLedger(sessionId: string, query: EvidenceQuery): string;
  getCostSummary(sessionId: string): SessionCostSummary;
  getAvailableConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown>;
  getCompactionInstructions?(): string;
  getContextUsage(sessionId: string): ContextBudgetUsage | undefined;
  getContextPressureStatus(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextPressureStatus;
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

  setTaskSpec(sessionId: string, spec: TaskSpec): void;
  getTaskState(sessionId: string): TaskState;
  addTaskItem(
    sessionId: string,
    input: { id?: string; text: string; status?: TaskItemStatus },
  ): { ok: boolean; itemId?: string; error?: string };
  updateTaskItem(
    sessionId: string,
    input: { id: string; text?: string; status?: TaskItemStatus },
  ): { ok: boolean; error?: string };
  recordTaskBlocker(
    sessionId: string,
    input: { id?: string; message: string; source?: string; truthFactId?: string },
  ): { ok: boolean; blockerId?: string; error?: string };
  resolveTaskBlocker(sessionId: string, blockerId: string): { ok: boolean; error?: string };
  recordEvent?(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
  }): unknown;
}

export interface RoasterToolOptions {
  runtime: RoasterToolRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}
