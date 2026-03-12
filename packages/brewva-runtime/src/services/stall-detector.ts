import {
  TASK_STUCK_CLEARED_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { TASK_EVENT_TYPE } from "../task/ledger.js";
import {
  SCAN_CONVERGENCE_BLOCKER_ID,
  WATCHDOG_BLOCKER_ID,
  WATCHDOG_BLOCKER_SOURCE,
  buildTaskStuckBlockerMessage,
  buildTaskStuckClearedPayload,
  buildTaskStuckDetectedPayload,
  coerceTaskStuckDetectedPayload,
  computeTaskSemanticProgressAt,
  evaluateTaskWatchdogEligibility,
  getTaskWatchdogBlocker,
  getTaskWatchdogOpenItemCount,
  resolveTaskWatchdogPhase,
  toTaskWatchdogEventPayload,
  type TaskWatchdogPhase,
} from "../task/watchdog.js";
import type { BrewvaEventQuery, BrewvaEventRecord, TaskBlocker, TaskState } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";
import {
  isToolResultFail,
  isToolResultPass,
  type ToolResultVerdict,
} from "../utils/tool-result.js";
import {
  classifyScanConvergenceToolStrategy,
  listBlockedScanConvergenceTools,
} from "./scan-convergence-strategy.js";
import {
  type RuntimeSessionStateStore,
  type ScanConvergenceReason,
  type ScanConvergenceResetReason,
  type ScanConvergenceRuntimeState,
  type ScanConvergenceToolStrategy,
} from "./session-state.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";
import type { TaskService } from "./task.js";

const CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD = 3;
const CONSECUTIVE_INVESTIGATION_ONLY_TURNS_THRESHOLD = 6;
const CONSECUTIVE_SCAN_FAILURES_THRESHOLD = 3;

const SCAN_CONVERGENCE_ARMED_EVENT_TYPE = "scan_convergence_armed";
const SCAN_CONVERGENCE_BLOCKED_EVENT_TYPE = "scan_convergence_blocked_tool";
const SCAN_CONVERGENCE_RESET_EVENT_TYPE = "scan_convergence_reset";

const GUARD_BLOCKER_SOURCE = "runtime.scan_convergence" as const;
const DEFAULT_THRESHOLDS_MS: Record<TaskWatchdogPhase, number> = {
  investigate: 5 * 60_000,
  execute: 10 * 60_000,
  verify: 5 * 60_000,
};

const EMPTY_STATE = (): ScanConvergenceRuntimeState => ({
  currentTurnRawScanToolCalls: 0,
  currentTurnLowSignalToolCalls: 0,
  currentTurnConvergenceToolCalls: 0,
  consecutiveScanOnlyTurns: 0,
  consecutiveInvestigationOnlyTurns: 0,
  consecutiveScanFailures: 0,
  armedReason: null,
  toolStrategyByCallId: new Map<string, ScanConvergenceToolStrategy>(),
});

function sanitizeDelayMs(value: number | undefined, fallbackMs: number): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallbackMs;
  return Math.max(1_000, candidate);
}

function createThresholdPolicy(
  overrides?: Partial<Record<TaskWatchdogPhase, number>>,
): Readonly<Record<TaskWatchdogPhase, number>> {
  return {
    investigate: sanitizeDelayMs(overrides?.investigate, DEFAULT_THRESHOLDS_MS.investigate),
    execute: sanitizeDelayMs(overrides?.execute, DEFAULT_THRESHOLDS_MS.execute),
    verify: sanitizeDelayMs(overrides?.verify, DEFAULT_THRESHOLDS_MS.verify),
  };
}

function buildDetectionKey(input: {
  phase: TaskWatchdogPhase;
  baselineProgressAt: number;
  suppressedBy: string | null;
}): string {
  return `${input.phase}:${input.baselineProgressAt}:${input.suppressedBy ?? ""}`;
}

function readNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function parseCounter(message: string, name: string): number {
  const match = new RegExp(`${name}=(\\d+)`, "u").exec(message);
  if (!match?.[1]) return 0;
  return readNonNegativeInteger(Number(match[1]));
}

