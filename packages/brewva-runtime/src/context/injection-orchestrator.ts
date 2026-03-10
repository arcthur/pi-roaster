import type {
  ContextBudgetUsage,
  ContextInjectionDecision,
  ProposalRecord,
  SkillChainIntent,
  SkillDispatchDecision,
  SkillSelection,
  TaskState,
  TruthState,
} from "../types.js";
import { sha256 } from "../utils/hash.js";
import type {
  ContextInjectionEntry,
  ContextInjectionPlanResult,
  RegisterContextInjectionInput,
} from "./injection.js";
import { CONTEXT_SOURCES } from "./sources.js";
import { buildRecentToolFailuresBlock, type ToolFailureEntry } from "./tool-failures.js";
import {
  buildRecentToolOutputDistillationBlock,
  type ToolOutputDistillationEntry,
} from "./tool-output-distilled.js";
import { buildTruthFactsBlock } from "./truth-facts.js";
import { buildTruthLedgerBlock } from "./truth.js";

const MIN_SKILL_CANDIDATE_INJECTION_CONFIDENCE = 0.55;

export interface BuildContextInjectionInput {
  sessionId: string;
  prompt: string;
  usage?: ContextBudgetUsage;
  injectionScopeId?: string;
}

export interface BuildContextInjectionResult {
  text: string;
  entries: ContextInjectionEntry[];
  accepted: boolean;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
}

export interface ContextInjectionOrchestratorDeps {
  cwd: string;
  maxInjectionTokens: number;
  isContextBudgetEnabled(): boolean;
  getToolFailureInjectionConfig(): {
    enabled: boolean;
    maxEntries: number;
    maxOutputChars: number;
  };
  getToolOutputDistillationInjectionConfig(): {
    enabled: boolean;
    maxEntries: number;
    maxOutputChars: number;
  };
  sanitizeInput(text: string): string;
  getTruthState(sessionId: string): TruthState;
  maybeAlignTaskStatus(input: {
    sessionId: string;
    promptText: string;
    truthState: TruthState;
    usage?: ContextBudgetUsage;
  }): void;
  getRecentToolFailures(sessionId: string): ToolFailureEntry[];
  getRecentToolOutputDistillations(sessionId: string): ToolOutputDistillationEntry[];
  getTaskState(sessionId: string): TaskState;
  buildTaskStateBlock(state: TaskState): string;
  getLatestSkillSelectionProposal(sessionId: string): ProposalRecord<"skill_selection"> | undefined;
  getAcceptedContextPackets(
    sessionId: string,
    injectionScopeId?: string,
  ): ProposalRecord<"context_packet">[];
  getPendingSkillDispatch(sessionId: string): SkillDispatchDecision | undefined;
  buildSkillCandidateBlock(selected: SkillSelection[]): string;
  buildSkillDispatchGateBlock(decision: SkillDispatchDecision): string;
  getActiveSkillName(sessionId: string): string | null;
  getSkillCascadeIntent(sessionId: string): SkillChainIntent | undefined;
  buildSkillCascadeGateBlock(intent: SkillChainIntent): string;
  registerLateContextInjection(
    sessionId: string,
    promptText: string,
    usage?: ContextBudgetUsage,
  ): void;
  registerContextInjection(sessionId: string, input: RegisterContextInjectionInput): void;
  recordEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
  }): void;
  planContextInjection(sessionId: string, totalTokenBudget: number): ContextInjectionPlanResult;
  commitContextInjection(sessionId: string, consumedKeys: string[]): void;
  planBudgetInjection(
    sessionId: string,
    inputText: string,
    usage?: ContextBudgetUsage,
  ): ContextInjectionDecision;
  buildInjectionScopeKey(sessionId: string, injectionScopeId?: string): string;
  setReservedTokens(scopeKey: string, tokens: number): void;
  getLastInjectedFingerprint(scopeKey: string): string | undefined;
  setLastInjectedFingerprint(scopeKey: string, fingerprint: string): void;
  getCurrentTurn(sessionId: string): number;
}

