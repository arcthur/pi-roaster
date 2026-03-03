import type { ContextBudgetManager } from "../context/budget.js";
import type { ContextInjectionCollector } from "../context/injection.js";
import type { SessionCostTracker } from "../cost/tracker.js";
import type { BrewvaEventStore } from "../events/store.js";
import type { EvidenceLedger } from "../ledger/evidence-ledger.js";
import type { MemoryEngine } from "../memory/engine.js";
import type { ParallelBudgetManager } from "../parallel/budget.js";
import type { ParallelResultStore } from "../parallel/results.js";
import type { FileChangeTracker } from "../state/file-change-tracker.js";
import { TAPE_CHECKPOINT_EVENT_TYPE, coerceTapeCheckpointPayload } from "../tape/events.js";
import type { TurnReplayEngine } from "../tape/replay-engine.js";
import type {
  BrewvaEventRecord,
  SkillDispatchDecision,
  SkillOutputRecord,
  SkillSelectionBreakdownEntry,
  SkillSelectionSignal,
} from "../types.js";
import { SKILL_SELECTION_SIGNALS as SKILL_SELECTION_SIGNALS_LIST } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";
import type { VerificationGate } from "../verification/gate.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

const SKILL_SELECTION_SIGNALS = new Set<SkillSelectionSignal>(SKILL_SELECTION_SIGNALS_LIST);

export interface SessionLifecycleServiceOptions {
  sessionState: RuntimeSessionStateStore;
  contextBudget: ContextBudgetManager;
  contextInjection: ContextInjectionCollector;
  clearReservedInjectionTokensForSession: RuntimeCallback<[sessionId: string]>;
  fileChanges: FileChangeTracker;
  verification: VerificationGate;
  parallel: ParallelBudgetManager;
  parallelResults: ParallelResultStore;
  costTracker: SessionCostTracker;
  memory: MemoryEngine;
  turnReplay: TurnReplayEngine;
  events: BrewvaEventStore;
  ledger: EvidenceLedger;
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
  private readonly memory: MemoryEngine;
  private readonly turnReplay: TurnReplayEngine;
  private readonly events: BrewvaEventStore;
  private readonly ledger: EvidenceLedger;
  private readonly hydratedSessions = new Set<string>();

  constructor(options: SessionLifecycleServiceOptions) {
    this.sessionState = options.sessionState;
    this.contextBudget = options.contextBudget;
    this.contextInjection = options.contextInjection;
    this.clearReservedInjectionTokensForSession = options.clearReservedInjectionTokensForSession;
    this.fileChanges = options.fileChanges;
    this.verification = options.verification;
    this.parallel = options.parallel;
    this.parallelResults = options.parallelResults;
    this.costTracker = options.costTracker;
    this.memory = options.memory;
    this.turnReplay = options.turnReplay;
    this.events = options.events;
    this.ledger = options.ledger;
  }

  onTurnStart(sessionId: string, turnIndex: number): void {
    this.hydrateSessionStateFromEvents(sessionId);
    const current = this.sessionState.turnsBySession.get(sessionId) ?? 0;
    const effectiveTurn = Math.max(current, turnIndex);
    this.sessionState.turnsBySession.set(sessionId, effectiveTurn);
    this.sessionState.skillDispatchGateWarningsBySession.delete(sessionId);
    this.contextBudget.beginTurn(sessionId, effectiveTurn);
    this.contextInjection.clearPending(sessionId);
    this.clearReservedInjectionTokensForSession(sessionId);
  }

  ensureHydrated(sessionId: string): void {
    this.hydrateSessionStateFromEvents(sessionId);
  }

  clearSessionState(sessionId: string): void {
    this.hydratedSessions.delete(sessionId);
    this.sessionState.clearSession(sessionId);

    this.fileChanges.clearSession(sessionId);
    this.verification.stateStore.clear(sessionId);
    this.parallel.clear(sessionId);
    this.parallelResults.clear(sessionId);
    this.contextBudget.clear(sessionId);
    this.costTracker.clear(sessionId);

    this.contextInjection.clearSession(sessionId);
    this.memory.clearSessionCache(sessionId);

    this.turnReplay.clear(sessionId);

    this.events.clearSessionCache(sessionId);
    this.ledger.clearSessionCache(sessionId);
  }

