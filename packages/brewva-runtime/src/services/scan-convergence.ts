import { SCAN_CONVERGENCE_BLOCKER_ID } from "../task/watchdog.js";
import type { BrewvaEventQuery, BrewvaEventRecord, TaskBlocker, TaskState } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";
import {
  isToolResultFail,
  isToolResultPass,
  type ToolResultVerdict,
} from "../utils/tool-result.js";
import type { RuntimeCallback } from "./callback.js";
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

const CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD = 3;
const CONSECUTIVE_INVESTIGATION_ONLY_TURNS_THRESHOLD = 6;
const CONSECUTIVE_SCAN_FAILURES_THRESHOLD = 3;

const SCAN_CONVERGENCE_ARMED_EVENT_TYPE = "scan_convergence_armed";
const SCAN_CONVERGENCE_BLOCKED_EVENT_TYPE = "scan_convergence_blocked_tool";
const SCAN_CONVERGENCE_RESET_EVENT_TYPE = "scan_convergence_reset";

const GUARD_BLOCKER_SOURCE = "runtime.scan_convergence" as const;

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

export interface ScanConvergenceServiceOptions {
  sessionState: RuntimeSessionStateStore;
  listEvents: RuntimeCallback<[sessionId: string, query?: BrewvaEventQuery], BrewvaEventRecord[]>;
  getTaskState: RuntimeCallback<[sessionId: string], TaskState>;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  getActiveSkillName: RuntimeCallback<[sessionId: string], string | undefined>;
  recordTaskBlocker: RuntimeCallback<
    [
      sessionId: string,
      input: { id?: string; message: string; source?: string; truthFactId?: string },
    ],
    { ok: boolean; blockerId?: string; error?: string }
  >;
  resolveTaskBlocker: RuntimeCallback<
    [sessionId: string, blockerId: string],
    { ok: boolean; error?: string }
  >;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: Record<string, unknown>;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    unknown
  >;
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
    "required_next_step=Use task_add_item / task_record_blocker / task_view_state or evidence reuse tools before more low-signal retrieval.",
    "preferred_tools=task_add_item,task_record_blocker,task_view_state,output_search,ledger_query,tape_search,tape_handoff",
  ].join("\n");
}

function hasActiveGuardBlocker(state: TaskState): TaskBlocker | undefined {
  return state.blockers.find((blocker) => blocker.id === SCAN_CONVERGENCE_BLOCKER_ID);
}

export class ScanConvergenceService {
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly listEvents: ScanConvergenceServiceOptions["listEvents"];
  private readonly getTaskState: ScanConvergenceServiceOptions["getTaskState"];
  private readonly getCurrentTurn: ScanConvergenceServiceOptions["getCurrentTurn"];
  private readonly getActiveSkillName: ScanConvergenceServiceOptions["getActiveSkillName"];
  private readonly recordTaskBlocker: ScanConvergenceServiceOptions["recordTaskBlocker"];
  private readonly resolveTaskBlocker: ScanConvergenceServiceOptions["resolveTaskBlocker"];
  private readonly recordEvent: ScanConvergenceServiceOptions["recordEvent"];

  constructor(options: ScanConvergenceServiceOptions) {
    this.sessionState = options.sessionState;
    this.listEvents = options.listEvents;
    this.getTaskState = options.getTaskState;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getActiveSkillName = options.getActiveSkillName;
    this.recordTaskBlocker = options.recordTaskBlocker;
    this.resolveTaskBlocker = options.resolveTaskBlocker;
    this.recordEvent = options.recordEvent;
  }

  onUserInput(sessionId: string): void {
    const state = this.getState(sessionId);
    this.resetGuard(sessionId, state, "input_reset");
  }

  onTurnEnd(sessionId: string): void {
    const state = this.getState(sessionId);

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
          this.armGuard(sessionId, state, "scan_only_turns");
        }
      } else {
        state.consecutiveScanOnlyTurns = 0;
      }

      if (
        state.consecutiveInvestigationOnlyTurns >= CONSECUTIVE_INVESTIGATION_ONLY_TURNS_THRESHOLD
      ) {
        this.armGuard(sessionId, state, "investigation_only_turns");
      }
    }

    this.clearTurnState(state);
  }

  checkToolCall(input: CheckScanConvergenceToolCallInput): ScanConvergenceDecision {
    const state = this.getState(input.sessionId);
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
    const state = this.getState(input.sessionId);
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

    if (isToolResultPass(verdict) && strategy !== "raw_scan" && strategy !== "low_signal") {
      if (state.armedReason !== null) {
        this.resetGuard(input.sessionId, state, "strategy_shift", strategy);
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
      this.armGuard(input.sessionId, state, "scan_failures");
    }
  }

  private getState(sessionId: string): ScanConvergenceRuntimeState {
    const existing = this.sessionState.scanConvergenceBySession.get(sessionId);
    if (existing) {
      if (!this.sessionState.scanConvergenceHydratedBySession.has(sessionId)) {
        this.hydrateState(sessionId, existing);
      }
      return existing;
    }

    const created = EMPTY_STATE();
    this.sessionState.scanConvergenceBySession.set(sessionId, created);
    this.hydrateState(sessionId, created);
    return created;
  }

  private hydrateState(sessionId: string, state: ScanConvergenceRuntimeState): void {
    if (this.sessionState.scanConvergenceHydratedBySession.has(sessionId)) {
      return;
    }
    this.sessionState.scanConvergenceHydratedBySession.add(sessionId);

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

  private armGuard(
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

  private resetGuard(
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