export function buildContextInjection(
  deps: ContextInjectionOrchestratorDeps,
  input: BuildContextInjectionInput,
): BuildContextInjectionResult {
  const promptText = deps.sanitizeInput(input.prompt);
  const truthLedgerBlock = buildTruthLedgerBlock({ cwd: deps.cwd });
  const truthState = deps.getTruthState(input.sessionId);
  const truthFactsBlock = truthState.facts.some((fact) => fact.status === "active")
    ? buildTruthFactsBlock({ state: truthState })
    : "";

  if (truthLedgerBlock) {
    deps.registerContextInjection(input.sessionId, {
      source: CONTEXT_SOURCES.truthStatic,
      id: "truth-static",
      oncePerSession: true,
      content: truthLedgerBlock,
    });
  }
  if (truthFactsBlock) {
    deps.registerContextInjection(input.sessionId, {
      source: CONTEXT_SOURCES.truthFacts,
      id: "truth-facts",
      content: truthFactsBlock,
    });
  }

  deps.maybeAlignTaskStatus({
    sessionId: input.sessionId,
    promptText,
    truthState,
    usage: input.usage,
  });
  const latestSkillSelection = deps.getLatestSkillSelectionProposal(input.sessionId);
  const selectedSkills = latestSkillSelection?.proposal.payload.selected ?? [];
  const selectionConfidence =
    latestSkillSelection?.proposal.confidence ??
    latestSkillSelection?.proposal.payload.confidence ??
    0;
  if (
    selectedSkills.length > 0 &&
    selectionConfidence >= MIN_SKILL_CANDIDATE_INJECTION_CONFIDENCE
  ) {
    deps.registerContextInjection(input.sessionId, {
      source: CONTEXT_SOURCES.skillCandidates,
      id: "top-k-skills",
      content: deps.buildSkillCandidateBlock(selectedSkills),
    });
  }
  const dispatchDecision = deps.getPendingSkillDispatch(input.sessionId);
  if (dispatchDecision && (dispatchDecision.mode === "gate" || dispatchDecision.mode === "auto")) {
    deps.registerContextInjection(input.sessionId, {
      source: CONTEXT_SOURCES.skillDispatchGate,
      id: "skill-dispatch-gate",
      content: deps.buildSkillDispatchGateBlock(dispatchDecision),
    });
  }

  const activeSkillName = deps.getActiveSkillName(input.sessionId);
  if (!activeSkillName) {
    const intent = deps.getSkillCascadeIntent(input.sessionId);
    if (intent && (intent.status === "paused" || intent.status === "pending")) {
      deps.registerContextInjection(input.sessionId, {
        source: CONTEXT_SOURCES.skillCascadeGate,
        id: "skill-cascade-gate",
        content: deps.buildSkillCascadeGateBlock(intent),
      });
    }
  }
  for (const packet of deps.getAcceptedContextPackets(input.sessionId, input.injectionScopeId)) {
    deps.registerContextInjection(input.sessionId, {
      source: CONTEXT_SOURCES.contextPackets,
      id:
        typeof packet.proposal.payload.packetKey === "string" &&
        packet.proposal.payload.packetKey.trim().length > 0
          ? `context-packet:${packet.proposal.issuer}:${packet.proposal.payload.scopeId ?? "global"}:${packet.proposal.payload.packetKey.trim()}`
          : `context-packet:${packet.proposal.id}`,
      content: `[ContextPacket:${packet.proposal.payload.label}]\n${packet.proposal.payload.content}`,
    });
  }

  const toolFailureConfig = deps.getToolFailureInjectionConfig();
  if (toolFailureConfig.enabled) {
    const recentFailures = deps.getRecentToolFailures(input.sessionId);
    const failureBlock = buildRecentToolFailuresBlock(recentFailures, {
      maxEntries: toolFailureConfig.maxEntries,
      maxOutputChars: toolFailureConfig.maxOutputChars,
    });
    if (failureBlock) {
      deps.registerContextInjection(input.sessionId, {
        source: CONTEXT_SOURCES.toolFailures,
        id: "recent-failures",
        content: failureBlock,
      });
    }
  }

  const toolOutputDistillationConfig = deps.getToolOutputDistillationInjectionConfig();
  if (toolOutputDistillationConfig.enabled) {
    const distilledOutputs = deps.getRecentToolOutputDistillations(input.sessionId);
    const distilledBlock = buildRecentToolOutputDistillationBlock(distilledOutputs, {
      maxEntries: toolOutputDistillationConfig.maxEntries,
      maxSummaryChars: toolOutputDistillationConfig.maxOutputChars,
    });
    if (distilledBlock) {
      deps.registerContextInjection(input.sessionId, {
        source: CONTEXT_SOURCES.toolOutputsDistilled,
        id: "recent-tool-output-distilled",
        content: distilledBlock,
      });
    }
  }

  const taskState = deps.getTaskState(input.sessionId);
  if (
    taskState.spec ||
    taskState.status ||
    taskState.items.length > 0 ||
    taskState.blockers.length > 0
  ) {
    const taskBlock = deps.buildTaskStateBlock(taskState);
    if (taskBlock) {
      deps.registerContextInjection(input.sessionId, {
        source: CONTEXT_SOURCES.taskState,
        id: "task-state",
        content: taskBlock,
      });
    }
  }

  deps.registerLateContextInjection(input.sessionId, promptText, input.usage);

  const merged = deps.planContextInjection(
    input.sessionId,
    deps.isContextBudgetEnabled() ? deps.maxInjectionTokens : Number.MAX_SAFE_INTEGER,
  );

  const decision = deps.planBudgetInjection(input.sessionId, merged.text, input.usage);
  const wasTruncated = decision.truncated || merged.truncated;
  if (decision.accepted) {
    const fingerprint = sha256(decision.finalText);
    const scopeKey = deps.buildInjectionScopeKey(input.sessionId, input.injectionScopeId);
    const previous = deps.getLastInjectedFingerprint(scopeKey);
    if (previous === fingerprint) {
      deps.setReservedTokens(scopeKey, 0);
      deps.commitContextInjection(input.sessionId, merged.consumedKeys);
      deps.recordEvent({
        sessionId: input.sessionId,
        type: "context_injection_dropped",
        payload: {
          reason: "duplicate_content",
          originalTokens: decision.originalTokens,
        },
      });
      return {
        text: "",
        entries: merged.entries,
        accepted: false,
        originalTokens: decision.originalTokens,
        finalTokens: 0,
        truncated: false,
      };
    }

    deps.commitContextInjection(input.sessionId, merged.consumedKeys);
    deps.setReservedTokens(scopeKey, deps.isContextBudgetEnabled() ? decision.finalTokens : 0);
    deps.setLastInjectedFingerprint(scopeKey, fingerprint);
    deps.recordEvent({
      sessionId: input.sessionId,
      type: "context_injected",
      payload: {
        originalTokens: decision.originalTokens,
        finalTokens: decision.finalTokens,
        truncated: wasTruncated,
        usagePercent: input.usage?.percent ?? null,
        sourceCount: merged.entries.length,
        sourceTokens: merged.estimatedTokens,
        degradationApplied: merged.planTelemetry.degradationApplied,
      },
    });
    return {
      text: decision.finalText,
      entries: merged.entries,
      accepted: true,
      originalTokens: decision.originalTokens,
      finalTokens: decision.finalTokens,
      truncated: wasTruncated,
    };
  }

  const rejectedScopeKey = deps.buildInjectionScopeKey(input.sessionId, input.injectionScopeId);
  deps.setReservedTokens(rejectedScopeKey, 0);
  const droppedReason = decision.droppedReason ?? "unknown";
  deps.recordEvent({
    sessionId: input.sessionId,
    type: "context_injection_dropped",
    payload: {
      reason: droppedReason,
      originalTokens: decision.originalTokens,
      degradationApplied: merged.planTelemetry.degradationApplied,
    },
  });
  return {
    text: "",
    entries: merged.entries,
    accepted: false,
    originalTokens: decision.originalTokens,
    finalTokens: 0,
    truncated: false,
  };
}
