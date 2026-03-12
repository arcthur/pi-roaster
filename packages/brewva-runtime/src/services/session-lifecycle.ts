import type { ContextBudgetManager } from "../context/budget.js";
import type { ContextInjectionCollector } from "../context/injection.js";
import type { SessionCostTracker } from "../cost/tracker.js";
import {
  RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
  RESOURCE_LEASE_EXPIRED_EVENT_TYPE,
  RESOURCE_LEASE_GRANTED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
} from "../events/event-types.js";
import type { BrewvaEventStore } from "../events/store.js";
import type { EvidenceLedger } from "../ledger/evidence-ledger.js";
import type { ParallelBudgetManager } from "../parallel/budget.js";
import type { ParallelResultStore } from "../parallel/results.js";
import type { ProjectionEngine } from "../projection/engine.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type { FileChangeTracker } from "../state/file-change-tracker.js";
import { TAPE_CHECKPOINT_EVENT_TYPE, coerceTapeCheckpointPayload } from "../tape/events.js";
import type { TurnReplayEngine } from "../tape/replay-engine.js";
import type {
  ResourceLeaseRecord,
  BrewvaEventRecord,
  SessionHydrationIssue,
  SessionHydrationState,
  SkillChainIntent,
  SkillDispatchDecision,
  SkillOutputRecord,
  SkillSelectionBreakdownEntry,
  SkillSelectionSignal,
} from "../types.js";
import { SKILL_SELECTION_SIGNALS as SKILL_SELECTION_SIGNALS_LIST } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";
import type { VerificationGate } from "../verification/gate.js";
import {
  coerceVerificationWriteMarkedPayload,
  readVerificationToolResultProjectionPayload,
} from "../verification/projector-payloads.js";
import type { ContextService } from "./context.js";
import { RuntimeSessionStateStore } from "./session-state.js";
const SKILL_SELECTION_SIGNALS = new Set<SkillSelectionSignal>(SKILL_SELECTION_SIGNALS_LIST);

export interface SessionLifecycleServiceOptions {
  sessionState: RuntimeKernelContext["sessionState"];
  contextBudget: RuntimeKernelContext["contextBudget"];
  contextInjection: RuntimeKernelContext["contextInjection"];
  fileChanges: RuntimeKernelContext["fileChanges"];
  verificationGate: RuntimeKernelContext["verificationGate"];
  parallel: RuntimeKernelContext["parallel"];
  parallelResults: RuntimeKernelContext["parallelResults"];
  costTracker: RuntimeKernelContext["costTracker"];
  projectionEngine: RuntimeKernelContext["projectionEngine"];
  turnReplay: RuntimeKernelContext["turnReplay"];
  eventStore: RuntimeKernelContext["eventStore"];
  evidenceLedger: RuntimeKernelContext["evidenceLedger"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  contextService: Pick<ContextService, "clearReservedInjectionTokensForSession">;
}

export class SessionLifecycleService {
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly contextBudget: ContextBudgetManager;
  private readonly contextInjection: ContextInjectionCollector;
  private readonly clearReservedInjectionTokensForSession: (sessionId: string) => void;
  private readonly fileChanges: FileChangeTracker;
  private readonly verification: VerificationGate;
  private readonly parallel: ParallelBudgetManager;
  private readonly parallelResults: ParallelResultStore;
  private readonly costTracker: SessionCostTracker;
  private readonly projectionEngine: ProjectionEngine;
  private readonly turnReplay: TurnReplayEngine;
  private readonly events: BrewvaEventStore;
  private readonly ledger: EvidenceLedger;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;
  private readonly clearStateListeners = new Set<(sessionId: string) => void>();