  private hydrateSessionStateFromEvents(sessionId: string): void {
    if (this.hydratedSessions.has(sessionId)) return;
    this.hydratedSessions.add(sessionId);

    const events = this.events.list(sessionId);
    this.costTracker.clear(sessionId);
    if (events.length === 0) return;

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

    this.memory.rebuildSessionFromTape({
      sessionId,
      events,
      mode: "missing_only",
    });

    let derivedTurn = this.sessionState.turnsBySession.get(sessionId) ?? 0;
    let activeSkill = this.sessionState.activeSkillsBySession.get(sessionId);
    let toolCalls = this.sessionState.toolCallsBySession.get(sessionId) ?? 0;
    let lastLedgerCompactionTurn =
      this.sessionState.lastLedgerCompactionTurnBySession.get(sessionId);

    const toolContractWarnings = new Set(
      this.sessionState.toolContractWarningsBySession.get(sessionId) ?? [],
    );
    const skillBudgetWarnings = new Set(
      this.sessionState.skillBudgetWarningsBySession.get(sessionId) ?? [],
    );
    const skillParallelWarnings = new Set(
      this.sessionState.skillParallelWarningsBySession.get(sessionId) ?? [],
    );
    const skillDispatchGateWarnings = new Set(
      this.sessionState.skillDispatchGateWarningsBySession.get(sessionId) ?? [],
    );
    const skillOutputs = new Map<string, SkillOutputRecord>();
    let pendingDispatch = this.sessionState.pendingDispatchBySession.get(sessionId);

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
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

      if (event.type === "skill_dispatch_gate_warning") {
        const warningKey =
          typeof payload?.warningKey === "string" && payload.warningKey.trim().length > 0
            ? payload.warningKey.trim()
            : null;
        if (warningKey) {
          skillDispatchGateWarnings.add(warningKey);
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
    }

    this.sessionState.turnsBySession.set(sessionId, derivedTurn);
    if (activeSkill) {
      this.sessionState.activeSkillsBySession.set(sessionId, activeSkill);
      this.sessionState.toolCallsBySession.set(sessionId, toolCalls);
    } else {
      this.sessionState.activeSkillsBySession.delete(sessionId);
      this.sessionState.toolCallsBySession.delete(sessionId);
    }

    if (typeof lastLedgerCompactionTurn === "number" && Number.isFinite(lastLedgerCompactionTurn)) {
      this.sessionState.lastLedgerCompactionTurnBySession.set(sessionId, lastLedgerCompactionTurn);
    } else {
      this.sessionState.lastLedgerCompactionTurnBySession.delete(sessionId);
    }

    if (toolContractWarnings.size > 0) {
      this.sessionState.toolContractWarningsBySession.set(sessionId, toolContractWarnings);
    }
    if (skillBudgetWarnings.size > 0) {
      this.sessionState.skillBudgetWarningsBySession.set(sessionId, skillBudgetWarnings);
    }
    if (skillParallelWarnings.size > 0) {
      this.sessionState.skillParallelWarningsBySession.set(sessionId, skillParallelWarnings);
    }
    if (skillDispatchGateWarnings.size > 0) {
      this.sessionState.skillDispatchGateWarningsBySession.set(
        sessionId,
        skillDispatchGateWarnings,
      );
    }
    if (pendingDispatch && (pendingDispatch.mode === "gate" || pendingDispatch.mode === "auto")) {
      this.sessionState.pendingDispatchBySession.set(sessionId, pendingDispatch);
    } else {
      this.sessionState.pendingDispatchBySession.delete(sessionId);
    }

    if (skillOutputs.size > 0) {
      this.sessionState.skillOutputsBySession.set(sessionId, skillOutputs);
    } else {
      this.sessionState.skillOutputsBySession.delete(sessionId);
    }
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
    return type === "tool_call_marked" || type === "cognitive_usage_recorded";
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

  private readPendingDispatch(
    payload: Record<string, unknown> | null,
    eventTurn: number | undefined,
  ): SkillDispatchDecision | undefined {
    if (!payload) return undefined;

    const modeCandidate = payload.mode;
    const mode =
      modeCandidate === "suggest" || modeCandidate === "gate" || modeCandidate === "auto"
        ? modeCandidate
        : null;
    if (!mode) return undefined;

    const primaryPayload =
      payload.primary && typeof payload.primary === "object" && !Array.isArray(payload.primary)
        ? (payload.primary as Record<string, unknown>)
        : null;
    const primaryName =
      typeof primaryPayload?.name === "string" && primaryPayload.name.trim().length > 0
        ? primaryPayload.name.trim()
        : "";
    if (!primaryName) return undefined;
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
    if (selected.length === 0) {
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
        : [primaryName];
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

    return {
      mode,
      primary: {
        name: primaryName,
        score: primaryScore,
        reason: primaryReason,
        breakdown: primaryBreakdown,
      },
      selected,
      chain: chain.length > 0 ? chain : [primaryName],
      unresolvedConsumes,
      confidence,
      reason,
      turn,
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

    if (event.type === "cognitive_usage_recorded" && payload) {
      const usagePayload =
        payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)
          ? (payload.usage as Record<string, unknown>)
          : null;
      if (!usagePayload) return;
      const model =
        typeof usagePayload.model === "string" && usagePayload.model.trim().length > 0
          ? usagePayload.model.trim()
          : undefined;
      const inputTokens = this.readNonNegativeNumber(usagePayload.inputTokens);
      const outputTokens = this.readNonNegativeNumber(usagePayload.outputTokens);
      const totalTokens = this.readNonNegativeNumber(usagePayload.totalTokens);
      const costUsd = this.readNonNegativeNumber(usagePayload.costUsd);
      this.costTracker.recordCognitiveUsage(sessionId, {
        turn,
        usage: {
          model,
          inputTokens: inputTokens ?? undefined,
          outputTokens: outputTokens ?? undefined,
          totalTokens: totalTokens ?? undefined,
          costUsd: costUsd ?? undefined,
        },
      });
      return;
    }

    if (event.type !== "cost_update" || !payload) return;

    const model = typeof payload.model === "string" ? payload.model.trim() : "";
    const inputTokens = this.readNonNegativeNumber(payload.inputTokens);
    const outputTokens = this.readNonNegativeNumber(payload.outputTokens);
    const cacheReadTokens = this.readNonNegativeNumber(payload.cacheReadTokens);
    const cacheWriteTokens = this.readNonNegativeNumber(payload.cacheWriteTokens);
    const totalTokens = this.readNonNegativeNumber(payload.totalTokens);
    const costUsd = this.readNonNegativeNumber(payload.costUsd);
    if (
      !model ||
      inputTokens === null ||
      outputTokens === null ||
      cacheReadTokens === null ||
      cacheWriteTokens === null ||
      totalTokens === null ||
      costUsd === null
    ) {
      return;
    }

    const skillName =
      typeof payload.skill === "string" && payload.skill.trim().length > 0
        ? payload.skill.trim()
        : undefined;

    this.costTracker.recordUsage(
      sessionId,
      {
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        costUsd,
      },
      {
        turn,
        skill: skillName,
      },
    );
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
