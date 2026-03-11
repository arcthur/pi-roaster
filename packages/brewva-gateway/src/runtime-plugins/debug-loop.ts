import {
  DELIBERATION_ISSUERS,
  type StatusSummaryField,
  buildEventEvidenceRef,
  buildOperatorNoteEvidenceRef,
  buildWorkspaceArtifactEvidenceRef,
  resolveCognitionArtifactsDir,
  submitStatusSummaryContextPacket,
  writeCognitionArtifact,
} from "@brewva/brewva-deliberation";
import {
  DEBUG_LOOP_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
  DEBUG_LOOP_FAILURE_CASE_PERSISTED_EVENT_TYPE,
  DEBUG_LOOP_HANDOFF_PERSISTED_EVENT_TYPE,
  DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
  DEBUG_LOOP_TRANSITION_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  type BrewvaRuntime,
  type BrewvaStructuredEvent,
  type EvidenceRef,
  type SkillChainIntent,
  type TaskState,
} from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveInjectionScopeId } from "./context-shared.js";
import { persistSessionJsonArtifact, readSessionJsonArtifact } from "./debug-loop-artifacts.js";

const DEBUG_LOOP_STATE_FILE = "debug-loop.json";
const FAILURE_CASE_FILE = "failure-case.json";
const HANDOFF_FILE = "handoff.json";
const DEBUG_LOOP_SUMMARY_FILE = "debug-loop-status.md";
const DEBUG_LOOP_REFERENCE_FILE = "debug-loop-reference.md";
const DEBUG_LOOP_SUMMARY_PACKET_KEY = "debug-loop:status";
const DEBUG_LOOP_SUMMARY_PACKET_TTL_MS = 30 * 60_000;
const MAX_HYPOTHESES = 3;
const MAX_RETRIES = 2;

type DebugLoopStatus =
  | "idle"
  | "forensics"
  | "debugging"
  | "implementing"
  | "verifying"
  | "blocked"
  | "converged"
  | "exhausted";

interface DebugLoopVerificationSummary {
  eventId: string;
  recordedAt: number;
  outcome: "pass" | "fail" | "skipped";
  activeSkill: string | null;
  failedChecks: string[];
  missingEvidence: string[];
  rootCause?: string;
  recommendation?: string;
}

export interface DebugLoopState {
  schema: "brewva.debug_loop.state.v1";
  sessionId: string;
  loopId: string;
  status: DebugLoopStatus;
  hypothesisCount: number;
  retryCount: number;
  startedAt: number;
  updatedAt: number;
  activeSkillName: string | null;
  activeIntentId?: string;
  scopeId?: string;
  lastVerification?: DebugLoopVerificationSummary;
  lastFailureCaseRef?: string;
  lastHandoffRef?: string;
  blockedReason?: string;
}

interface PendingSkillCompletion {
  toolCallId: string;
  skillName: string;
  outputs: Record<string, unknown>;
  observedAt: number;
  scopeId?: string;
}

interface VerificationEventPayload {
  outcome: "pass" | "fail" | "skipped";
  activeSkill: string | null;
  failedChecks: string[];
  missingEvidence: string[];
  rootCause?: string;
  recommendation?: string;
  commandsExecuted: string[];
  evidenceIds: string[];
  evidence: unknown[];
}

interface FailureCaseArtifact {
  schema: "brewva.failure_case.v1";
  sessionId: string;
  generatedAt: number;
  activeSkill: string | null;
  symptom: string;
  boundary?: string;
  failedChecks: string[];
  missingEvidence: string[];
  recommendation?: string;
  rootCause?: string;
  commandsExecuted: string[];
  evidenceIds: string[];
  evidence: unknown[];
  attemptedOutputs?: Record<string, unknown>;
}