  constructor(options: SessionLifecycleServiceOptions) {
    this.sessionState = options.sessionState;
    this.contextBudget = options.contextBudget;
    this.contextInjection = options.contextInjection;
    this.clearReservedInjectionTokensForSession = (sessionId) =>
      options.contextService.clearReservedInjectionTokensForSession(sessionId);
    this.fileChanges = options.fileChanges;
    this.verification = options.verificationGate;
    this.parallel = options.parallel;
    this.parallelResults = options.parallelResults;
    this.costTracker = options.costTracker;
    this.projectionEngine = options.projectionEngine;
    this.turnReplay = options.turnReplay;
    this.events = options.eventStore;
    this.ledger = options.evidenceLedger;
    this.recordEvent = (input) => options.recordEvent(input);
  }

  onTurnStart(sessionId: string, turnIndex: number): void {
    this.hydrateSessionStateFromEvents(sessionId);
    const state = this.sessionState.getCell(sessionId);
    const current = state.turn;
    const effectiveTurn = Math.max(current, turnIndex);
    state.turn = effectiveTurn;
    this.contextBudget.beginTurn(sessionId, effectiveTurn);
    this.contextInjection.clearPending(sessionId);
    this.clearReservedInjectionTokensForSession(sessionId);
  }

  ensureHydrated(sessionId: string): void {
    this.hydrateSessionStateFromEvents(sessionId);
  }

  getHydrationState(sessionId: string): SessionHydrationState {
    const hydration = this.sessionState.getExistingCell(sessionId)?.hydration;
    if (!hydration) {
      return {
        status: "cold",
        issues: [],
      };
    }
    return {
      status: hydration.status,
      latestEventId: hydration.latestEventId,
      hydratedAt: hydration.hydratedAt,
      issues: hydration.issues.map((issue) => ({
        eventId: issue.eventId,
        eventType: issue.eventType,
        index: issue.index,
        reason: issue.reason,
      })),
    };
  }

  onClearState(listener: (sessionId: string) => void): () => void {
    this.clearStateListeners.add(listener);
    return () => {
      this.clearStateListeners.delete(listener);
    };
  }

  clearSessionState(sessionId: string): void {
    for (const listener of this.clearStateListeners) {
      try {
        listener(sessionId);
      } catch {
        // Session cleanup listeners must never block runtime state teardown.
      }
    }

    this.sessionState.clearSession(sessionId);

    this.fileChanges.clearSession(sessionId);
    this.verification.stateStore.clear(sessionId);
    this.parallel.clear(sessionId);
    this.parallelResults.clear(sessionId);
    this.contextBudget.clear(sessionId);
    this.costTracker.clear(sessionId);

    this.contextInjection.clearSession(sessionId);
    this.projectionEngine.clearSessionCache(sessionId);

    this.turnReplay.clear(sessionId);

    this.events.clearSessionCache(sessionId);
    this.ledger.clearSessionCache(sessionId);
  }

