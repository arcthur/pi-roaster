import { randomUUID } from "node:crypto";
import {
  REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
  REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
} from "../events/event-types.js";
import { getToolGovernanceDescriptor } from "../governance/tool-governance.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type {
  PatchSet,
  TaskState,
  ToolMutationReceipt,
  ToolMutationRollbackKind,
  ToolMutationStrategy,
} from "../types.js";
import { stableJsonStringify } from "../utils/json.js";
import { normalizeToolName } from "../utils/tool-name.js";

interface PendingReversibleMutation {
  receipt: ToolMutationReceipt;
  beforeTaskState?: TaskState;
}

export interface RecordedReversibleMutation {
  receipt: ToolMutationReceipt;
  changed: boolean;
  rollbackRef?: string | null;
  patchSetId?: string | null;
  beforeTaskState?: TaskState;
  afterTaskState?: TaskState;
  artifactRef?: string | null;
}

export interface PrepareReversibleMutationInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
}

export interface RecordReversibleMutationInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  channelSuccess: boolean;
  verdict?: "pass" | "fail" | "inconclusive";
  patchSet?: PatchSet;
  metadata?: Record<string, unknown>;
}

export interface ReversibleMutationServiceOptions {
  getTaskState: RuntimeKernelContext["getTaskState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
}

function cloneTaskState(state: TaskState): TaskState {
  return structuredClone(state);
}

function summarizeTaskState(state: TaskState | undefined): Record<string, unknown> | null {
  if (!state) {
    return null;
  }
  return {
    hasSpec: Boolean(state.spec),
    itemCount: state.items.length,
    blockerCount: state.blockers.length,
    phase: state.status?.phase ?? null,
    health: state.status?.health ?? null,
  };
}

function sameTaskState(left: TaskState | undefined, right: TaskState | undefined): boolean {
  return stableJsonStringify(left ?? null) === stableJsonStringify(right ?? null);
}

function resolveMutationStrategy(toolName: string): {
  strategy: ToolMutationStrategy;
  rollbackKind: ToolMutationRollbackKind;
} | null {
  const descriptor = getToolGovernanceDescriptor(toolName);
  if (!descriptor || descriptor.posture !== "reversible_mutate") {
    return null;
  }
  const normalizedToolName = normalizeToolName(toolName);
  if (descriptor.effects.includes("workspace_write")) {
    return {
      strategy: "workspace_patchset",
      rollbackKind: "patchset",
    };
  }
  if (normalizedToolName === "cognition_note") {
    return {
      strategy: "artifact_write",
      rollbackKind: "artifact_ref",
    };
  }
  if (descriptor.effects.includes("memory_write")) {
    return {
      strategy: "task_state_journal",
      rollbackKind: "task_state_replay",
    };
  }
  return {
    strategy: "generic_journal",
    rollbackKind: "none",
  };
}

function buildReceipt(input: {
  toolCallId: string;
  toolName: string;
  strategy: ToolMutationStrategy;
  rollbackKind: ToolMutationRollbackKind;
  turn: number;
  timestamp: number;
}): ToolMutationReceipt {
  const descriptor = getToolGovernanceDescriptor(input.toolName);
  return {
    id: [
      "mutation",
      normalizeToolName(input.toolName),
      input.toolCallId.trim() || randomUUID(),
      String(input.timestamp),
    ].join(":"),
    toolCallId: input.toolCallId.trim(),
    toolName: normalizeToolName(input.toolName),
    posture: "reversible_mutate",
    strategy: input.strategy,
    rollbackKind: input.rollbackKind,
    effects: [...(descriptor?.effects ?? [])],
    turn: input.turn,
    timestamp: input.timestamp,
  };
}

function readNestedRecord(
  input: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = input?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readArtifactDetails(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const details = readNestedRecord(metadata, "details");
  return {
    artifactRef:
      typeof details?.artifactRef === "string" && details.artifactRef.trim().length > 0
        ? details.artifactRef.trim()
        : null,
    fileName:
      typeof details?.fileName === "string" && details.fileName.trim().length > 0
        ? details.fileName.trim()
        : null,
    lane:
      typeof details?.lane === "string" && details.lane.trim().length > 0
        ? details.lane.trim()
        : null,
    kind:
      typeof details?.kind === "string" && details.kind.trim().length > 0
        ? details.kind.trim()
        : null,
    action:
      typeof details?.action === "string" && details.action.trim().length > 0
        ? details.action.trim()
        : null,
  };
}

export class ReversibleMutationService {
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly pendingBySession = new Map<string, Map<string, PendingReversibleMutation>>();
  private readonly recordedBySession = new Map<string, RecordedReversibleMutation[]>();
  private readonly rolledBackReceiptIdsBySession = new Map<string, Set<string>>();

  constructor(options: ReversibleMutationServiceOptions) {
    this.getTaskState = (sessionId) => options.getTaskState(sessionId);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
  }

  prepare(input: PrepareReversibleMutationInput): ToolMutationReceipt | undefined {
    const resolved = resolveMutationStrategy(input.toolName);
    if (!resolved) {
      return undefined;
    }
    const turn = this.getCurrentTurn(input.sessionId);
    const timestamp = Date.now();
    const receipt = buildReceipt({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      strategy: resolved.strategy,
      rollbackKind: resolved.rollbackKind,
      turn,
      timestamp,
    });
    const pending: PendingReversibleMutation = {
      receipt,
      beforeTaskState:
        resolved.strategy === "task_state_journal"
          ? cloneTaskState(this.getTaskState(input.sessionId))
          : undefined,
    };
    this.getPendingSession(input.sessionId).set(input.toolCallId, pending);
    this.recordEvent({
      sessionId: input.sessionId,
      type: REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
      turn,
      timestamp,
      payload: {
        receipt,
        beforeTaskSummary: summarizeTaskState(pending.beforeTaskState),
      },
    });
    return receipt;
  }

  record(input: RecordReversibleMutationInput): void {
    const pendingSession = this.pendingBySession.get(input.sessionId);
    const pending = pendingSession?.get(input.toolCallId);
    if (!pending) {
      return;
    }
    pendingSession?.delete(input.toolCallId);
    if (pendingSession && pendingSession.size === 0) {
      this.pendingBySession.delete(input.sessionId);
    }

    const basePayload: Record<string, unknown> = {
      receipt: pending.receipt,
      channelSuccess: input.channelSuccess,
      verdict: input.verdict ?? null,
      changed: false,
    };
    const recorded: RecordedReversibleMutation = {
      receipt: structuredClone(pending.receipt),
      changed: false,
    };

    if (pending.receipt.strategy === "workspace_patchset") {
      const patchSet = input.patchSet;
      basePayload.changed = Boolean(patchSet);
      basePayload.patchSetId = patchSet?.id ?? null;
      basePayload.rollbackRef = patchSet ? `patchset://${patchSet.id}` : null;
      recorded.changed = Boolean(patchSet);
      recorded.patchSetId = patchSet?.id ?? null;
      recorded.rollbackRef = patchSet ? `patchset://${patchSet.id}` : null;
      basePayload.patchChanges =
        patchSet?.changes.map((change) => ({
          path: change.path,
          action: change.action,
        })) ?? [];
    } else if (pending.receipt.strategy === "task_state_journal") {
      const afterTaskState = cloneTaskState(this.getTaskState(input.sessionId));
      basePayload.changed = !sameTaskState(pending.beforeTaskState, afterTaskState);
      basePayload.beforeTaskState = pending.beforeTaskState ?? null;
      basePayload.afterTaskState = afterTaskState;
      basePayload.beforeTaskSummary = summarizeTaskState(pending.beforeTaskState);
      basePayload.afterTaskSummary = summarizeTaskState(afterTaskState);
      basePayload.rollbackRef = `event-journal://${pending.receipt.id}`;
      recorded.changed = !sameTaskState(pending.beforeTaskState, afterTaskState);
      recorded.beforeTaskState = pending.beforeTaskState
        ? cloneTaskState(pending.beforeTaskState)
        : undefined;
      recorded.afterTaskState = cloneTaskState(afterTaskState);
      recorded.rollbackRef = `event-journal://${pending.receipt.id}`;
    } else if (pending.receipt.strategy === "artifact_write") {
      const artifactDetails = readArtifactDetails(input.metadata);
      basePayload.changed = artifactDetails.artifactRef !== null;
      basePayload.rollbackRef =
        artifactDetails.artifactRef !== null
          ? `artifact://${artifactDetails.artifactRef as string}`
          : null;
      recorded.changed = artifactDetails.artifactRef !== null;
      recorded.rollbackRef =
        artifactDetails.artifactRef !== null
          ? `artifact://${artifactDetails.artifactRef as string}`
          : null;
      recorded.artifactRef =
        typeof artifactDetails.artifactRef === "string" ? artifactDetails.artifactRef : null;
      Object.assign(basePayload, artifactDetails);
    } else {
      basePayload.rollbackRef = null;
      recorded.rollbackRef = null;
    }

    const sessionHistory = this.recordedBySession.get(input.sessionId) ?? [];
    sessionHistory.push(recorded);
    this.recordedBySession.set(input.sessionId, sessionHistory);
    this.recordEvent({
      sessionId: input.sessionId,
      type: REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
      turn: this.getCurrentTurn(input.sessionId),
      payload: basePayload,
    });
  }

  clear(sessionId: string): void {
    this.pendingBySession.delete(sessionId);
    this.recordedBySession.delete(sessionId);
    this.rolledBackReceiptIdsBySession.delete(sessionId);
  }

  getLatestRollbackCandidate(sessionId: string): RecordedReversibleMutation | undefined {
    const history = this.recordedBySession.get(sessionId);
    if (!history || history.length === 0) {
      return undefined;
    }
    const rolledBack = this.rolledBackReceiptIdsBySession.get(sessionId);
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const candidate = history[index];
      if (!candidate) {
        continue;
      }
      if (rolledBack?.has(candidate.receipt.id)) {
        continue;
      }
      if (!candidate.changed) {
        continue;
      }
      return structuredClone(candidate);
    }
    return undefined;
  }

  markRolledBack(sessionId: string, receiptId: string): void {
    const normalizedReceiptId = receiptId.trim();
    if (!normalizedReceiptId) {
      return;
    }
    const existing = this.rolledBackReceiptIdsBySession.get(sessionId) ?? new Set<string>();
    existing.add(normalizedReceiptId);
    this.rolledBackReceiptIdsBySession.set(sessionId, existing);
  }

  markWorkspacePatchSetRolledBack(sessionId: string, patchSetId: string): string | undefined {
    const normalizedPatchSetId = patchSetId.trim();
    if (!normalizedPatchSetId) {
      return undefined;
    }
    const history = this.recordedBySession.get(sessionId);
    if (!history || history.length === 0) {
      return undefined;
    }
    const rolledBack = this.rolledBackReceiptIdsBySession.get(sessionId) ?? new Set<string>();
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const candidate = history[index];
      if (!candidate) {
        continue;
      }
      if (candidate.receipt.strategy !== "workspace_patchset") {
        continue;
      }
      if (candidate.patchSetId !== normalizedPatchSetId) {
        continue;
      }
      if (rolledBack.has(candidate.receipt.id)) {
        return candidate.receipt.id;
      }
      rolledBack.add(candidate.receipt.id);
      this.rolledBackReceiptIdsBySession.set(sessionId, rolledBack);
      return candidate.receipt.id;
    }
    return undefined;
  }

  private getPendingSession(sessionId: string): Map<string, PendingReversibleMutation> {
    const existing = this.pendingBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, PendingReversibleMutation>();
    this.pendingBySession.set(sessionId, created);
    return created;
  }
}