function inferReasonFromBlocker(blocker: TaskBlocker): ScanConvergenceReason | null {
  const text = blocker.message.toLowerCase();
  if (text.includes("read/grep-only")) return "scan_only_turns";
  if (text.includes("low-signal investigation")) return "investigation_only_turns";
  if (text.includes("read/grep failures")) return "scan_failures";
  return null;
}

function normalizeReason(value: unknown): ScanConvergenceReason | null {
  if (
    value === "scan_only_turns" ||
    value === "investigation_only_turns" ||
    value === "scan_failures"
  ) {
    return value;
  }
  return null;
}

function classifyScanFailure(text: string): "out_of_bounds" | "enoent" | "directory" | null {
  const normalized = text.trim();
  if (!normalized) return null;
  if (/offset\s+\d+\s+is\s+beyond\s+end\s+of\s+file/i.test(normalized)) {
    return "out_of_bounds";
  }
  if (/\benoent\b/i.test(normalized) || /no such file or directory/i.test(normalized)) {
    return "enoent";
  }
  if (/\beisdir\b/i.test(normalized) || /is a directory/i.test(normalized)) {
    return "directory";
  }
  return null;
}

function buildArmSummary(reason: ScanConvergenceReason): string {
  if (reason === "scan_only_turns") {
    return "Repeated read/grep-only turns reached the convergence threshold.";
  }
  if (reason === "investigation_only_turns") {
    return "Repeated low-signal investigation turns reached the convergence threshold.";
  }
  return "Repeated read/grep failures reached the convergence threshold.";
}

function buildBlockReason(reason: ScanConvergenceReason): string {
  const trigger =
    reason === "scan_only_turns"
      ? "too many read/grep-only turns"
      : reason === "investigation_only_turns"
        ? "too many low-signal investigation turns"
        : "too many repeated ENOENT/out-of-bounds scan failures";

  return [
    "[Brewva Scan Convergence Guard]",
    `Stop low-signal investigation: ${trigger}.`,
    "",
    "Provide a staged conclusion now:",
    "- summarize what you already checked",
    "- name the missing path, symbol, offset, or blocker",
    "- record the next step via task/blocker tools or handoff",
    "- prefer existing evidence via output_search / ledger_query / tape_search before more reads",
    "",
    "Only resume low-signal retrieval after the strategy changes with a convergence tool.",
  ].join("\n");
}

function buildTaskBlockerMessage(
  reason: ScanConvergenceReason,
  state: ScanConvergenceRuntimeState,
): string {
  return [
    "[ScanConvergenceGuard]",
    buildArmSummary(reason),
    `consecutive_scan_only_turns=${state.consecutiveScanOnlyTurns}`,
    `consecutive_investigation_only_turns=${state.consecutiveInvestigationOnlyTurns}`,
    `consecutive_scan_failures=${state.consecutiveScanFailures}`,
    "required_next_step=Review current evidence, then record a task mutation, blocker, spec, or handoff before more low-signal retrieval.",
    "preferred_tools=task_set_spec,task_add_item,task_record_blocker,task_view_state,output_search,ledger_query,tape_search,tape_handoff",
  ].join("\n");
}

function hasActiveGuardBlocker(state: TaskState): TaskBlocker | undefined {
  return state.blockers.find((blocker) => blocker.id === SCAN_CONVERGENCE_BLOCKER_ID);
}

export interface ScanConvergenceDecision {
  allowed: boolean;
  reason?: string;
}

export interface CheckScanConvergenceToolCallInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
}

export interface ObserveScanConvergenceToolResultInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  verdict: ToolResultVerdict;
  outputText: string;
}

export interface PollTaskProgressInput {
  sessionId: string;
  now?: number;
  thresholdsMs?: Partial<Record<TaskWatchdogPhase, number>>;
}