  private hydrateSessionStateFromEvents(sessionId: string): void {
    const state = this.sessionState.getCell(sessionId);
    if (state.hydration.status !== "cold") return;

    const events = this.events.list(sessionId);
    this.costTracker.clear(sessionId);
    this.verification.stateStore.clear(sessionId);
    if (events.length === 0) {
      state.hydration = {
        status: "ready",
        hydratedAt: Date.now(),
        issues: [],
      };
      return;
    }

    const latestCheckpoint = this.findLatestCheckpoint(events);
    const costReplayStartIndex = latestCheckpoint ? latestCheckpoint.index + 1 : 0;
    const checkpointTurn = latestCheckpoint ? this.normalizeTurn(latestCheckpoint.turn) : null;
    if (latestCheckpoint) {
      this.costTracker.restore(
        sessionId,
        latestCheckpoint.payload.state.cost,
        latestCheckpoint.payload.state.costSkillLastTurnByName,
      );
    }

    this.projectionEngine.rebuildSessionFromTape({
      sessionId,
      events,
      mode: "missing_only",
    });

    let derivedTurn = state.turn;
    let activeSkill = state.activeSkill;
    let toolCalls = state.toolCalls;
    let lastLedgerCompactionTurn = state.lastLedgerCompactionTurn;

    const toolContractWarnings = new Set(state.toolContractWarnings);
    const skillBudgetWarnings = new Set(state.skillBudgetWarnings);
    const skillParallelWarnings = new Set(state.skillParallelWarnings);
    const resourceLeases = new Map<string, ResourceLeaseRecord>();
    const skillOutputs = new Map<string, SkillOutputRecord>();
    let pendingDispatch = state.pendingDispatch;
    let skillChainIntent = state.skillChainIntent;
    const issues: SessionHydrationIssue[] = [];

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
      try {
        if (typeof event.turn === "number" && Number.isFinite(event.turn)) {
          derivedTurn = Math.max(derivedTurn, Math.floor(event.turn));
        }

        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : null;

        const replayCostTail = index >= costReplayStartIndex;
        const replayCheckpointTurnTransient =
          !replayCostTail &&
          checkpointTurn !== null &&
          this.normalizeTurn(event.turn) === checkpointTurn &&
          this.isCheckpointTurnCostTransientEvent(event.type);

        if (replayCostTail || replayCheckpointTurnTransient) {
          this.replayCostStateEvent(sessionId, event, payload, {
            checkpointTurnTransient: replayCheckpointTurnTransient,
          });
        }

        if (event.type === VERIFICATION_WRITE_MARKED_EVENT_TYPE) {
          const writePayload = coerceVerificationWriteMarkedPayload(payload);
          if (writePayload) {
            this.verification.stateStore.markWriteAt(sessionId, event.timestamp);
          }
          continue;
        }

        if (event.type === TOOL_RESULT_RECORDED_EVENT_TYPE) {
          const projection = readVerificationToolResultProjectionPayload(
            payload?.verificationProjection,
          );
          if (projection?.evidence.length) {
            this.verification.stateStore.appendEvidence(sessionId, projection.evidence);
          }
          if (projection?.checkRun) {
            this.verification.stateStore.setCheckRun(
              sessionId,
              projection.checkRun.checkName,
              projection.checkRun.run,
            );
          }
        }

        if (event.type === VERIFICATION_STATE_RESET_EVENT_TYPE) {
          this.verification.stateStore.clear(sessionId);
          continue;
        }

        if (event.type === "skill_activated") {
          const skillName = this.readSkillName(payload);
          if (skillName) {
            activeSkill = skillName;
            toolCalls = 0;
          }
          continue;
        }

        if (event.type === "skill_completed") {
          const skillName = this.readSkillName(payload);
          const outputs = this.readSkillOutputs(payload);
          if (skillName && outputs) {
            skillOutputs.set(skillName, {
              skillName,
              completedAt: this.readNonNegativeNumber(payload?.completedAt) ?? event.timestamp,
              outputs,
            });
          }
          activeSkill = undefined;
          toolCalls = 0;
          continue;
        }

        if (event.type === "tool_call_marked") {
          if (activeSkill) {
            toolCalls += 1;
          }
          continue;
        }

        if (event.type === RESOURCE_LEASE_GRANTED_EVENT_TYPE) {
          const lease = this.readResourceLease(payload);
          if (lease) {
            resourceLeases.set(lease.id, lease);
          }
          continue;
        }

        if (event.type === RESOURCE_LEASE_CANCELLED_EVENT_TYPE) {
          const leaseId =
            payload && typeof payload.leaseId === "string" && payload.leaseId.trim().length > 0
              ? payload.leaseId.trim()
              : null;
          if (leaseId) {
            const existing = resourceLeases.get(leaseId);
            if (existing) {
              existing.status = "cancelled";
              existing.cancelledAt = this.readNonNegativeNumber(payload?.cancelledAt) ?? undefined;
              existing.cancelledReason =
                typeof payload?.cancelledReason === "string"
                  ? payload.cancelledReason
                  : existing.cancelledReason;
            }
          }
          continue;
        }

        if (event.type === RESOURCE_LEASE_EXPIRED_EVENT_TYPE) {
          const leaseId =
            payload && typeof payload.leaseId === "string" && payload.leaseId.trim().length > 0
              ? payload.leaseId.trim()
              : null;
          if (leaseId) {
            const existing = resourceLeases.get(leaseId);
            if (existing) {
              existing.status = "expired";
            }
          }
          continue;
        }

        if (event.type === "tool_contract_warning") {
          const skillName = this.readSkillName(payload);
          const normalizedTool = this.readToolName(payload);
          if (skillName && normalizedTool) {
            toolContractWarnings.add(`${skillName}:${normalizedTool}`);
          }
          continue;
        }

        if (event.type === "skill_budget_warning") {
          const skillName = this.readSkillName(payload);
          const budget = payload?.budget;
          if (!skillName || typeof budget !== "string") continue;
          if (budget === "tokens") {
            skillBudgetWarnings.add(`maxTokens:${skillName}`);
          } else if (budget === "tool_calls") {
            skillBudgetWarnings.add(`maxToolCalls:${skillName}`);
          }
          continue;
        }

        if (event.type === "skill_parallel_warning") {
          const skillName = this.readSkillName(payload);
          if (skillName) {
            skillParallelWarnings.add(`maxParallel:${skillName}`);
          }
          continue;
        }

        if (event.type === "skill_routing_decided") {
          const parsed = this.readPendingDispatch(payload, event.turn);
          if (parsed) {
            pendingDispatch = parsed;
          }
          continue;
        }

        if (event.type.startsWith("skill_cascade_")) {
          const parsedIntent = this.readSkillChainIntent(payload);
          if (parsedIntent) {
            skillChainIntent = parsedIntent;
          }
          continue;
        }

        if (
          event.type === "skill_routing_followed" ||
          event.type === "skill_routing_overridden" ||
          event.type === "skill_routing_ignored"
        ) {
          pendingDispatch = undefined;
          continue;
        }

        if (
          event.type === "ledger_compacted" &&
          typeof event.turn === "number" &&
          Number.isFinite(event.turn)
        ) {
          const normalizedTurn = Math.floor(event.turn);
          if (
            typeof lastLedgerCompactionTurn !== "number" ||
            normalizedTurn > lastLedgerCompactionTurn
          ) {
            lastLedgerCompactionTurn = normalizedTurn;
          }
        }
      } catch (error) {
        issues.push({
          eventId: event.id,
          eventType: event.type,
          index,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    state.turn = derivedTurn;
    state.activeSkill = activeSkill;
    state.toolCalls = activeSkill ? toolCalls : 0;
    state.lastLedgerCompactionTurn =
      typeof lastLedgerCompactionTurn === "number" && Number.isFinite(lastLedgerCompactionTurn)
        ? lastLedgerCompactionTurn
        : undefined;
    state.toolContractWarnings = toolContractWarnings;
    state.skillBudgetWarnings = skillBudgetWarnings;
    state.skillParallelWarnings = skillParallelWarnings;
    state.resourceLeases = resourceLeases;
    state.pendingDispatch =
      pendingDispatch && pendingDispatch.mode !== "none" ? pendingDispatch : undefined;
    state.skillOutputs = skillOutputs;
    state.skillChainIntent = skillChainIntent;
    state.hydration = {
      status: issues.length > 0 ? "degraded" : "ready",
      latestEventId: events[events.length - 1]?.id,
      hydratedAt: Date.now(),
      issues,
    };
  }

  private findLatestCheckpoint(events: BrewvaEventRecord[]): {
    index: number;
    turn: number;
    payload: NonNullable<ReturnType<typeof coerceTapeCheckpointPayload>>;
  } | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event || event.type !== TAPE_CHECKPOINT_EVENT_TYPE) continue;
      const payload = coerceTapeCheckpointPayload(event.payload);
      if (!payload) continue;
      return {
        index,
        turn: this.normalizeTurn(event.turn),
        payload,
      };
    }
    return null;
  }

