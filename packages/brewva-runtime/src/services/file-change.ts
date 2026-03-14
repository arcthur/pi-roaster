import { SessionCostTracker } from "../cost/tracker.js";
import {
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
} from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { FileChangeTracker } from "../state/file-change-tracker.js";
import type { PatchSet, RollbackResult, SkillDocument } from "../types.js";
import { isMutationTool } from "../verification/classifier.js";
import { buildVerificationWriteMarkedPayload } from "../verification/projector-payloads.js";
import type { LedgerService } from "./ledger.js";
import type { ReversibleMutationService } from "./reversible-mutation.js";
import { RuntimeSessionStateStore } from "./session-state.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";
import type { TrustMeterService } from "./trust-meter.js";

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
  sessionState: RuntimeKernelContext["sessionState"];
  fileChanges: RuntimeKernelContext["fileChanges"];
  costTracker: RuntimeKernelContext["costTracker"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  ledgerService: Pick<LedgerService, "recordInfrastructureRow">;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
  trustMeterService: TrustMeterService;
  reversibleMutationService: Pick<ReversibleMutationService, "markWorkspacePatchSetRolledBack">;
}

export class FileChangeService {
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly fileChanges: FileChangeTracker;
  private readonly costTracker: SessionCostTracker;
  private readonly recordInfrastructureRow: (input: {
    sessionId: string;
    tool: string;
    argsSummary: string;
    outputSummary: string;
    fullOutput?: string;
    verdict?: "pass" | "fail" | "inconclusive";
    metadata?: Record<string, unknown>;
    turn?: number;
    skill?: string | null;
  }) => string;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;
  private readonly observeRollback: (
    sessionId: string,
    input: { ok: boolean; failedPaths: number; strategy: "workspace_patchset" },
  ) => void;
  private readonly markWorkspacePatchSetRolledBack: (
    sessionId: string,
    patchSetId: string,
  ) => string | undefined;

  constructor(options: FileChangeServiceOptions) {
    this.sessionState = options.sessionState;
    this.fileChanges = options.fileChanges;
    this.costTracker = options.costTracker;
    this.recordInfrastructureRow = (input) => options.ledgerService.recordInfrastructureRow(input);
    this.getActiveSkill = (sessionId) => options.skillLifecycleService.getActiveSkill(sessionId);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.observeRollback = (sessionId, input) =>
      options.trustMeterService.observeRollbackResult({
        sessionId,
        ok: input.ok,
        failedPaths: input.failedPaths,
        strategy: input.strategy,
      });
    this.markWorkspacePatchSetRolledBack = (sessionId, patchSetId) =>
      options.reversibleMutationService.markWorkspacePatchSetRolledBack(sessionId, patchSetId);
  }

  markToolCall(sessionId: string, toolName: string): void {
    const state = this.sessionState.getCell(sessionId);
    const current = state.toolCalls;
    const next = current + 1;
    state.toolCalls = next;
    this.costTracker.recordToolCall(sessionId, {
      toolName,
      turn: this.getCurrentTurn(sessionId),
    });
    if (isMutationTool(toolName)) {
      this.recordEvent({
        sessionId,
        type: VERIFICATION_WRITE_MARKED_EVENT_TYPE,
        turn: this.getCurrentTurn(sessionId),
        payload: buildVerificationWriteMarkedPayload({
          toolName,
        }),
      });
    }
    this.recordEvent({
      sessionId,
      type: "tool_call_marked",
      turn: state.turn,
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

  trackToolCallEnd(input: TrackToolCallEndInput): PatchSet | undefined {
    const patchSet = this.fileChanges.completeToolCall({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      channelSuccess: input.channelSuccess,
    });
    if (!patchSet) return undefined;
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
    return patchSet;
  }

  rollbackLastPatchSet(sessionId: string): RollbackResult {
    return this.rollbackPatchSet(sessionId);
  }

  rollbackPatchSet(sessionId: string, patchSetId?: string): RollbackResult {
    const rollback =
      typeof patchSetId === "string" && patchSetId.trim().length > 0
        ? this.fileChanges.rollbackPatchSet(sessionId, patchSetId)
        : this.fileChanges.rollbackLast(sessionId);
    const turn = this.getCurrentTurn(sessionId);
    const mutationReceiptId =
      rollback.ok && rollback.patchSetId
        ? this.markWorkspacePatchSetRolledBack(sessionId, rollback.patchSetId)
        : undefined;
    this.observeRollback(sessionId, {
      ok: rollback.ok,
      failedPaths: rollback.failedPaths.length,
      strategy: "workspace_patchset",
    });
    this.recordEvent({
      sessionId,
      type: "rollback",
      turn,
      payload: {
        ok: rollback.ok,
        patchSetId: rollback.patchSetId ?? null,
        mutationReceiptId: mutationReceiptId ?? null,
        restoredPaths: rollback.restoredPaths,
        failedPaths: rollback.failedPaths,
        reason: rollback.reason ?? null,
      },
    });

    if (!rollback.ok) {
      return rollback;
    }

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
        mutationReceiptId: mutationReceiptId ?? null,
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