export interface StallDetectorServiceOptions {
  sessionState: RuntimeKernelContext["sessionState"];
  listEvents: (sessionId: string, query?: BrewvaEventQuery) => BrewvaEventRecord[];
  getTaskState: RuntimeKernelContext["getTaskState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  taskService: Pick<TaskService, "recordTaskBlocker" | "resolveTaskBlocker">;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
}

export class StallDetectorService {
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly listEvents: (sessionId: string, query?: BrewvaEventQuery) => BrewvaEventRecord[];
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkillName: (sessionId: string) => string | undefined;
  private readonly recordTaskBlocker: (
    sessionId: string,
    input: { id?: string; message: string; source?: string; truthFactId?: string },
  ) => { ok: boolean; blockerId?: string; error?: string };
  private readonly resolveTaskBlocker: (
    sessionId: string,
    blockerId: string,
  ) => { ok: boolean; error?: string };
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;
  private readonly taskDetectionKeyBySession = new Map<string, string>();

  constructor(options: StallDetectorServiceOptions) {
    this.sessionState = options.sessionState;
    this.listEvents = (sessionId, query) => options.listEvents(sessionId, query);
    this.getTaskState = (sessionId) => options.getTaskState(sessionId);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getActiveSkillName = (sessionId) =>
      options.skillLifecycleService.getActiveSkill(sessionId)?.name;
    this.recordTaskBlocker = (sessionId, input) =>
      options.taskService.recordTaskBlocker(sessionId, input);
    this.resolveTaskBlocker = (sessionId, blockerId) =>
      options.taskService.resolveTaskBlocker(sessionId, blockerId);
    this.recordEvent = (input) => options.recordEvent(input);
  }

  onTurnStart(sessionId: string): void {
    this.maybeClearTaskProgressStall(sessionId);
  }

  onUserInput(sessionId: string): void {
    const state = this.getScanState(sessionId);
    this.resetScanGuard(sessionId, state, "input_reset");
  }

  onTurnEnd(sessionId: string): void {
    const state = this.getScanState(sessionId);

    if (state.currentTurnConvergenceToolCalls > 0) {
      if (state.armedReason === null) {
        state.consecutiveScanOnlyTurns = 0;
        state.consecutiveInvestigationOnlyTurns = 0;
        state.consecutiveScanFailures = 0;
      }
      this.clearTurnState(state);
      return;
    }

    if (state.currentTurnLowSignalToolCalls > 0) {
      state.consecutiveInvestigationOnlyTurns += 1;

      const scanOnlyTurn =
        state.currentTurnRawScanToolCalls > 0 &&
        state.currentTurnRawScanToolCalls === state.currentTurnLowSignalToolCalls;
      if (scanOnlyTurn) {
        state.consecutiveScanOnlyTurns += 1;
        if (state.consecutiveScanOnlyTurns >= CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD) {
          this.armScanGuard(sessionId, state, "scan_only_turns");
        }
      } else {
        state.consecutiveScanOnlyTurns = 0;
      }

      if (
        state.consecutiveInvestigationOnlyTurns >= CONSECUTIVE_INVESTIGATION_ONLY_TURNS_THRESHOLD
      ) {
        this.armScanGuard(sessionId, state, "investigation_only_turns");
      }
    }

    this.clearTurnState(state);
  }