  private isCheckpointTurnCostTransientEvent(type: string): boolean {
    return type === "tool_call_marked";
  }

  private readSkillName(payload: Record<string, unknown> | null): string | null {
    const skillName =
      payload && typeof payload.skillName === "string"
        ? payload.skillName.trim()
        : payload && typeof payload.skill === "string"
          ? payload.skill.trim()
          : "";
    return skillName ? skillName : null;
  }

  private readToolName(payload: Record<string, unknown> | null): string | null {
    if (!payload || typeof payload.toolName !== "string") return null;
    const normalized = normalizeToolName(payload.toolName);
    return normalized || null;
  }

  private readSelectionBreakdown(value: unknown): SkillSelectionBreakdownEntry[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
      .map((entry) => {
        const signal =
          typeof entry.signal === "string" &&
          SKILL_SELECTION_SIGNALS.has(entry.signal as SkillSelectionSignal)
            ? (entry.signal as SkillSelectionSignal)
            : null;
        const term =
          typeof entry.term === "string" && entry.term.trim().length > 0 ? entry.term.trim() : "";
        const delta = this.readFiniteNumber(entry.delta) ?? 0;
        if (!signal || !term || delta === 0) return null;
        return { signal, term, delta };
      })
      .filter((entry): entry is SkillSelectionBreakdownEntry => entry !== null);
  }

