import {
  SCAN_CONVERGENCE_ADVISORY_EVENT_TYPE,
  SCAN_CONVERGENCE_ARMED_EVENT_TYPE,
  SCAN_CONVERGENCE_BLOCKED_EVENT_TYPE,
  SCAN_CONVERGENCE_RESET_EVENT_TYPE,
} from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type { ToolInvocationPosture } from "../types.js";
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
import type { TrustMeterService } from "./trust-meter.js";

const CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD = 3;
const CONSECUTIVE_INVESTIGATION_ONLY_TURNS_THRESHOLD = 6;
const CONSECUTIVE_SCAN_FAILURES_THRESHOLD = 3;

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

function readNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
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
  ].join("\n");
}

function buildAdvisoryMessage(reason: ScanConvergenceReason): string {
  const trigger =
    reason === "scan_only_turns"
      ? "Repeated read/grep-only turns are piling up."
      : reason === "investigation_only_turns"
        ? "Repeated low-signal investigation is piling up."
        : "Repeated scan failures are piling up.";
  return [
    "[ExplorationAdvisory]",
    trigger,
    "Summarize what you already know, name the missing fact, then switch strategy before broadening the scan.",
  ].join("\n");
}

export interface ExplorationDecision {
  allowed: boolean;
  reason?: string;
  advisory?: string;
}

export interface CheckExplorationToolCallInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  posture: ToolInvocationPosture;
}

export interface ObserveExplorationToolResultInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  verdict: ToolResultVerdict;
  outputText: string;
  posture: ToolInvocationPosture;
}

export interface ExplorationSupervisorServiceOptions {
  sessionState: RuntimeKernelContext["sessionState"];
  listEvents: (
    sessionId: string,
    query?: { type?: string; last?: number },
  ) => Array<{
    timestamp: number;
    payload?: Record<string, unknown>;
  }>;
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
  trustMeterService: TrustMeterService;
}

export class ExplorationSupervisorService {
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly listEvents: ExplorationSupervisorServiceOptions["listEvents"];
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkillName: (sessionId: string) => string | undefined;
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly trustMeter: TrustMeterService;

  constructor(options: ExplorationSupervisorServiceOptions) {
    this.sessionState = options.sessionState;
    this.listEvents = (sessionId, query) => options.listEvents(sessionId, query);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getActiveSkillName = (sessionId) =>
      options.skillLifecycleService.getActiveSkill(sessionId)?.name;
    this.recordEvent = (input) => options.recordEvent(input);
    this.trustMeter = options.trustMeterService;
  }

  onUserInput(sessionId: string): void {
    const state = this.getScanState(sessionId);
    this.resetScanGuard(sessionId, state, "input_reset");
  }

  onTurnEnd(sessionId: string): void {
    const state = this.getScanState(sessionId);
    const thresholdBoost = this.trustMeter.getExplorationThresholdBoost(sessionId);

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
        if (
          state.consecutiveScanOnlyTurns >=
          CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD + thresholdBoost
        ) {
          this.armScanGuard(sessionId, state, "scan_only_turns");
        }
      } else {
        state.consecutiveScanOnlyTurns = 0;
      }

      if (
        state.consecutiveInvestigationOnlyTurns >=
        CONSECUTIVE_INVESTIGATION_ONLY_TURNS_THRESHOLD + thresholdBoost
      ) {
        this.armScanGuard(sessionId, state, "investigation_only_turns");
      }
    }

    this.clearTurnState(state);
  }

  checkToolCall(input: CheckExplorationToolCallInput): ExplorationDecision {
    const state = this.getScanState(input.sessionId);
    const normalizedToolName = normalizeToolName(input.toolName);
    if (!normalizedToolName) {
      return { allowed: true };
    }

    const strategy = classifyScanConvergenceToolStrategy(normalizedToolName, input.args);
    state.toolStrategyByCallId.set(input.toolCallId, strategy);

    if (state.armedReason !== null && (strategy === "raw_scan" || strategy === "low_signal")) {
      if (input.posture === "observe") {
        const advisory = buildAdvisoryMessage(state.armedReason);
        const turn = this.getCurrentTurn(input.sessionId);
        if (this.trustMeter.shouldEmitAdvisory(input.sessionId, turn)) {
          this.recordEvent({
            sessionId: input.sessionId,
            type: SCAN_CONVERGENCE_ADVISORY_EVENT_TYPE,
            turn,
            payload: {
              toolCallId: input.toolCallId,
              toolName: normalizedToolName,
              toolStrategy: strategy,
              reason: state.armedReason,
              message: advisory,
              blockedTools: listBlockedScanConvergenceTools(),
            },
          });
          this.trustMeter.markAdvisoryEmitted(input.sessionId, turn);
        }
        if (strategy === "raw_scan") {
          state.currentTurnRawScanToolCalls += 1;
          state.currentTurnLowSignalToolCalls += 1;
        } else {
          state.currentTurnLowSignalToolCalls += 1;
        }
        return {
          allowed: true,
          advisory,
        };
      }

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
          skill: this.getActiveSkillName(input.sessionId) ?? null,
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

  observeToolResult(input: ObserveExplorationToolResultInput): void {
    const state = this.getScanState(input.sessionId);
    const normalizedToolName = normalizeToolName(input.toolName);
    if (!normalizedToolName) return;

    this.trustMeter.observeToolResult({
      sessionId: input.sessionId,
      posture: input.posture,
      verdict: input.verdict,
    });

    const strategy =
      state.toolStrategyByCallId.get(input.toolCallId) ??
      classifyScanConvergenceToolStrategy(normalizedToolName, input.args);
    state.toolStrategyByCallId.set(input.toolCallId, strategy);

    if (strategy === "neutral") {
      return;
    }

    if (isToolResultPass(input.verdict) && strategy === "progress") {
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
    if (isToolResultPass(input.verdict)) {
      state.consecutiveScanFailures = 0;
      return;
    }
    if (!isToolResultFail(input.verdict)) {
      return;
    }

    const failureKind = classifyScanFailure(input.outputText);
    if (!failureKind) {
      return;
    }

    state.consecutiveScanFailures += 1;
    const thresholdBoost = Math.min(
      1,
      this.trustMeter.getExplorationThresholdBoost(input.sessionId),
    );
    if (state.consecutiveScanFailures >= CONSECUTIVE_SCAN_FAILURES_THRESHOLD + thresholdBoost) {
      this.armScanGuard(input.sessionId, state, "scan_failures");
    }
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

    const armedEvent = this.listEvents(sessionId, {
      type: SCAN_CONVERGENCE_ARMED_EVENT_TYPE,
      last: 1,
    })[0];
    if (!armedEvent?.payload || typeof armedEvent.payload !== "object") {
      return;
    }

    const resetEvent = this.listEvents(sessionId, {
      type: SCAN_CONVERGENCE_RESET_EVENT_TYPE,
      last: 1,
    })[0];
    if (resetEvent && resetEvent.timestamp >= armedEvent.timestamp) {
      return;
    }

    const reason = normalizeReason(armedEvent.payload.reason);
    if (!reason) {
      return;
    }

    state.armedReason = reason;
    state.consecutiveScanOnlyTurns = readNonNegativeInteger(
      armedEvent.payload.consecutiveScanOnlyTurns,
    );
    state.consecutiveInvestigationOnlyTurns = readNonNegativeInteger(
      armedEvent.payload.consecutiveInvestigationOnlyTurns,
    );
    state.consecutiveScanFailures = readNonNegativeInteger(
      armedEvent.payload.consecutiveScanFailures,
    );
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
