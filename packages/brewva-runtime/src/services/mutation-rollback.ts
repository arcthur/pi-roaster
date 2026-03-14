import {
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
} from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { TASK_EVENT_TYPE, buildCheckpointSetEvent } from "../task/ledger.js";
import type { TaskState, ToolMutationRollbackResult } from "../types.js";
import type { FileChangeService } from "./file-change.js";
import type {
  RecordedReversibleMutation,
  ReversibleMutationService,
} from "./reversible-mutation.js";
import type { TrustMeterService } from "./trust-meter.js";

export interface MutationRollbackServiceOptions {
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  reversibleMutationService: ReversibleMutationService;
  fileChangeService: Pick<FileChangeService, "rollbackPatchSet">;
  trustMeterService: TrustMeterService;
}

function buildBaseResult(
  mutation: RecordedReversibleMutation,
  overrides: Partial<ToolMutationRollbackResult> = {},
): ToolMutationRollbackResult {
  return {
    ok: false,
    receiptId: mutation.receipt.id,
    toolName: mutation.receipt.toolName,
    strategy: mutation.receipt.strategy,
    rollbackKind: mutation.receipt.rollbackKind,
    restoredPaths: [],
    failedPaths: [],
    reason: "unsupported_rollback",
    ...overrides,
  };
}

function cloneTaskState(state: TaskState): TaskState {
  return structuredClone(state);
}

export class MutationRollbackService {
  private readonly getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly reversibleMutationService: ReversibleMutationService;
  private readonly rollbackPatchSet: (
    sessionId: string,
    patchSetId?: string,
  ) => ReturnType<FileChangeService["rollbackPatchSet"]>;
  private readonly trustMeterService: TrustMeterService;

  constructor(options: MutationRollbackServiceOptions) {
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.reversibleMutationService = options.reversibleMutationService;
    this.rollbackPatchSet = (sessionId, patchSetId) =>
      options.fileChangeService.rollbackPatchSet(sessionId, patchSetId);
    this.trustMeterService = options.trustMeterService;
  }

  rollbackLast(sessionId: string): ToolMutationRollbackResult {
    const mutation = this.reversibleMutationService.getLatestRollbackCandidate(sessionId);
    if (!mutation) {
      return {
        ok: false,
        restoredPaths: [],
        failedPaths: [],
        reason: "no_mutation_receipt",
      };
    }

    let result: ToolMutationRollbackResult;
    if (mutation.receipt.strategy === "workspace_patchset") {
      if (!mutation.patchSetId) {
        result = buildBaseResult(mutation, {
          ok: false,
          restoredPaths: [],
          failedPaths: [],
          reason: "no_patchset",
        });
      } else {
        const rollback = this.rollbackPatchSet(sessionId, mutation.patchSetId);
        result = buildBaseResult(mutation, {
          ok: rollback.ok,
          restoredPaths: [...rollback.restoredPaths],
          failedPaths: [...rollback.failedPaths],
          reason: rollback.reason,
        });
      }
    } else if (mutation.receipt.strategy === "task_state_journal" && mutation.beforeTaskState) {
      const turn = this.getCurrentTurn(sessionId);
      this.recordEvent({
        sessionId,
        type: TASK_EVENT_TYPE,
        turn,
        payload: buildCheckpointSetEvent(
          cloneTaskState(mutation.beforeTaskState),
        ) as unknown as Record<string, unknown>,
      });
      this.recordEvent({
        sessionId,
        type: VERIFICATION_STATE_RESET_EVENT_TYPE,
        turn,
        payload: {
          reason: "mutation_rollback",
          receiptId: mutation.receipt.id,
        },
      });
      result = buildBaseResult(mutation, {
        ok: true,
        restoredPaths: ["task_state"],
        failedPaths: [],
      });
    } else {
      result = buildBaseResult(mutation, {
        ok: false,
        restoredPaths: [],
        failedPaths: [],
        reason: "unsupported_rollback",
      });
    }

    if (result.ok) {
      this.reversibleMutationService.markRolledBack(sessionId, mutation.receipt.id);
    }

    if (mutation.receipt.strategy !== "workspace_patchset") {
      this.trustMeterService.observeRollbackResult({
        sessionId,
        ok: result.ok,
        failedPaths: result.failedPaths.length,
        strategy: mutation.receipt.strategy,
      });
    }

    this.recordEvent({
      sessionId,
      type: REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        receiptId: mutation.receipt.id,
        toolName: mutation.receipt.toolName,
        strategy: mutation.receipt.strategy,
        rollbackKind: mutation.receipt.rollbackKind,
        ok: result.ok,
        restoredPaths: [...result.restoredPaths],
        failedPaths: [...result.failedPaths],
        reason: result.reason ?? null,
      },
    });

    return result;
  }
}
