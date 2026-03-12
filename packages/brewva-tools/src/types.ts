import type {
  ResourceLeaseCancelResult,
  ResourceLeaseQuery,
  ResourceLeaseRecord,
  ResourceLeaseRequest,
  ResourceLeaseResult,
  ContextBudgetUsage,
  ContextPressureStatus,
  BrewvaEventQuery,
  BrewvaEventRecord,
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
  SkillChainIntent,
  SessionCostSummary,
  SkillDispatchDecision,
  SkillDocument,
  TapeSearchResult,
  TapeSearchScope,
  TapeStatusState,
  TaskItemStatus,
  TaskSpec,
  TaskState,
  VerificationLevel,
  VerificationReport,
  ToolGovernanceDescriptor,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export type BrewvaToolSurface = "base" | "skill" | "operator";

export interface BrewvaToolMetadata {
  surface: BrewvaToolSurface;
  governance: ToolGovernanceDescriptor;
}

export type BrewvaManagedToolDefinition = ToolDefinition & {
  brewva?: BrewvaToolMetadata;
};

export interface BrewvaToolRuntime {
  readonly cwd?: string;
  readonly workspaceRoot?: string;
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
      invalid: Array<{ name: string; reason: string }>;
    };
    complete(
      sessionId: string,
      outputs: Record<string, unknown>,
    ): {
      ok: boolean;
      missing: string[];
      invalid: Array<{ name: string; reason: string }>;
    };
    getConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown>;
    getPendingDispatch?(sessionId: string): SkillDispatchDecision | undefined;
    getCascadeIntent?(sessionId: string): SkillChainIntent | undefined;
    pauseCascade?(sessionId: string, reason?: string): { ok: boolean; reason?: string };
    resumeCascade?(sessionId: string, reason?: string): { ok: boolean; reason?: string };
    cancelCascade?(sessionId: string, reason?: string): { ok: boolean; reason?: string };
    startCascade?(
      sessionId: string,
      input: {
        steps: Array<{
          skill: string;
          consumes?: string[];
          produces?: string[];
          lane?: string;
        }>;
      },
    ): { ok: boolean; reason?: string };
  };
  verification: {
    verify(
      sessionId: string,
      level?: VerificationLevel,
      options?: { executeCommands?: boolean; timeoutMs?: number },
    ): Promise<VerificationReport>;
  };
  tools: {
    acquireParallelSlot?(sessionId: string, runId: string): { accepted: boolean; reason?: string };
    acquireParallelSlotAsync?(
      sessionId: string,
      runId: string,
      options?: { timeoutMs?: number },
    ): Promise<{ accepted: boolean; reason?: string }>;
    releaseParallelSlot?(sessionId: string, runId: string): void;
    requestResourceLease?(sessionId: string, request: ResourceLeaseRequest): ResourceLeaseResult;
    listResourceLeases?(sessionId: string, query?: ResourceLeaseQuery): ResourceLeaseRecord[];
    cancelResourceLease?(
      sessionId: string,
      leaseId: string,
      reason?: string,
    ): ResourceLeaseCancelResult;
    rollbackLastPatchSet(sessionId: string): RollbackResult;
  };
  ledger: {
    query(sessionId: string, query: EvidenceQuery): string;
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
    list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
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
  session?: {
    onClearState?(listener: (sessionId: string) => void): () => void;
  };
  orchestration?: {
    a2a: {
      send(input: {
        fromSessionId: string;
        fromAgentId?: string;
        toAgentId: string;
        message: string;
        correlationId?: string;
        depth?: number;
        hops?: number;
      }): Promise<{
        ok: boolean;
        toAgentId: string;
        responseText?: string;
        error?: string;
        depth?: number;
        hops?: number;
      }>;
      broadcast(input: {
        fromSessionId: string;
        fromAgentId?: string;
        toAgentIds: string[];
        message: string;
        correlationId?: string;
        depth?: number;
        hops?: number;
      }): Promise<{
        ok: boolean;
        error?: string;
        results: Array<{
          toAgentId: string;
          ok: boolean;
          responseText?: string;
          error?: string;
          depth?: number;
          hops?: number;
        }>;
      }>;
      listAgents(input?: { includeDeleted?: boolean }): Promise<
        Array<{
          agentId: string;
          status: "active" | "deleted";
        }>
      >;
    };
  };
}

export interface BrewvaToolOptions {
  runtime: BrewvaToolRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}
