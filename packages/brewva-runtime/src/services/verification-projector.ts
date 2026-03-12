import {
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
} from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type {
  BrewvaStructuredEvent,
  TruthFact,
  TruthFactSeverity,
  TruthFactStatus,
  VerificationCheckRun,
} from "../types.js";
import {
  coerceVerificationWriteMarkedPayload,
  readVerificationToolResultProjectionPayload,
} from "../verification/projector-payloads.js";
import {
  buildVerifierBlockerMessage,
  GOVERNANCE_BLOCKER_ID,
  GOVERNANCE_TRUTH_FACT_ID,
  normalizeVerifierCheckForId,
  VERIFIER_BLOCKER_PREFIX,
} from "../verification/verifier-blockers.js";
import type { EventPipelineService } from "./event-pipeline.js";
import type { TaskService } from "./task.js";
import type { TruthService } from "./truth.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type VerificationOutcomeCheckProvenance = {
  check: string;
  status: "pass" | "fail" | "skip";
  command: string | null;
  hasRun: boolean;
  freshSinceWrite: boolean;
  runTimestamp: number | null;
  ledgerId: string | null;
};

type VerificationOutcomeCheckResult = {
  name: string;
  status: "pass" | "fail" | "skip";
  evidence: string | null;
};

function coerceCheckProvenanceEntry(value: unknown): VerificationOutcomeCheckProvenance | null {
  if (!isRecord(value)) return null;
  if (value.status !== "pass" && value.status !== "fail" && value.status !== "skip") {
    return null;
  }
  const check = typeof value.check === "string" ? value.check.trim() : "";
  if (!check) return null;
  return {
    check,
    status: value.status,
    command: typeof value.command === "string" ? value.command : null,
    hasRun: value.hasRun === true,
    freshSinceWrite: value.freshSinceWrite === true,
    runTimestamp:
      typeof value.runTimestamp === "number" && Number.isFinite(value.runTimestamp)
        ? Math.max(0, Math.floor(value.runTimestamp))
        : null,
    ledgerId:
      typeof value.ledgerId === "string" && value.ledgerId.trim().length > 0
        ? value.ledgerId
        : null,
  };
}