  checkToolCall(input: CheckScanConvergenceToolCallInput): ScanConvergenceDecision {
    const state = this.getScanState(input.sessionId);
    const normalizedToolName = normalizeToolName(input.toolName);
    if (!normalizedToolName) {
      return { allowed: true };
    }

    const strategy = classifyScanConvergenceToolStrategy(normalizedToolName, input.args);
    state.toolStrategyByCallId.set(input.toolCallId, strategy);

    if (state.armedReason !== null && (strategy === "raw_scan" || strategy === "low_signal")) {
      const reason = buildBlockReason(state.armedReason);
      this.recordEvent({
        sessionId: input.sessionId,
        type: SCAN_CONVERGENCE_BLOCKED_EVENT_TYPE,
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolCallId: input.toolCallId,
          toolName: normalizedToolName,
          toolStrategy: strategy,
          reason: state.armedReason,
          blockMessage: reason,
          consecutiveScanOnlyTurns: state.consecutiveScanOnlyTurns,
          consecutiveInvestigationOnlyTurns: state.consecutiveInvestigationOnlyTurns,
          consecutiveScanFailures: state.consecutiveScanFailures,
          requiredAction: "staged_conclusion_required",
        },
      });
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizedToolName,
          toolStrategy: strategy,
          skill: this.getActiveSkillName(input.sessionId) ?? null,
          reason,
        },
      });
      return {
        allowed: false,
        reason,
      };
    }

    if (strategy === "raw_scan") {
      state.currentTurnRawScanToolCalls += 1;
      state.currentTurnLowSignalToolCalls += 1;
    } else if (strategy === "low_signal") {
      state.currentTurnLowSignalToolCalls += 1;
    }

    return { allowed: true };
  }

  observeToolResult(input: ObserveScanConvergenceToolResultInput): void {
    const state = this.getScanState(input.sessionId);
    const normalizedToolName = normalizeToolName(input.toolName);
    if (!normalizedToolName) return;
    const verdict = input.verdict;

    const strategy =
      state.toolStrategyByCallId.get(input.toolCallId) ??
      classifyScanConvergenceToolStrategy(normalizedToolName, input.args);
    state.toolStrategyByCallId.set(input.toolCallId, strategy);

    if (strategy === "neutral") {
      return;
    }

    if (isToolResultPass(verdict) && strategy === "progress") {
      if (state.armedReason !== null) {
        this.resetScanGuard(input.sessionId, state, "strategy_shift", strategy);
      }
      state.currentTurnConvergenceToolCalls += 1;
      state.consecutiveScanFailures = 0;
      return;
    }

    if (strategy !== "raw_scan") {
      return;
    }
    if (isToolResultPass(verdict)) {
      state.consecutiveScanFailures = 0;
      return;
    }
    if (!isToolResultFail(verdict)) {
      return;
    }

    const failureKind = classifyScanFailure(input.outputText);
    if (!failureKind) {
      return;
    }

    state.consecutiveScanFailures += 1;
    if (state.consecutiveScanFailures >= CONSECUTIVE_SCAN_FAILURES_THRESHOLD) {
      this.armScanGuard(input.sessionId, state, "scan_failures");
    }
  }

  pollTaskProgress(input: PollTaskProgressInput): void {
    const taskState = this.getTaskState(input.sessionId);
    const eligibility = evaluateTaskWatchdogEligibility(taskState);
    if (!eligibility.eligible || !eligibility.phase) {
      return;
    }

    const taskEvents = this.listEvents(input.sessionId, { type: TASK_EVENT_TYPE });
    const lastVerificationAt =
      this.listEvents(input.sessionId, {
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        last: 1,
      })[0]?.timestamp ?? null;
    const baselineProgressAt = computeTaskSemanticProgressAt({
      state: taskState,
      taskEvents,
      lastVerificationAt,
    });
    if (baselineProgressAt === null) {
      return;
    }

    const thresholdPolicy = createThresholdPolicy(input.thresholdsMs);
    const thresholdMs = thresholdPolicy[eligibility.phase];
    const detectedAt = input.now ?? Date.now();
    const idleMs = Math.max(0, detectedAt - baselineProgressAt);
    if (idleMs < thresholdMs) {
      return;
    }

    const suppressedBy = eligibility.suppressedByBlockerId ?? null;
    if (suppressedBy === SCAN_CONVERGENCE_BLOCKER_ID && eligibility.hasWatchdogBlocker) {
      this.resolveTaskBlocker(input.sessionId, WATCHDOG_BLOCKER_ID);
    }
    const detectionKey = buildDetectionKey({
      phase: eligibility.phase,
      baselineProgressAt,
      suppressedBy,
    });
    if (this.taskDetectionKeyBySession.get(input.sessionId) === detectionKey) {
      return;
    }

    const latestDetected = this.listEvents(input.sessionId, {
      type: TASK_STUCK_DETECTED_EVENT_TYPE,
      last: 1,
    })[0];
    const latestPayload = coerceTaskStuckDetectedPayload(latestDetected?.payload);
    if (
      latestPayload &&
      buildDetectionKey({
        phase: latestPayload.phase,
        baselineProgressAt: latestPayload.baselineProgressAt,
        suppressedBy: latestPayload.suppressedBy,
      }) === detectionKey
    ) {
      this.taskDetectionKeyBySession.set(input.sessionId, detectionKey);
      return;
    }

    let blockerWritten = false;
    if (!suppressedBy && !eligibility.hasWatchdogBlocker) {
      const result = this.recordTaskBlocker(input.sessionId, {
        id: WATCHDOG_BLOCKER_ID,
        message: buildTaskStuckBlockerMessage({
          phase: eligibility.phase,
          idleMs,
          thresholdMs,
          baselineProgressAt,
          openItemCount: getTaskWatchdogOpenItemCount(taskState),
        }),
        source: WATCHDOG_BLOCKER_SOURCE,
      });
      blockerWritten = result.ok;
    }

    const detectedPayload = buildTaskStuckDetectedPayload({
      phase: eligibility.phase,
      thresholdMs,
      baselineProgressAt,
      detectedAt,
      idleMs,
      openItemCount: getTaskWatchdogOpenItemCount(taskState),
      blockerId: blockerWritten ? WATCHDOG_BLOCKER_ID : null,
      blockerWritten,
      suppressedBy,
    });

    this.recordEvent({
      sessionId: input.sessionId,
      type: TASK_STUCK_DETECTED_EVENT_TYPE,
      turn: this.getCurrentTurn(input.sessionId),
      payload: toTaskWatchdogEventPayload(detectedPayload),
    });
    this.taskDetectionKeyBySession.set(input.sessionId, detectionKey);
  }

  private maybeClearTaskProgressStall(sessionId: string): void {
    const taskState = this.getTaskState(sessionId);
    const watchdogBlocker = getTaskWatchdogBlocker(taskState);
    if (!watchdogBlocker) {
      return;
    }

    const taskEvents = this.listEvents(sessionId, { type: TASK_EVENT_TYPE });
    const lastVerificationAt =
      this.listEvents(sessionId, {
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        last: 1,
      })[0]?.timestamp ?? null;
    const semanticProgressAt = computeTaskSemanticProgressAt({
      state: taskState,
      taskEvents,
      lastVerificationAt,
    });
    if (semanticProgressAt === null || semanticProgressAt <= watchdogBlocker.createdAt) {
      return;
    }

    const resolved = this.resolveTaskBlocker(sessionId, WATCHDOG_BLOCKER_ID);
    if (!resolved.ok) {
      return;
    }
    const clearedAt = Date.now();
    const clearedPayload = buildTaskStuckClearedPayload({
      phase: resolveTaskWatchdogPhase(taskState) ?? "investigate",
      blockerId: WATCHDOG_BLOCKER_ID,
      detectedAt: watchdogBlocker.createdAt,
      clearedAt,
      resumedProgressAt: semanticProgressAt,
      openItemCount: getTaskWatchdogOpenItemCount(taskState),
    });

    this.recordEvent({
      sessionId,
      type: TASK_STUCK_CLEARED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      timestamp: clearedAt,
      payload: toTaskWatchdogEventPayload(clearedPayload),
    });
    this.taskDetectionKeyBySession.delete(sessionId);
  }

  private getScanState(sessionId: string): ScanConvergenceRuntimeState {
    const cell = this.sessionState.getCell(sessionId);
    const existing = cell.scanConvergence;
    if (existing) {
      if (!cell.scanConvergenceHydrated) {
        this.hydrateScanState(sessionId, existing);
      }
      return existing;
    }

    const created = EMPTY_STATE();
    cell.scanConvergence = created;
    this.hydrateScanState(sessionId, created);
    return created;
  }

  private hydrateScanState(sessionId: string, state: ScanConvergenceRuntimeState): void {
    const cell = this.sessionState.getCell(sessionId);
    if (cell.scanConvergenceHydrated) {
      return;
    }
    cell.scanConvergenceHydrated = true;

    const blocker = hasActiveGuardBlocker(this.getTaskState(sessionId));
    if (!blocker) {
      return;
    }

    const armedPayload = this.readLatestEventPayload(sessionId, SCAN_CONVERGENCE_ARMED_EVENT_TYPE);
    const blockedPayload = this.readLatestEventPayload(
      sessionId,
      SCAN_CONVERGENCE_BLOCKED_EVENT_TYPE,
    );
    const sourcePayload = armedPayload ?? blockedPayload;
    const reason =
      normalizeReason(sourcePayload?.reason) ??
      normalizeReason(blockedPayload?.reason) ??
      inferReasonFromBlocker(blocker);
    if (!reason) {
      return;
    }

    state.armedReason = reason;
    state.consecutiveScanOnlyTurns =
      readNonNegativeInteger(sourcePayload?.consecutiveScanOnlyTurns) ||
      parseCounter(blocker.message, "consecutive_scan_only_turns");
    state.consecutiveInvestigationOnlyTurns =
      readNonNegativeInteger(sourcePayload?.consecutiveInvestigationOnlyTurns) ||
      parseCounter(blocker.message, "consecutive_investigation_only_turns");
    state.consecutiveScanFailures =
      readNonNegativeInteger(sourcePayload?.consecutiveScanFailures) ||
      parseCounter(blocker.message, "consecutive_scan_failures");
  }

  private readLatestEventPayload(
    sessionId: string,
    type: string,
  ): Record<string, unknown> | undefined {
    const event = this.listEvents(sessionId, { type, last: 1 })[0];
    if (!event?.payload || typeof event.payload !== "object") {
      return undefined;
    }
    return event.payload as Record<string, unknown>;
  }

  private armScanGuard(
    sessionId: string,
    state: ScanConvergenceRuntimeState,
    reason: ScanConvergenceReason,
  ): void {
    if (state.armedReason !== null) {
      return;
    }
    state.armedReason = reason;

    this.recordTaskBlocker(sessionId, {
      id: SCAN_CONVERGENCE_BLOCKER_ID,
      message: buildTaskBlockerMessage(reason, state),
      source: GUARD_BLOCKER_SOURCE,
    });
    this.recordEvent({
      sessionId,
      type: SCAN_CONVERGENCE_ARMED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        reason,
        summary: buildArmSummary(reason),
        consecutiveScanOnlyTurns: state.consecutiveScanOnlyTurns,
        consecutiveInvestigationOnlyTurns: state.consecutiveInvestigationOnlyTurns,
        consecutiveScanFailures: state.consecutiveScanFailures,
        blockedStrategy: "low_signal_investigation",
        blockedTools: listBlockedScanConvergenceTools(),
        recommendedStrategyTools: [
          "task_set_spec",
          "task_add_item",
          "task_record_blocker",
          "task_view_state",
          "output_search",
          "ledger_query",
          "tape_search",
          "tape_handoff",
        ],
        requiredAction: "staged_conclusion_required",
        thresholds: {
          scanOnlyTurns: CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD,
          investigationOnlyTurns: CONSECUTIVE_INVESTIGATION_ONLY_TURNS_THRESHOLD,
          scanFailures: CONSECUTIVE_SCAN_FAILURES_THRESHOLD,
        },
      },
    });
  }

  private resetScanGuard(
    sessionId: string,
    state: ScanConvergenceRuntimeState,
    reason: ScanConvergenceResetReason,
    toolStrategy?: ScanConvergenceToolStrategy,
  ): void {
    if (state.armedReason !== null) {
      this.recordEvent({
        sessionId,
        type: SCAN_CONVERGENCE_RESET_EVENT_TYPE,
        turn: this.getCurrentTurn(sessionId),
        payload: {
          reason,
          previousReason: state.armedReason,
          toolStrategy: toolStrategy ?? null,
          consecutiveScanOnlyTurns: state.consecutiveScanOnlyTurns,
          consecutiveInvestigationOnlyTurns: state.consecutiveInvestigationOnlyTurns,
          consecutiveScanFailures: state.consecutiveScanFailures,
        },
      });
      this.resolveTaskBlocker(sessionId, SCAN_CONVERGENCE_BLOCKER_ID);
    }

    state.consecutiveScanOnlyTurns = 0;
    state.consecutiveInvestigationOnlyTurns = 0;
    state.consecutiveScanFailures = 0;
    state.armedReason = null;
    this.clearTurnState(state);
  }

  private clearTurnState(state: ScanConvergenceRuntimeState): void {
    state.currentTurnRawScanToolCalls = 0;
    state.currentTurnLowSignalToolCalls = 0;
    state.currentTurnConvergenceToolCalls = 0;
    state.toolStrategyByCallId.clear();
  }
}
