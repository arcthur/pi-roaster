import { SessionCostTracker } from "../cost/tracker.js";
import { VERIFICATION_STATE_RESET_EVENT_TYPE } from "../events/event-types.js";
import { FileChangeTracker } from "../state/file-change-tracker.js";
import type { SkillDocument } from "../types.js";
import type { RollbackResult } from "../types.js";
import { isMutationTool } from "../verification/classifier.js";
import { VerificationGate } from "../verification/gate.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

export interface TrackToolCallInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
}

export interface TrackToolCallEndInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  channelSuccess: boolean;
}

export interface FileChangeServiceOptions {
  sessionState: RuntimeSessionStateStore;
  fileChanges: FileChangeTracker;
  costTracker: SessionCostTracker;
  verification: VerificationGate;
  recordInfrastructureRow: RuntimeCallback<
    [
      input: {
        sessionId: string;
        tool: string;
        argsSummary: string;
        outputSummary: string;
        fullOutput?: string;
        verdict?: "pass" | "fail" | "inconclusive";
        metadata?: Record<string, unknown>;
        turn?: number;
        skill?: string | null;
      },
    ],
    string
  >;
  getActiveSkill: RuntimeCallback<[sessionId: string], SkillDocument | undefined>;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
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

export class FileChangeService {
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly fileChanges: FileChangeTracker;
  private readonly costTracker: SessionCostTracker;
  private readonly verification: VerificationGate;
  private readonly recordInfrastructureRow: FileChangeServiceOptions["recordInfrastructureRow"];
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: FileChangeServiceOptions["recordEvent"];

  constructor(options: FileChangeServiceOptions) {
    this.sessionState = options.sessionState;
    this.fileChanges = options.fileChanges;
    this.costTracker = options.costTracker;
    this.verification = options.verification;
    this.recordInfrastructureRow = options.recordInfrastructureRow;
    this.getActiveSkill = options.getActiveSkill;
    this.getCurrentTurn = options.getCurrentTurn;
    this.recordEvent = options.recordEvent;
  }

  markToolCall(sessionId: string, toolName: string): void {
    const current = this.sessionState.toolCallsBySession.get(sessionId) ?? 0;
    const next = current + 1;
    this.sessionState.toolCallsBySession.set(sessionId, next);
    this.costTracker.recordToolCall(sessionId, {
      toolName,
      turn: this.getCurrentTurn(sessionId),
    });
    if (isMutationTool(toolName)) {
      this.verification.stateStore.markWrite(sessionId);
    }
    this.recordEvent({
      sessionId,
      type: "tool_call_marked",
      turn: this.sessionState.turnsBySession.get(sessionId),
      payload: {
        toolName,
        toolCalls: next,
      },
    });
  }

  trackToolCallStart(input: TrackToolCallInput): void {
    const capture = this.fileChanges.captureBeforeToolCall({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
    });
    if (capture.trackedFiles.length === 0) {
      return;
    }
    this.recordEvent({
      sessionId: input.sessionId,
      type: "file_snapshot_captured",
      turn: this.getCurrentTurn(input.sessionId),
      payload: {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        files: capture.trackedFiles,
      },
    });
  }

  trackToolCallEnd(input: TrackToolCallEndInput): void {
    const patchSet = this.fileChanges.completeToolCall({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      channelSuccess: input.channelSuccess,
    });
    if (!patchSet) return;
    this.recordEvent({
      sessionId: input.sessionId,
      type: "patch_recorded",
      turn: this.getCurrentTurn(input.sessionId),
      payload: {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        patchSetId: patchSet.id,
        changes: patchSet.changes.map((change) => ({
          path: change.path,
          action: change.action,
        })),
      },
    });
  }

  rollbackLastPatchSet(sessionId: string): RollbackResult {
    const rollback = this.fileChanges.rollbackLast(sessionId);
    const turn = this.getCurrentTurn(sessionId);
    this.recordEvent({
      sessionId,
      type: "rollback",
      turn,
      payload: {
        ok: rollback.ok,
        patchSetId: rollback.patchSetId ?? null,
        restoredPaths: rollback.restoredPaths,
        failedPaths: rollback.failedPaths,
        reason: rollback.reason ?? null,
      },
    });

    if (!rollback.ok) {
      return rollback;
    }

    this.verification.stateStore.clear(sessionId);
    this.recordEvent({
      sessionId,
      type: VERIFICATION_STATE_RESET_EVENT_TYPE,
      turn,
      payload: {
        reason: "rollback",
      },
    });
    this.recordInfrastructureRow({
      sessionId,
      turn,
      skill: this.getActiveSkill(sessionId)?.name ?? null,
      tool: "brewva_rollback",
      argsSummary: `patchSet=${rollback.patchSetId ?? "unknown"}`,
      outputSummary: `restored=${rollback.restoredPaths.length} failed=${rollback.failedPaths.length}`,
      fullOutput: JSON.stringify(rollback),
      verdict: rollback.failedPaths.length === 0 ? "pass" : "fail",
      metadata: {
        source: "rollback_tool",
        patchSetId: rollback.patchSetId ?? null,
        restoredPaths: rollback.restoredPaths,
        failedPaths: rollback.failedPaths,
      },
    });
    return rollback;
  }

  resolveUndoSessionId(preferredSessionId?: string): string | undefined {
    if (preferredSessionId && this.fileChanges.hasHistory(preferredSessionId)) {
      return preferredSessionId;
    }
    return this.fileChanges.latestSessionWithHistory();
  }
}