interface HandoffPacket {
  schema: "brewva.handoff_packet.v1";
  sessionId: string;
  generatedAt: number;
  reason: "agent_end" | "session_shutdown" | "debug_loop_terminal";
  activeSkill: string | null;
  cascade: {
    intentId: string;
    source: string;
    status: string;
    cursor: number;
    nextSkill: string | null;
    steps: string[];
  } | null;
  task: {
    phase: string | null;
    health: string | null;
    reason: string | null;
    blockers: string[];
    openItems: number;
    totalItems: number;
  };
  debugLoop: {
    status: DebugLoopStatus;
    hypothesisCount: number;
    retryCount: number;
    failureCaseRef?: string;
  } | null;
  availableOutputs: Record<string, string[]>;
  nextAction: string;
  blockedOn: string[];
  resumeConditions: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalStatus(status: DebugLoopStatus): boolean {
  return status === "blocked" || status === "converged" || status === "exhausted";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeOutputs(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const outputs = value.outputs;
  return isRecord(outputs) ? outputs : undefined;
}

function parseVerificationPayload(payload: unknown): VerificationEventPayload | null {
  if (!isRecord(payload)) return null;
  const outcome = payload.outcome;
  if (outcome !== "pass" && outcome !== "fail" && outcome !== "skipped") {
    return null;
  }
  return {
    outcome,
    activeSkill: typeof payload.activeSkill === "string" ? payload.activeSkill : null,
    failedChecks: normalizeStringArray(payload.failedChecks),
    missingEvidence: normalizeStringArray(payload.missingEvidence),
    rootCause: typeof payload.rootCause === "string" ? payload.rootCause : undefined,
    recommendation: typeof payload.recommendation === "string" ? payload.recommendation : undefined,
    commandsExecuted: normalizeStringArray(payload.commandsExecuted),
    evidenceIds: normalizeStringArray(payload.evidenceIds),
    evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
  };
}

function summarizeFailureSymptom(payload: VerificationEventPayload): string {
  if (payload.failedChecks.length > 0) {
    return `Verification failed: ${payload.failedChecks.join(", ")}`;
  }
  if (payload.missingEvidence.length > 0) {
    return `Verification blocked: ${payload.missingEvidence.join(", ")}`;
  }
  return "Verification failed without structured check names.";
}

function inferBoundary(outputs?: Record<string, unknown>): string | undefined {
  if (!outputs) return undefined;
  const filesChanged = outputs.files_changed;
  if (!Array.isArray(filesChanged)) return undefined;
  const files = filesChanged.filter((entry): entry is string => typeof entry === "string");
  if (files.length === 0) return undefined;
  return files.join(", ");
}

function createLoopId(sessionId: string): string {
  return `${sessionId}:${Date.now()}`;
}

function extractSkillName(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return typeof payload.skillName === "string" && payload.skillName.trim().length > 0
    ? payload.skillName
    : null;
}

class DebugLoopController {
  private readonly runtime: BrewvaRuntime;
  private readonly pendingCompletionsBySession = new Map<string, PendingSkillCompletion>();
  private readonly stateBySession = new Map<string, DebugLoopState>();
  private readonly summaryFlushBySession = new Map<string, Promise<void>>();

  constructor(runtime: BrewvaRuntime) {
    this.runtime = runtime;
  }

  onToolCall(
    event: { toolName?: unknown; toolCallId?: unknown; input?: unknown },
    sessionId: string,
    scopeId?: string,
  ): void {
    if (event.toolName !== "skill_complete") return;
    if (typeof event.toolCallId !== "string" || event.toolCallId.trim().length === 0) return;
    const activeSkill = this.runtime.skills.getActive(sessionId);
    if (!activeSkill) return;
    const outputs = normalizeOutputs(event.input);
    if (!outputs) return;
    this.pendingCompletionsBySession.set(sessionId, {
      toolCallId: event.toolCallId,
      skillName: activeSkill.name,
      outputs,
      observedAt: Date.now(),
      scopeId,
    });
  }

  handleRuntimeEvent(event: BrewvaStructuredEvent): void {
    if (
      event.type === DEBUG_LOOP_TRANSITION_EVENT_TYPE ||
      event.type === DEBUG_LOOP_ARTIFACT_PERSIST_FAILED_EVENT_TYPE ||
      event.type === DEBUG_LOOP_FAILURE_CASE_PERSISTED_EVENT_TYPE ||
      event.type === DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE ||
      event.type === DEBUG_LOOP_HANDOFF_PERSISTED_EVENT_TYPE
    ) {
      return;
    }

    if (event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE) {
      this.handleVerificationOutcome(event);
      return;
    }
    if (event.type === "skill_activated") {
      this.handleSkillActivated(event);
      return;
    }
    if (event.type === "skill_completed") {
      this.handleSkillCompleted(event);
      return;
    }
    if (event.type === "agent_end") {
      this.persistHandoff(event.sessionId, "agent_end");
      return;
    }
    if (event.type === "session_shutdown") {
      this.persistHandoff(event.sessionId, "session_shutdown");
      this.pendingCompletionsBySession.delete(event.sessionId);
      this.stateBySession.delete(event.sessionId);
      this.summaryFlushBySession.delete(event.sessionId);
    }
  }

  private handleSkillActivated(event: BrewvaStructuredEvent): void {
    const state = this.getState(event.sessionId);
    if (!state || isTerminalStatus(state.status)) return;
    const skillName = extractSkillName(event.payload);
    if (!skillName) return;
    const nextStatus =
      skillName === "runtime-forensics"
        ? "forensics"
        : skillName === "debugging"
          ? "debugging"
          : skillName === "implementation"
            ? "implementing"
            : null;
    if (!nextStatus) return;
    this.transitionState(event.sessionId, {
      ...state,
      status: nextStatus,
      activeSkillName: skillName,
      blockedReason: undefined,
      updatedAt: event.timestamp,
    });
  }

  private handleSkillCompleted(event: BrewvaStructuredEvent): void {
    const state = this.getState(event.sessionId);
    if (!state || isTerminalStatus(state.status)) return;
    const skillName = extractSkillName(event.payload);
    if (!skillName) return;

    if (skillName === "runtime-forensics") {
      this.transitionState(event.sessionId, {
        ...state,
        status: "debugging",
        activeSkillName: "debugging",
        updatedAt: event.timestamp,
      });
      return;
    }

    if (skillName === "debugging") {
      this.transitionState(event.sessionId, {
        ...state,
        status: "implementing",
        activeSkillName: "implementation",
        hypothesisCount: Math.min(MAX_HYPOTHESES, state.hypothesisCount + 1),
        updatedAt: event.timestamp,
      });
      return;
    }

    if (skillName === "implementation") {
      this.transitionState(event.sessionId, {
        ...state,
        status: "converged",
        activeSkillName: null,
        blockedReason: undefined,
        updatedAt: event.timestamp,
      });
      this.persistHandoff(event.sessionId, "debug_loop_terminal");
    }
  }

  private handleVerificationOutcome(event: BrewvaStructuredEvent): void {
    const payload = parseVerificationPayload(event.payload);
    if (!payload || payload.activeSkill !== "implementation") return;

    const currentState = this.getState(event.sessionId);
    if (payload.outcome === "pass") {
      if (!currentState || isTerminalStatus(currentState.status)) return;
      this.transitionState(event.sessionId, {
        ...currentState,
        status: "verifying",
        activeSkillName: "implementation",
        lastVerification: this.buildVerificationSummary(event, payload),
        updatedAt: event.timestamp,
      });
      return;
    }

    if (payload.outcome !== "fail") return;
    if (currentState?.lastVerification?.eventId === event.id) return;

    const pendingCompletion = this.pendingCompletionsBySession.get(event.sessionId);
    // retryCount tracks scheduled retries after the initial failed implementation run.
    const nextRetryCount =
      currentState && !isTerminalStatus(currentState.status) ? currentState.retryCount + 1 : 0;

    const baseState = this.buildNextFailureState(event, payload, nextRetryCount);
    baseState.scopeId = pendingCompletion?.scopeId ?? baseState.scopeId;
    const failureCaseRef = this.persistFailureCase(
      event.sessionId,
      payload,
      pendingCompletion,
      event.timestamp,
    );
    baseState.lastFailureCaseRef = failureCaseRef ?? baseState.lastFailureCaseRef;

    if (currentState && !isTerminalStatus(currentState.status)) {
      if (nextRetryCount >= MAX_RETRIES) {
        this.transitionState(event.sessionId, {
          ...baseState,
          status: "exhausted",
          activeSkillName: this.runtime.skills.getActive(event.sessionId)?.name ?? "implementation",
          blockedReason: "retry_limit",
        });
        this.persistHandoff(event.sessionId, "debug_loop_terminal");
        return;
      }
      if (currentState.hypothesisCount >= MAX_HYPOTHESES) {
        this.transitionState(event.sessionId, {
          ...baseState,
          status: "exhausted",
          activeSkillName: this.runtime.skills.getActive(event.sessionId)?.name ?? "implementation",
          blockedReason: "hypothesis_limit",
        });
        this.persistHandoff(event.sessionId, "debug_loop_terminal");
        return;
      }
    }

    const retryResult = this.scheduleRetry(event.sessionId, baseState);
    if (!retryResult.ok) {
      this.transitionState(event.sessionId, {
        ...baseState,
        status: "blocked",
        blockedReason: retryResult.reason ?? "debug_loop_schedule_failed",
        activeSkillName: this.runtime.skills.getActive(event.sessionId)?.name ?? "implementation",
      });
      this.persistHandoff(event.sessionId, "debug_loop_terminal");
      return;
    }
    const retryState = retryResult.state ?? baseState;

    this.enqueueDebugLoopSummaryPacket({
      sessionId: event.sessionId,
      createdAt: event.timestamp,
      state: retryState,
      subject: `debug_loop_status:${event.sessionId}:retry`,
      summaryKind: "debug_loop_retry",
      fields: this.buildRetrySummaryFields({
        state: retryState,
        payload,
        failureCaseRef,
      }),
      evidenceRefs: this.buildDebugLoopSummaryEvidenceRefs({
        sessionId: event.sessionId,
        state: retryState,
        failureCaseRef,
      }),
    });

    this.pendingCompletionsBySession.delete(event.sessionId);
  }

  private buildNextFailureState(
    event: BrewvaStructuredEvent,
    payload: VerificationEventPayload,
    retryCount: number,
  ): DebugLoopState {
    const currentState = this.getState(event.sessionId);
    const startedAt = currentState?.startedAt ?? event.timestamp;
    return {
      schema: "brewva.debug_loop.state.v1",
      sessionId: event.sessionId,
      loopId:
        currentState && !isTerminalStatus(currentState.status)
          ? currentState.loopId
          : createLoopId(event.sessionId),
      status: currentState?.status ?? "idle",
      hypothesisCount: currentState?.hypothesisCount ?? 0,
      retryCount,
      startedAt,
      updatedAt: event.timestamp,
      activeSkillName: this.runtime.skills.getActive(event.sessionId)?.name ?? payload.activeSkill,
      activeIntentId: currentState?.activeIntentId,
      scopeId: currentState?.scopeId,
      lastFailureCaseRef: currentState?.lastFailureCaseRef,
      lastHandoffRef: currentState?.lastHandoffRef,
      blockedReason: undefined,
      lastVerification: this.buildVerificationSummary(event, payload),
    };
  }

  private buildVerificationSummary(
    event: BrewvaStructuredEvent,
    payload: VerificationEventPayload,
  ): DebugLoopVerificationSummary {
    return {
      eventId: event.id,
      recordedAt: event.timestamp,
      outcome: payload.outcome,
      activeSkill: payload.activeSkill,
      failedChecks: payload.failedChecks,
      missingEvidence: payload.missingEvidence,
      rootCause: payload.rootCause,
      recommendation: payload.recommendation,
    };
  }

  private buildRetryEvidenceRefs(sessionId: string, state: DebugLoopState) {
    const refs: Array<ReturnType<typeof buildEventEvidenceRef>> = [];

    if (state.lastVerification) {
      refs.push(
        buildEventEvidenceRef({
          id: `${state.loopId}:verification:${state.lastVerification.eventId}`,
          eventId: state.lastVerification.eventId,
          createdAt: state.lastVerification.recordedAt,
        }),
      );
    }
    if (state.lastFailureCaseRef) {
      refs.push(
        buildWorkspaceArtifactEvidenceRef({
          id: `${state.loopId}:failure_case:${state.retryCount}`,
          locator: state.lastFailureCaseRef,
          createdAt: state.updatedAt,
        }),
      );
    }
    if (refs.length === 0) {
      refs.push(
        buildOperatorNoteEvidenceRef({
          id: `${state.loopId}:debug_loop_state:${state.retryCount}`,
          locator: `session://${sessionId}/debug-loop`,
          createdAt: state.updatedAt,
        }),
      );
    }

    return refs;
  }

  private recordArtifactPersistFailure(input: {
    sessionId: string;
    artifactKind:
      | "state"
      | "failure_case"
      | "handoff"
      | "cognition_summary"
      | "cognition_reference";
    fileName: string;
    absolutePath: string;
    error: string;
    loopId?: string;
    status?: DebugLoopStatus;
  }): void {
    this.runtime.events.record({
      sessionId: input.sessionId,
      type: DEBUG_LOOP_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
      payload: {
        artifactKind: input.artifactKind,
        fileName: input.fileName,
        absolutePath: input.absolutePath,
        error: input.error,
        loopId: input.loopId ?? null,
        status: input.status ?? null,
      },
    });
  }

  private scheduleRetry(
    sessionId: string,
    state: DebugLoopState,
  ): { ok: boolean; reason?: string; state?: DebugLoopState } {
    const existingIntent = this.runtime.skills.getCascadeIntent(sessionId);
    if (
      existingIntent &&
      existingIntent.status !== "completed" &&
      existingIntent.status !== "failed" &&
      existingIntent.status !== "cancelled"
    ) {
      this.runtime.skills.cancelCascade(sessionId, "debug_loop_retry");
    }

    const hasRuntimeTrace = Boolean(
      this.runtime.skills.getOutputs(sessionId, "runtime-forensics")?.runtime_trace,
    );
    const steps = hasRuntimeTrace
      ? [
          {
            skill: "debugging",
            produces: ["root_cause", "fix_strategy", "failure_evidence"],
          },
          {
            skill: "implementation",
            consumes: ["root_cause", "fix_strategy"],
            produces: ["change_set", "files_changed", "verification_evidence"],
          },
        ]
      : [
          {
            skill: "runtime-forensics",
            produces: ["runtime_trace", "session_summary", "artifact_findings"],
          },
          {
            skill: "debugging",
            consumes: ["runtime_trace"],
            produces: ["root_cause", "fix_strategy", "failure_evidence"],
          },
          {
            skill: "implementation",
            consumes: ["root_cause", "fix_strategy"],
            produces: ["change_set", "files_changed", "verification_evidence"],
          },
        ];

    const evidenceRefs = this.buildRetryEvidenceRefs(sessionId, state);
    const cascadeResult = this.runtime.skills.startCascade(sessionId, { steps });
    if (!cascadeResult.ok) {
      return {
        ok: false,
        reason: cascadeResult.reason ?? "debug_loop_retry_rejected",
      };
    }

    const cascade = cascadeResult.intent ?? this.runtime.skills.getCascadeIntent(sessionId);
    if (!cascade) {
      return { ok: false, reason: "cascade_intent_missing_after_commit" };
    }
    const nextSkill =
      this.runtime.skills.getActive(sessionId)?.name ??
      cascade.steps[cascade.cursor]?.skill ??
      null;
    const nextState: DebugLoopState = {
      ...state,
      status: nextSkill === "runtime-forensics" ? "forensics" : "debugging",
      activeIntentId: cascade.id,
      activeSkillName: nextSkill,
      blockedReason: undefined,
      updatedAt: Date.now(),
    };
    const persisted = this.saveState(nextState);
    this.runtime.events.record({
      sessionId,
      type: DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
      payload: {
        loopId: nextState.loopId,
        intentId: cascade.id,
        nextSkill,
        debugLoopRef: persisted ?? null,
        failureCaseRef: nextState.lastFailureCaseRef ?? null,
        retryCount: nextState.retryCount,
        hypothesisCount: nextState.hypothesisCount,
        committedBy: "direct_cascade_start",
        evidenceRefs,
      },
    });
    return { ok: true, state: nextState };
  }

  private persistFailureCase(
    sessionId: string,
    payload: VerificationEventPayload,
    pendingCompletion: PendingSkillCompletion | undefined,
    generatedAt: number,
  ): string | null {
    const failureCase: FailureCaseArtifact = {
      schema: "brewva.failure_case.v1",
      sessionId,
      generatedAt,
      activeSkill: payload.activeSkill,
      symptom: summarizeFailureSymptom(payload),
      boundary: inferBoundary(pendingCompletion?.outputs),
      failedChecks: payload.failedChecks,
      missingEvidence: payload.missingEvidence,
      recommendation: payload.recommendation,
      rootCause: payload.rootCause,
      commandsExecuted: payload.commandsExecuted,
      evidenceIds: payload.evidenceIds,
      evidence: payload.evidence,
      attemptedOutputs:
        pendingCompletion && pendingCompletion.skillName === "implementation"
          ? pendingCompletion.outputs
          : undefined,
    };
    const persisted = persistSessionJsonArtifact({
      workspaceRoot: this.runtime.workspaceRoot,
      sessionId,
      fileName: FAILURE_CASE_FILE,
      data: failureCase,
    });
    if (!persisted.ok || !persisted.artifactRef) {
      this.recordArtifactPersistFailure({
        sessionId,
        artifactKind: "failure_case",
        fileName: FAILURE_CASE_FILE,
        absolutePath: persisted.absolutePath,
        error: persisted.error ?? "artifact_persist_failed",
        loopId: this.getState(sessionId)?.loopId,
        status: this.getState(sessionId)?.status,
      });
      return null;
    }
    this.runtime.events.record({
      sessionId,
      type: DEBUG_LOOP_FAILURE_CASE_PERSISTED_EVENT_TYPE,
      payload: {
        artifactRef: persisted.artifactRef,
        failedChecks: payload.failedChecks,
        missingEvidence: payload.missingEvidence,
      },
    });
    return persisted.artifactRef;
  }

  private persistHandoff(sessionId: string, reason: HandoffPacket["reason"]): string | null {
    const packet = this.buildHandoffPacket(sessionId, reason);
    if (!packet) return null;
    const persisted = persistSessionJsonArtifact({
      workspaceRoot: this.runtime.workspaceRoot,
      sessionId,
      fileName: HANDOFF_FILE,
      data: packet,
    });
    if (!persisted.ok || !persisted.artifactRef) {
      this.recordArtifactPersistFailure({
        sessionId,
        artifactKind: "handoff",
        fileName: HANDOFF_FILE,
        absolutePath: persisted.absolutePath,
        error: persisted.error ?? "artifact_persist_failed",
        loopId: this.getState(sessionId)?.loopId,
        status: this.getState(sessionId)?.status,
      });
      return null;
    }

    const state = this.getState(sessionId);
    if (state) {
      this.saveState({
        ...state,
        lastHandoffRef: persisted.artifactRef,
        updatedAt: Date.now(),
      });
      this.enqueueDebugLoopSummaryPacket({
        sessionId,
        createdAt: packet.generatedAt,
        state: {
          ...state,
          lastHandoffRef: persisted.artifactRef,
          updatedAt: packet.generatedAt,
        },
        subject: `debug_loop_status:${sessionId}:handoff`,
        summaryKind: "debug_loop_handoff",
        fields: this.buildHandoffSummaryFields({
          packet,
          artifactRef: persisted.artifactRef,
          state,
        }),
        evidenceRefs: this.buildDebugLoopSummaryEvidenceRefs({
          sessionId,
          state,
          failureCaseRef: state.lastFailureCaseRef,
          handoffRef: persisted.artifactRef,
        }),
      });
      if (reason === "debug_loop_terminal" && isTerminalStatus(state.status)) {
        void this.persistTerminalReferenceArtifact({
          sessionId,
          createdAt: packet.generatedAt,
          packet,
          state: {
            ...state,
            lastHandoffRef: persisted.artifactRef,
            updatedAt: packet.generatedAt,
          },
        });
      }
    }

    this.runtime.events.record({
      sessionId,
      type: DEBUG_LOOP_HANDOFF_PERSISTED_EVENT_TYPE,
      payload: {
        reason,
        artifactRef: persisted.artifactRef,
        nextAction: packet.nextAction,
      },
    });
    return persisted.artifactRef;
  }

  private buildHandoffPacket(
    sessionId: string,
    reason: HandoffPacket["reason"],
  ): HandoffPacket | null {
    const activeSkill = this.runtime.skills.getActive(sessionId)?.name ?? null;
    const intent = this.runtime.skills.getCascadeIntent(sessionId);
    const taskState = this.runtime.task.getState(sessionId);
    const state = this.getState(sessionId);
    const blockers = (taskState.blockers ?? []).map((blocker) => blocker.id);
    const totalItems = taskState.items.length;
    const openItems = taskState.items.filter((item) => item.status !== "done").length;
    const nextSkill =
      activeSkill ??
      intent?.steps[intent.cursor]?.skill ??
      (state && !isTerminalStatus(state.status) ? state.activeSkillName : null);
    const blockedOn = blockers.slice();

    if (state?.blockedReason) {
      blockedOn.push(state.blockedReason);
    }

    const packet: HandoffPacket = {
      schema: "brewva.handoff_packet.v1",
      sessionId,
      generatedAt: Date.now(),
      reason,
      activeSkill,
      cascade: this.toCascadeSummary(intent),
      task: {
        phase: taskState.status?.phase ?? null,
        health: taskState.status?.health ?? null,
        reason: taskState.status?.reason ?? null,
        blockers,
        openItems,
        totalItems,
      },
      debugLoop: state
        ? {
            status: state.status,
            hypothesisCount: state.hypothesisCount,
            retryCount: state.retryCount,
            failureCaseRef: state.lastFailureCaseRef,
          }
        : null,
      availableOutputs: this.collectAvailableOutputs(sessionId),
      nextAction: this.computeNextAction(nextSkill, intent, state, taskState),
      blockedOn,
      resumeConditions: this.computeResumeConditions(nextSkill, state, taskState),
    };
    return packet;
  }

  private computeNextAction(
    nextSkill: string | null,
    intent: SkillChainIntent | undefined,
    state: DebugLoopState | undefined,
    taskState: TaskState,
  ): string {
    if (state?.status === "blocked" || state?.status === "exhausted") {
      return state.lastFailureCaseRef
        ? `inspect:${state.lastFailureCaseRef}`
        : "inspect:debug-loop";
    }
    if (nextSkill) {
      return `load:${nextSkill}`;
    }
    if ((taskState.blockers ?? []).length > 0) {
      return "resolve:blockers";
    }
    if (intent?.steps[intent.cursor]?.skill) {
      return `load:${intent.steps[intent.cursor]?.skill}`;
    }
    return "await:operator";
  }

  private computeResumeConditions(
    nextSkill: string | null,
    state: DebugLoopState | undefined,
    taskState: TaskState,
  ): string[] {
    const conditions: string[] = [];
    if (nextSkill) {
      conditions.push(`load skill ${nextSkill}`);
    }
    if (state?.lastFailureCaseRef) {
      conditions.push(`consult ${state.lastFailureCaseRef}`);
    }
    if ((taskState.blockers ?? []).length > 0) {
      conditions.push("clear task blockers or record why they remain");
    }
    if (state?.status === "blocked" || state?.status === "exhausted") {
      conditions.push("choose a new strategy before resuming mutation work");
    }
    return conditions;
  }

  private toCascadeSummary(intent: SkillChainIntent | undefined): HandoffPacket["cascade"] {
    if (!intent) return null;
    return {
      intentId: intent.id,
      source: intent.source,
      status: intent.status,
      cursor: intent.cursor,
      nextSkill: intent.steps[intent.cursor]?.skill ?? null,
      steps: intent.steps.map((step) => step.skill),
    };
  }

  private collectAvailableOutputs(sessionId: string): Record<string, string[]> {
    const summary: Record<string, string[]> = {};
    for (const skill of this.runtime.skills.list()) {
      const outputs = this.runtime.skills.getOutputs(sessionId, skill.name);
      if (!outputs) continue;
      summary[skill.name] = Object.keys(outputs).toSorted();
    }
    return summary;
  }

  private buildRetrySummaryFields(input: {
    state: DebugLoopState;
    payload: VerificationEventPayload;
    failureCaseRef: string | null;
  }): StatusSummaryField[] {
    return [
      { key: "mode", value: "retry_scheduled" },
      {
        key: "next_action",
        value: input.state.activeSkillName ? `load:${input.state.activeSkillName}` : null,
      },
      { key: "next_skill", value: input.state.activeSkillName },
      { key: "retry_count", value: String(input.state.retryCount) },
      { key: "hypothesis_count", value: String(input.state.hypothesisCount) },
      { key: "symptom", value: summarizeFailureSymptom(input.payload) },
      { key: "failed_checks", value: input.payload.failedChecks },
      { key: "missing_evidence", value: input.payload.missingEvidence },
      { key: "root_cause", value: input.payload.rootCause },
      { key: "recommendation", value: input.payload.recommendation },
      { key: "references", value: input.failureCaseRef ? [input.failureCaseRef] : [] },
    ];
  }

  private buildHandoffSummaryFields(input: {
    packet: HandoffPacket;
    artifactRef: string;
    state: DebugLoopState;
  }): StatusSummaryField[] {
    return [
      { key: "mode", value: "handoff" },
      { key: "reason", value: input.packet.reason },
      { key: "active_skill", value: input.packet.activeSkill },
      { key: "next_action", value: input.packet.nextAction },
      { key: "blocked_on", value: input.packet.blockedOn },
      { key: "resume_conditions", value: input.packet.resumeConditions },
      {
        key: "references",
        value: [
          ...(input.state.lastFailureCaseRef ? [input.state.lastFailureCaseRef] : []),
          input.artifactRef,
        ],
      },
    ];
  }

  private buildReferenceSedimentContent(input: {
    packet: HandoffPacket;
    state: DebugLoopState;
  }): string {
    return [
      "[ReferenceSediment]",
      "kind: debug_loop_terminal",
      `status: ${input.state.status}`,
      `reason: ${input.packet.reason}`,
      `active_skill: ${input.packet.activeSkill ?? "none"}`,
      `next_action: ${input.packet.nextAction}`,
      `blocked_on: ${input.packet.blockedOn.join("; ") || "none"}`,
      `resume_conditions: ${input.packet.resumeConditions.join("; ") || "none"}`,
      `available_outputs: ${Object.keys(input.packet.availableOutputs).join(", ") || "none"}`,
      `failure_case_ref: ${input.state.lastFailureCaseRef ?? "none"}`,
      `handoff_ref: ${input.state.lastHandoffRef ?? "none"}`,
    ].join("\n");
  }

  private buildDebugLoopSummaryEvidenceRefs(input: {
    sessionId: string;
    state: DebugLoopState;
    failureCaseRef?: string | null;
    handoffRef?: string | null;
  }): EvidenceRef[] {
    const seed = input.state.loopId || input.sessionId;
    const refs: EvidenceRef[] = [];

    if (input.state.lastVerification) {
      refs.push(
        buildEventEvidenceRef({
          id: `${seed}:summary:verification:${input.state.lastVerification.eventId}`,
          eventId: input.state.lastVerification.eventId,
          createdAt: input.state.lastVerification.recordedAt,
        }),
      );
    }

    if (input.failureCaseRef) {
      refs.push(
        buildWorkspaceArtifactEvidenceRef({
          id: `${seed}:summary:failure_case`,
          locator: input.failureCaseRef,
          createdAt: input.state.updatedAt,
        }),
      );
    }

    if (input.handoffRef) {
      refs.push(
        buildWorkspaceArtifactEvidenceRef({
          id: `${seed}:summary:handoff`,
          locator: input.handoffRef,
          createdAt: input.state.updatedAt,
        }),
      );
    }

    if (refs.length === 0) {
      refs.push(
        buildOperatorNoteEvidenceRef({
          id: `${seed}:summary:state`,
          locator: `session://${input.sessionId}/debug-loop-summary`,
          createdAt: input.state.updatedAt,
        }),
      );
    }

    return refs;
  }

  private enqueueDebugLoopSummaryPacket(input: {
    sessionId: string;
    createdAt: number;
    state: DebugLoopState;
    subject: string;
    summaryKind: string;
    fields: StatusSummaryField[];
    evidenceRefs: EvidenceRef[];
  }): void {
    const previous = this.summaryFlushBySession.get(input.sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.publishDebugLoopSummaryPacket(input));
    const settled = next.finally(() => {
      if (this.summaryFlushBySession.get(input.sessionId) === settled) {
        this.summaryFlushBySession.delete(input.sessionId);
      }
    });
    this.summaryFlushBySession.set(input.sessionId, settled);
  }

  private async persistTerminalReferenceArtifact(input: {
    sessionId: string;
    createdAt: number;
    packet: HandoffPacket;
    state: DebugLoopState;
  }): Promise<void> {
    try {
      const artifact = await writeCognitionArtifact({
        workspaceRoot: this.runtime.workspaceRoot,
        lane: "reference",
        name: `debug-loop-${input.state.status}-handoff`,
        content: this.buildReferenceSedimentContent(input),
        createdAt: input.createdAt,
      });
      this.runtime.events.record({
        sessionId: input.sessionId,
        type: "debug_loop_reference_persisted",
        payload: {
          artifactRef: artifact.artifactRef,
          status: input.state.status,
          loopId: input.state.loopId,
        },
      });
    } catch (error) {
      this.recordArtifactPersistFailure({
        sessionId: input.sessionId,
        artifactKind: "cognition_reference",
        fileName: DEBUG_LOOP_REFERENCE_FILE,
        absolutePath: resolveCognitionArtifactsDir(this.runtime.workspaceRoot, "reference"),
        error: error instanceof Error ? error.message : String(error),
        loopId: input.state.loopId,
        status: input.state.status,
      });
    }
  }

  private async publishDebugLoopSummaryPacket(input: {
    sessionId: string;
    createdAt: number;
    state: DebugLoopState;
    subject: string;
    summaryKind: string;
    fields: StatusSummaryField[];
    evidenceRefs: EvidenceRef[];
  }): Promise<void> {
    try {
      const submitted = await submitStatusSummaryContextPacket({
        runtime: this.runtime,
        sessionId: input.sessionId,
        issuer: DELIBERATION_ISSUERS.debugLoop,
        name: "Debug Loop Status",
        label: "DebugLoopStatus",
        subject: input.subject,
        summaryKind: input.summaryKind,
        status: input.state.status,
        fields: input.fields,
        scopeId: input.state.scopeId,
        packetKey: DEBUG_LOOP_SUMMARY_PACKET_KEY,
        createdAt: input.createdAt,
        expiresAt: input.createdAt + DEBUG_LOOP_SUMMARY_PACKET_TTL_MS,
        evidenceRefs: input.evidenceRefs,
      });
      if (submitted.receipt.decision !== "accept") {
        this.recordArtifactPersistFailure({
          sessionId: input.sessionId,
          artifactKind: "cognition_summary",
          fileName: DEBUG_LOOP_SUMMARY_FILE,
          absolutePath: resolveCognitionArtifactsDir(this.runtime.workspaceRoot, "summaries"),
          error: `context_packet_${submitted.receipt.decision}: ${
            submitted.receipt.reasons.join(", ") || "no_reason_provided"
          }`,
          loopId: input.state.loopId,
          status: input.state.status,
        });
      }
    } catch (error) {
      this.recordArtifactPersistFailure({
        sessionId: input.sessionId,
        artifactKind: "cognition_summary",
        fileName: DEBUG_LOOP_SUMMARY_FILE,
        absolutePath: resolveCognitionArtifactsDir(this.runtime.workspaceRoot, "summaries"),
        error: error instanceof Error ? error.message : String(error),
        loopId: input.state.loopId,
        status: input.state.status,
      });
    }
  }

  private transitionState(sessionId: string, state: DebugLoopState): void {
    const artifactRef = this.saveState(state);
    this.runtime.events.record({
      sessionId,
      type: DEBUG_LOOP_TRANSITION_EVENT_TYPE,
      payload: {
        loopId: state.loopId,
        status: state.status,
        activeSkill: state.activeSkillName,
        retryCount: state.retryCount,
        hypothesisCount: state.hypothesisCount,
        blockedReason: state.blockedReason ?? null,
        debugLoopRef: artifactRef ?? null,
      },
    });
  }

  private saveState(state: DebugLoopState): string | null {
    const persisted = persistSessionJsonArtifact({
      workspaceRoot: this.runtime.workspaceRoot,
      sessionId: state.sessionId,
      fileName: DEBUG_LOOP_STATE_FILE,
      data: state,
    });
    if (persisted.ok && persisted.artifactRef) {
      this.stateBySession.set(state.sessionId, state);
      return persisted.artifactRef;
    }
    this.recordArtifactPersistFailure({
      sessionId: state.sessionId,
      artifactKind: "state",
      fileName: DEBUG_LOOP_STATE_FILE,
      absolutePath: persisted.absolutePath,
      error: persisted.error ?? "artifact_persist_failed",
      loopId: state.loopId,
      status: state.status,
    });
    this.stateBySession.set(state.sessionId, state);
    return null;
  }

  private getState(sessionId: string): DebugLoopState | undefined {
    const inMemory = this.stateBySession.get(sessionId);
    if (inMemory) return inMemory;
    const persisted = readSessionJsonArtifact<DebugLoopState>({
      workspaceRoot: this.runtime.workspaceRoot,
      sessionId,
      fileName: DEBUG_LOOP_STATE_FILE,
    });
    if (persisted) {
      this.stateBySession.set(sessionId, persisted);
      return persisted;
    }
    return undefined;
  }
}

function extractSessionId(ctx: unknown): string {
  if (
    !ctx ||
    typeof ctx !== "object" ||
    !("sessionManager" in ctx) ||
    !ctx.sessionManager ||
    typeof (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager
      ?.getSessionId !== "function"
  ) {
    return "";
  }
  return (ctx as { sessionManager: { getSessionId: () => string } }).sessionManager.getSessionId();
}

export function registerDebugLoop(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const controller = new DebugLoopController(runtime);

  pi.on("tool_call", (event, ctx) => {
    const sessionId = extractSessionId(ctx);
    if (!sessionId) return undefined;
    controller.onToolCall(
      event as { toolName?: unknown; toolCallId?: unknown; input?: unknown },
      sessionId,
      resolveInjectionScopeId(
        (ctx as { sessionManager?: { getLeafId?: () => string | null | undefined } })
          .sessionManager,
      ),
    );
    return undefined;
  });

  runtime.events.subscribe((event) => {
    controller.handleRuntimeEvent(event);
  });
}