  private readSkillOutputs(
    payload: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    const outputs = payload?.outputs;
    if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
      return null;
    }
    return outputs as Record<string, unknown>;
  }

  private readResourceLease(payload: Record<string, unknown> | null): ResourceLeaseRecord | null {
    if (!payload) return null;
    const id =
      typeof payload.id === "string" && payload.id.trim().length > 0 ? payload.id.trim() : "";
    const sessionId =
      typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : "";
    const reason =
      typeof payload.reason === "string" && payload.reason.trim().length > 0
        ? payload.reason.trim()
        : "";
    const skillName =
      typeof payload.skillName === "string" && payload.skillName.trim().length > 0
        ? payload.skillName.trim()
        : "";
    if (!id || !sessionId || !skillName || !reason) {
      return null;
    }
    const budgetPayload =
      payload.budget && typeof payload.budget === "object" && !Array.isArray(payload.budget)
        ? (payload.budget as Record<string, unknown>)
        : {};
    const status =
      payload.status === "active" || payload.status === "expired" || payload.status === "cancelled"
        ? payload.status
        : "active";
    return {
      id,
      sessionId,
      skillName,
      reason,
      budget: {
        maxToolCalls: this.readNonNegativeNumber(budgetPayload.maxToolCalls) ?? undefined,
        maxTokens: this.readNonNegativeNumber(budgetPayload.maxTokens) ?? undefined,
        maxParallel: this.readNonNegativeNumber(budgetPayload.maxParallel) ?? undefined,
      },
      createdAt: this.readNonNegativeNumber(payload.createdAt) ?? 0,
      expiresAt: this.readNonNegativeNumber(payload.expiresAt) ?? undefined,
      expiresAfterTurn: this.readNonNegativeNumber(payload.expiresAfterTurn) ?? undefined,
      status,
      cancelledAt: this.readNonNegativeNumber(payload.cancelledAt) ?? undefined,
      cancelledReason:
        typeof payload.cancelledReason === "string" && payload.cancelledReason.trim().length > 0
          ? payload.cancelledReason.trim()
          : undefined,
    };
  }