function coerceCheckResultEntry(value: unknown): VerificationOutcomeCheckResult | null {
  if (!isRecord(value)) return null;
  if (value.status !== "pass" && value.status !== "fail" && value.status !== "skip") {
    return null;
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;
  return {
    name,
    status: value.status,
    evidence:
      typeof value.evidence === "string" && value.evidence.trim().length > 0
        ? value.evidence
        : null,
  };
}

function toFreshRun(
  provenance: VerificationOutcomeCheckProvenance | undefined,
): VerificationCheckRun | undefined {
  if (!provenance?.hasRun || !provenance.freshSinceWrite || provenance.runTimestamp === null) {
    return undefined;
  }
  return {
    timestamp: provenance.runTimestamp,
    ok: provenance.status === "pass",
    command: provenance.command ?? "",
    exitCode: null,
    durationMs: 0,
    ledgerId: provenance.ledgerId ?? undefined,
  };
}

export interface VerificationProjectorServiceOptions {
  getTaskState: RuntimeKernelContext["getTaskState"];
  getTruthState: RuntimeKernelContext["getTruthState"];
  verificationStateStore: RuntimeKernelContext["verificationGate"]["stateStore"];
  eventPipeline: Pick<EventPipelineService, "subscribeEvents">;
  taskService: Pick<TaskService, "recordTaskBlocker" | "resolveTaskBlocker">;
  truthService: Pick<TruthService, "upsertTruthFact" | "resolveTruthFact">;
}

export class VerificationProjectorService {
  private readonly getTaskState: RuntimeKernelContext["getTaskState"];
  private readonly getTruthState: RuntimeKernelContext["getTruthState"];
  private readonly stateStore: RuntimeKernelContext["verificationGate"]["stateStore"];
  private readonly recordTaskBlocker: (
    sessionId: string,
    input: { id?: string; message: string; source?: string; truthFactId?: string },
  ) => { ok: boolean; blockerId?: string; error?: string };
  private readonly resolveTaskBlocker: (
    sessionId: string,
    blockerId: string,
  ) => { ok: boolean; error?: string };
  private readonly upsertTruthFact: (
    sessionId: string,
    input: {
      id: string;
      kind: string;
      severity: TruthFactSeverity;
      summary: string;
      details?: Record<string, unknown>;
      evidenceIds?: string[];
      status?: TruthFactStatus;
    },
  ) => { ok: boolean; fact?: TruthFact; error?: string };
  private readonly resolveTruthFact: (
    sessionId: string,
    truthFactId: string,
  ) => { ok: boolean; error?: string };

  constructor(options: VerificationProjectorServiceOptions) {
    this.getTaskState = (sessionId) => options.getTaskState(sessionId);
    this.getTruthState = (sessionId) => options.getTruthState(sessionId);
    this.stateStore = options.verificationStateStore;
    this.recordTaskBlocker = (sessionId, input) =>
      options.taskService.recordTaskBlocker(sessionId, input);
    this.resolveTaskBlocker = (sessionId, blockerId) =>
      options.taskService.resolveTaskBlocker(sessionId, blockerId);
    this.upsertTruthFact = (sessionId, input) =>
      options.truthService.upsertTruthFact(sessionId, input);
    this.resolveTruthFact = (sessionId, truthFactId) =>
      options.truthService.resolveTruthFact(sessionId, truthFactId);
    options.eventPipeline.subscribeEvents((event) => {
      this.handleEvent(event);
    });
  }

  private handleEvent(event: BrewvaStructuredEvent): void {
    if (event.type === VERIFICATION_WRITE_MARKED_EVENT_TYPE) {
      const payload = coerceVerificationWriteMarkedPayload(event.payload);
      if (!payload) return;
      this.stateStore.markWriteAt(event.sessionId, event.timestamp);
      return;
    }

    if (event.type === TOOL_RESULT_RECORDED_EVENT_TYPE) {
      const payload = isRecord(event.payload) ? event.payload : null;
      const projection = readVerificationToolResultProjectionPayload(
        payload?.verificationProjection,
      );
      if (!projection) return;
      if (projection.evidence.length > 0) {
        this.stateStore.appendEvidence(event.sessionId, projection.evidence);
      }
      if (projection.checkRun) {
        this.stateStore.setCheckRun(
          event.sessionId,
          projection.checkRun.checkName,
          projection.checkRun.run,
        );
      }
      return;
    }

    if (event.type === VERIFICATION_STATE_RESET_EVENT_TYPE) {
      this.stateStore.clear(event.sessionId);
      return;
    }

    if (event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE) {
      this.syncVerificationOutcome(event.sessionId, event.payload);
      return;
    }

    if (event.type === "governance_verify_spec_failed") {
      this.applyGovernanceFailure(event.sessionId, event.payload);
      return;
    }

    if (event.type === "governance_verify_spec_passed") {
      this.applyGovernancePass(event.sessionId);
    }
  }

  private syncVerificationOutcome(sessionId: string, payload: unknown): void {
    if (!isRecord(payload)) return;
    const referenceWriteAt =
      typeof payload.referenceWriteAt === "number" && Number.isFinite(payload.referenceWriteAt)
        ? Math.max(0, Math.floor(payload.referenceWriteAt))
        : null;
    if (!referenceWriteAt) {
      return;
    }

    const provenanceEntries = Array.isArray(payload.checkProvenance)
      ? payload.checkProvenance
          .map((entry) => coerceCheckProvenanceEntry(entry))
          .filter((entry): entry is VerificationOutcomeCheckProvenance => entry !== null)
      : [];
    const provenanceByCheck = new Map(provenanceEntries.map((entry) => [entry.check, entry]));
    const checkResults = Array.isArray(payload.checkResults)
      ? payload.checkResults
          .map((entry) => coerceCheckResultEntry(entry))
          .filter((entry): entry is VerificationOutcomeCheckResult => entry !== null)
      : [];

    const taskState = this.getTaskState(sessionId);
    const existingById = new Map(taskState.blockers.map((blocker) => [blocker.id, blocker]));
    const failingIds = new Set<string>();

    for (const result of checkResults) {
      if (result.status !== "fail") continue;
      const blockerId = `${VERIFIER_BLOCKER_PREFIX}${normalizeVerifierCheckForId(result.name)}`;
      const truthFactId = `truth:verifier:${normalizeVerifierCheckForId(result.name)}`;
      const provenance = provenanceByCheck.get(result.name);
      const freshRun = toFreshRun(provenance);
      const message = buildVerifierBlockerMessage({
        checkName: result.name,
        truthFactId,
        run: freshRun,
      });
      const source = "verification_gate";
      failingIds.add(blockerId);

      const existing = existingById.get(blockerId);
      if (
        existing &&
        existing.message === message &&
        (existing.source ?? "") === source &&
        (existing.truthFactId ?? "") === truthFactId
      ) {
        continue;
      }

      const evidenceIds = freshRun?.ledgerId ? [freshRun.ledgerId] : [];
      this.upsertTruthFact(sessionId, {
        id: truthFactId,
        kind: "verification_check_failed",
        severity: "error",
        summary: `verification failed: ${result.name}`,
        evidenceIds,
        details: {
          check: result.name,
          command: freshRun?.command ?? provenance?.command ?? null,
          exitCode: freshRun?.exitCode ?? null,
          ledgerId: freshRun?.ledgerId ?? provenance?.ledgerId ?? null,
          evidence: result.evidence,
        },
      });
      this.recordTaskBlocker(sessionId, {
        id: blockerId,
        message,
        source,
        truthFactId,
      });
    }

    const truthState = this.getTruthState(sessionId);
    for (const blocker of taskState.blockers) {
      if (!blocker.id.startsWith(VERIFIER_BLOCKER_PREFIX)) continue;
      if (failingIds.has(blocker.id)) continue;
      this.resolveTaskBlocker(sessionId, blocker.id);
      const truthFactId =
        blocker.truthFactId ?? `truth:verifier:${blocker.id.slice(VERIFIER_BLOCKER_PREFIX.length)}`;
      const active = truthState.facts.find(
        (fact) => fact.id === truthFactId && fact.status === "active",
      );
      if (active) {
        this.resolveTruthFact(sessionId, truthFactId);
      }
    }
  }

  private applyGovernanceFailure(sessionId: string, payload: unknown): void {
    if (!isRecord(payload)) return;
    const level = typeof payload.level === "string" ? payload.level : null;
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    if (!reason) return;

    this.upsertTruthFact(sessionId, {
      id: GOVERNANCE_TRUTH_FACT_ID,
      kind: "governance_verify_spec_failed",
      severity: "error",
      summary: `governance verification failed: ${reason}`,
      details: {
        level,
        reason,
      },
    });
    this.recordTaskBlocker(sessionId, {
      id: GOVERNANCE_BLOCKER_ID,
      message: `governance verification failed: ${reason}`,
      source: "governance_verify_spec",
      truthFactId: GOVERNANCE_TRUTH_FACT_ID,
    });
  }

  private applyGovernancePass(sessionId: string): void {
    const truthState = this.getTruthState(sessionId);
    const active = truthState.facts.find(
      (fact) => fact.id === GOVERNANCE_TRUTH_FACT_ID && fact.status === "active",
    );
    if (active) {
      this.resolveTruthFact(sessionId, GOVERNANCE_TRUTH_FACT_ID);
    }

    const taskState = this.getTaskState(sessionId);
    if (taskState.blockers.some((blocker) => blocker.id === GOVERNANCE_BLOCKER_ID)) {
      this.resolveTaskBlocker(sessionId, GOVERNANCE_BLOCKER_ID);
    }
  }
}
