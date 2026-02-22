import {
  TASK_EVENT_TYPE,
  buildBlockerRecordedEvent,
  buildBlockerResolvedEvent,
  buildItemAddedEvent,
  buildItemUpdatedEvent,
  buildStatusSetEvent,
} from "../task/ledger.js";
import { normalizeTaskSpec } from "../task/spec.js";
import type {
  BrewvaConfig,
  ContextBudgetUsage,
  TaskHealth,
  TaskItemStatus,
  TaskPhase,
  TaskSpec,
  TaskState,
  TaskStatus,
  TruthState,
  VerificationLevel,
  VerificationReport,
} from "../types.js";
import { normalizePercent } from "../utils/token.js";
import type { RuntimeCallback } from "./callback.js";

const VERIFIER_BLOCKER_PREFIX = "verifier:" as const;

export interface TaskStatusAlignmentInput {
  sessionId: string;
  promptText: string;
  truthState: TruthState;
  usage?: ContextBudgetUsage;
}

export interface TaskServiceOptions {
  config: BrewvaConfig;
  isContextBudgetEnabled: RuntimeCallback<[], boolean>;
  getTaskState: RuntimeCallback<[sessionId: string], TaskState>;
  evaluateCompletion: RuntimeCallback<
    [sessionId: string, level?: VerificationLevel],
    VerificationReport
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

export class TaskService {
  private readonly config: BrewvaConfig;
  private readonly isContextBudgetEnabled: () => boolean;
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly evaluateCompletion: (
    sessionId: string,
    level?: VerificationLevel,
  ) => VerificationReport;
  private readonly recordEvent: TaskServiceOptions["recordEvent"];

  constructor(options: TaskServiceOptions) {
    this.config = options.config;
    this.isContextBudgetEnabled = options.isContextBudgetEnabled;
    this.getTaskState = options.getTaskState;
    this.evaluateCompletion = options.evaluateCompletion;
    this.recordEvent = options.recordEvent;
  }

  private isSameTaskStatus(left: TaskStatus | undefined, right: TaskStatus): boolean {
    if (!left) return false;
    if (left.phase !== right.phase) return false;
    if (left.health !== right.health) return false;
    if ((left.reason ?? "") !== (right.reason ?? "")) return false;

    const leftTruth = left.truthFactIds ?? [];
    const rightTruth = right.truthFactIds ?? [];
    if (leftTruth.length !== rightTruth.length) return false;
    for (let i = 0; i < leftTruth.length; i += 1) {
      if (leftTruth[i] !== rightTruth[i]) return false;
    }
    return true;
  }