  private readPendingDispatch(
    payload: Record<string, unknown> | null,
    eventTurn: number | undefined,
  ): SkillDispatchDecision | undefined {
    if (!payload) return undefined;

    const modeCandidate = payload.mode;
    const mode = modeCandidate === "suggest" || modeCandidate === "auto" ? modeCandidate : null;
    if (!mode) return undefined;

    const primaryPayload =
      payload.primary && typeof payload.primary === "object" && !Array.isArray(payload.primary)
        ? (payload.primary as Record<string, unknown>)
        : null;
    const primaryName =
      typeof primaryPayload?.name === "string" && primaryPayload.name.trim().length > 0
        ? primaryPayload.name.trim()
        : "";
    const primaryScore = this.readNonNegativeNumber(primaryPayload?.score) ?? 0;
    const primaryReason =
      typeof primaryPayload?.reason === "string" && primaryPayload.reason.trim().length > 0
        ? primaryPayload.reason.trim()
        : "unknown";
    const primaryBreakdown = this.readSelectionBreakdown(primaryPayload?.breakdown);

    const selectedPayload = Array.isArray(payload.selected) ? payload.selected : [];
    const selected = selectedPayload
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
      .map((entry) => {
        const name =
          typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : "";
        if (!name) return null;
        const score = this.readNonNegativeNumber(entry.score) ?? 0;
        const reason =
          typeof entry.reason === "string" && entry.reason.trim().length > 0
            ? entry.reason.trim()
            : "unknown";
        const breakdown = this.readSelectionBreakdown(entry.breakdown);
        return { name, score, reason, breakdown };
      })
      .filter(
        (
          entry,
        ): entry is {
          name: string;
          score: number;
          reason: string;
          breakdown: SkillSelectionBreakdownEntry[];
        } => entry !== null,
      );
    if (selected.length === 0 && primaryName) {
      selected.push({
        name: primaryName,
        score: primaryScore,
        reason: primaryReason,
        breakdown: primaryBreakdown,
      });
    }

    const chain =
      Array.isArray(payload.chain) && payload.chain.length > 0
        ? payload.chain
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : primaryName
          ? [primaryName]
          : [];
    const unresolvedConsumes = Array.isArray(payload.unresolvedConsumes)
      ? payload.unresolvedConsumes
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];
    const confidence = this.readUnitIntervalNumber(payload.confidence) ?? 0.5;
    const reason =
      typeof payload.reason === "string" && payload.reason.trim().length > 0
        ? payload.reason.trim()
        : "unknown";

    const decisionTurnFromPayload = this.readNonNegativeNumber(payload.decisionTurn);
    const normalizedEventTurn =
      typeof eventTurn === "number" && Number.isFinite(eventTurn)
        ? Math.max(0, Math.floor(eventTurn))
        : 0;
    const turn =
      decisionTurnFromPayload !== null
        ? Math.max(0, Math.floor(decisionTurnFromPayload))
        : normalizedEventTurn;
    const routingOutcome =
      payload.routingOutcome === "selected" ||
      payload.routingOutcome === "empty" ||
      payload.routingOutcome === "failed"
        ? payload.routingOutcome
        : undefined;

    return {
      mode,
      primary: primaryName
        ? {
            name: primaryName,
            score: primaryScore,
            reason: primaryReason,
            breakdown: primaryBreakdown,
          }
        : null,
      selected,
      chain,
      unresolvedConsumes,
      confidence,
      reason,
      turn,
      routingOutcome,
    };
  }

  private readSkillChainIntent(
    payload: Record<string, unknown> | null,
  ): SkillChainIntent | undefined {
    if (!payload) return undefined;
    const intentPayload =
      payload.intent && typeof payload.intent === "object" && !Array.isArray(payload.intent)
        ? (payload.intent as Record<string, unknown>)
        : null;
    if (!intentPayload) return undefined;

    const id = typeof intentPayload.id === "string" ? intentPayload.id.trim() : "";
    if (!id) return undefined;
    const source =
      intentPayload.source === "dispatch" || intentPayload.source === "explicit"
        ? intentPayload.source
        : null;
    if (!source) return undefined;
    const sourceTurn = this.readNonNegativeNumber(intentPayload.sourceTurn) ?? 0;
    const cursor = this.readNonNegativeNumber(intentPayload.cursor) ?? 0;
    const status =
      intentPayload.status === "pending" ||
      intentPayload.status === "running" ||
      intentPayload.status === "paused" ||
      intentPayload.status === "completed" ||
      intentPayload.status === "failed" ||
      intentPayload.status === "cancelled"
        ? intentPayload.status
        : "pending";
    const stepsPayload = Array.isArray(intentPayload.steps) ? intentPayload.steps : [];
    const steps: SkillChainIntent["steps"] = [];
    for (const [index, entry] of stepsPayload.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const skill = typeof record.skill === "string" ? record.skill.trim() : "";
      if (!skill) continue;
      const stepId =
        typeof record.id === "string" && record.id.trim().length > 0
          ? record.id.trim()
          : `step-${index + 1}:${skill}`;
      const consumes = Array.isArray(record.consumes)
        ? record.consumes
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : [];
      const produces = Array.isArray(record.produces)
        ? record.produces
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : [];
      const lane =
        typeof record.lane === "string" && record.lane.trim().length > 0
          ? record.lane.trim()
          : undefined;
      const nextStep: SkillChainIntent["steps"][number] = {
        id: stepId,
        skill,
        consumes,
        produces,
      };
      if (lane) {
        nextStep.lane = lane;
      }
      steps.push(nextStep);
    }
    if (steps.length === 0) return undefined;
    const sourceEventId =
      typeof intentPayload.sourceEventId === "string" &&
      intentPayload.sourceEventId.trim().length > 0
        ? intentPayload.sourceEventId.trim()
        : undefined;
    const unresolvedConsumes = Array.isArray(intentPayload.unresolvedConsumes)
      ? intentPayload.unresolvedConsumes
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
    const createdAt = this.readNonNegativeNumber(intentPayload.createdAt) ?? Date.now();
    const updatedAt = this.readNonNegativeNumber(intentPayload.updatedAt) ?? createdAt;
    const retries = this.readNonNegativeNumber(intentPayload.retries) ?? 0;
    const lastError =
      typeof intentPayload.lastError === "string" && intentPayload.lastError.trim().length > 0
        ? intentPayload.lastError.trim()
        : undefined;

    const maxCursor =
      status === "completed" || status === "failed" || status === "cancelled"
        ? steps.length
        : Math.max(0, steps.length - 1);

    return {
      id,
      source,
      sourceEventId,
      sourceTurn,
      steps,
      cursor: Math.min(cursor, maxCursor),
      status,
      unresolvedConsumes,
      createdAt,
      updatedAt,
      retries,
      lastError,
    };
  }

  private replayCostStateEvent(
    sessionId: string,
    event: BrewvaEventRecord,
    payload: Record<string, unknown> | null,
    options?: {
      checkpointTurnTransient?: boolean;
    },
  ): void {
    const turn = this.normalizeTurn(event.turn);
    const checkpointTurnTransient = options?.checkpointTurnTransient === true;

    if (event.type === "tool_call_marked") {
      const toolName =
        payload && typeof payload.toolName === "string" ? payload.toolName.trim() : "";
      if (!toolName) return;
      if (checkpointTurnTransient) {
        this.costTracker.restoreToolCallForTurn(sessionId, {
          toolName,
          turn,
        });
      } else {
        this.costTracker.recordToolCall(sessionId, {
          toolName,
          turn,
        });
      }
      return;
    }

    if (event.type !== "cost_update" || !payload) return;
    this.costTracker.applyCostUpdateEvent(sessionId, payload, turn, event.timestamp);
  }

  private normalizeTurn(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
  }

  private readNonNegativeNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.max(0, value);
  }

  private readFiniteNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return value;
  }

  private readUnitIntervalNumber(value: unknown): number | null {
    const normalized = this.readNonNegativeNumber(value);
    if (normalized === null) return null;
    return Math.max(0, Math.min(1, normalized));
  }
}