  private computeTaskStatus(input: TaskStatusAlignmentInput): TaskStatus {
    const state = this.getTaskState(input.sessionId);
    const hasSpec = Boolean(state.spec);
    const blockers = state.blockers ?? [];
    const items = state.items ?? [];
    const openItems = items.filter((item) => item.status !== "done");

    const activeTruthFacts = input.truthState.facts.filter((fact) => fact.status === "active");
    const severityRank = (severity: string): number => {
      if (severity === "error") return 3;
      if (severity === "warn") return 2;
      return 1;
    };
    const truthFactIds = activeTruthFacts
      .toSorted((left, right) => {
        const severity = severityRank(right.severity) - severityRank(left.severity);
        if (severity !== 0) return severity;
        return right.lastSeenAt - left.lastSeenAt;
      })
      .slice(0, 6)
      .map((fact) => fact.id);

    let phase: TaskPhase = "align";
    let health: TaskHealth = "unknown";
    let reason: string | undefined;

    if (!hasSpec) {
      phase = "align";
      health = "needs_spec";
      reason = "task_spec_missing";
    } else if (blockers.length > 0) {
      phase = "blocked";
      const hasVerifier = blockers.some((blocker) =>
        blocker.id.startsWith(VERIFIER_BLOCKER_PREFIX),
      );
      health = hasVerifier ? "verification_failed" : "blocked";
      reason = hasVerifier ? "verification_blockers_present" : "blockers_present";
    } else if (items.length === 0) {
      phase = "investigate";
      health = "ok";
      reason = "no_task_items";
    } else if (openItems.length > 0) {
      phase = "execute";
      health = "ok";
      reason = `open_items=${openItems.length}`;
    } else {
      const desiredLevel = state.spec?.verification?.level ?? this.config.verification.defaultLevel;
      const report = this.evaluateCompletion(input.sessionId, desiredLevel);
      phase = report.passed ? "done" : "verify";
      health = report.passed ? "ok" : "verification_failed";
      reason = report.passed
        ? "verification_passed"
        : report.missingEvidence.length > 0
          ? `missing_evidence=${report.missingEvidence.join(",")}`
          : "verification_missing";
    }

    if (health === "ok") {
      const ratio = normalizePercent(input.usage?.percent, {
        tokens: input.usage?.tokens,
        contextWindow: input.usage?.contextWindow,
      });
      if (ratio !== null && this.isContextBudgetEnabled()) {
        const threshold =
          normalizePercent(this.config.infrastructure.contextBudget.compactionThresholdPercent) ??
          1;
        const hardLimit =
          normalizePercent(this.config.infrastructure.contextBudget.hardLimitPercent) ?? 1;
        if (ratio >= hardLimit || ratio >= threshold) {
          health = "budget_pressure";
          reason = ratio >= hardLimit ? "context_hard_limit_pressure" : "context_usage_pressure";
        }
      }
    }

    return {
      phase,
      health,
      reason,
      updatedAt: Date.now(),
      truthFactIds: truthFactIds.length > 0 ? truthFactIds : undefined,
    };
  }

  maybeAlignTaskStatus(input: TaskStatusAlignmentInput): void {
    const state = this.getTaskState(input.sessionId);
    const next = this.computeTaskStatus(input);
    if (this.isSameTaskStatus(state.status, next)) {
      return;
    }

    this.recordEvent({
      sessionId: input.sessionId,
      type: TASK_EVENT_TYPE,
      payload: buildStatusSetEvent(next) as unknown as Record<string, unknown>,
    });
  }

  setTaskSpec(sessionId: string, spec: TaskSpec): void {
    const normalized = normalizeTaskSpec(spec);
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "spec_set",
        spec: normalized,
      },
    });
  }

  addTaskItem(
    sessionId: string,
    input: { id?: string; text: string; status?: TaskItemStatus },
  ): { ok: boolean; itemId?: string; error?: string } {
    const text = input.text?.trim();
    if (!text) {
      return { ok: false, error: "missing_text" };
    }

    const payload = buildItemAddedEvent({
      id: input.id?.trim() || undefined,
      text,
      status: input.status,
    });
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    return { ok: true, itemId: payload.item.id };
  }

  updateTaskItem(
    sessionId: string,
    input: { id: string; text?: string; status?: TaskItemStatus },
  ): { ok: boolean; error?: string } {
    const id = input.id?.trim();
    if (!id) return { ok: false, error: "missing_id" };

    const text = input.text?.trim();
    if (!text && !input.status) {
      return { ok: false, error: "missing_patch" };
    }

    const payload = buildItemUpdatedEvent({
      id,
      text: text || undefined,
      status: input.status,
    });
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    return { ok: true };
  }

  recordTaskBlocker(
    sessionId: string,
    input: {
      id?: string;
      message: string;
      source?: string;
      truthFactId?: string;
    },
  ): { ok: boolean; blockerId?: string; error?: string } {
    const message = input.message?.trim();
    if (!message) {
      return { ok: false, error: "missing_message" };
    }

    const payload = buildBlockerRecordedEvent({
      id: input.id?.trim() || undefined,
      message,
      source: input.source?.trim() || undefined,
      truthFactId: input.truthFactId?.trim() || undefined,
    });
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    return { ok: true, blockerId: payload.blocker.id };
  }

  resolveTaskBlocker(sessionId: string, blockerId: string): { ok: boolean; error?: string } {
    const id = blockerId?.trim();
    if (!id) return { ok: false, error: "missing_id" };

    const payload = buildBlockerResolvedEvent(id);
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    return { ok: true };
  }
}
