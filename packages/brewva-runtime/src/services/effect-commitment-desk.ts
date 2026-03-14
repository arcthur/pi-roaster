import { randomUUID } from "node:crypto";
import {
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
} from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type {
  BrewvaEventRecord,
  DecideEffectCommitmentInput,
  DecideEffectCommitmentResult,
  EvidenceRef,
  PendingEffectCommitmentRequest,
  ProposalEnvelope,
} from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";
import type {
  AuthorizeEffectCommitmentInput,
  EffectCommitmentAuthorizationDecision,
} from "./proposal-admission-effect-commitment.js";

type EffectCommitmentRequestState = "pending" | "accepted" | "rejected" | "consumed";

interface EffectCommitmentRequestRecord {
  request: PendingEffectCommitmentRequest;
  proposal: ProposalEnvelope<"effect_commitment">;
  state: EffectCommitmentRequestState;
  actor?: string;
  reason?: string;
}

interface SessionDeskState {
  recordsByRequestId: Map<string, EffectCommitmentRequestRecord>;
  requestIdByProposalId: Map<string, string>;
}

function normalizeArgsSummary(value: string | undefined): string {
  return value?.trim() ?? "";
}

function clonePendingRequest(
  request: PendingEffectCommitmentRequest,
): PendingEffectCommitmentRequest {
  return {
    ...request,
    effects: [...request.effects],
    evidenceRefs: request.evidenceRefs.map((ref) => ({ ...ref })),
  };
}

function cloneProposal(
  proposal: ProposalEnvelope<"effect_commitment">,
): ProposalEnvelope<"effect_commitment"> {
  return {
    ...proposal,
    payload: {
      ...proposal.payload,
      effects: [...proposal.payload.effects],
    },
    evidenceRefs: proposal.evidenceRefs.map((ref) => ({ ...ref })),
  };
}

export interface ResumeEffectCommitmentInput {
  sessionId: string;
  requestId: string;
  toolName: string;
  toolCallId: string;
  argsSummary?: string;
}

export type ResumeEffectCommitmentResult =
  | {
      ok: true;
      requestId: string;
      proposal: ProposalEnvelope<"effect_commitment">;
    }
  | {
      ok: false;
      requestId: string;
      reason: string;
    };

export interface EffectCommitmentDeskServiceOptions {
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  listEvents: (sessionId: string) => BrewvaEventRecord[];
  recordEvent: RuntimeKernelContext["recordEvent"];
}

export class EffectCommitmentDeskService {
  private readonly getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  private readonly listEvents: (sessionId: string) => BrewvaEventRecord[];
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly states = new Map<string, SessionDeskState>();

  constructor(options: EffectCommitmentDeskServiceOptions) {
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.listEvents = (sessionId) => options.listEvents(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
  }

  authorize(input: AuthorizeEffectCommitmentInput): EffectCommitmentAuthorizationDecision {
    const state = this.getState(input.sessionId);
    const record = this.getRecordByProposalId(state, input.proposal.id);
    if (record) {
      if (record.state === "accepted") {
        record.state = "consumed";
        this.recordEvent({
          sessionId: input.sessionId,
          type: EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
          turn: input.turn,
          payload: {
            requestId: record.request.requestId,
            proposalId: record.request.proposalId,
            toolName: record.request.toolName,
            toolCallId: record.request.toolCallId,
            decision: "accept",
            actor: record.actor ?? null,
            reason: record.reason ?? null,
          },
        });
        return {
          decision: "accept",
          requestId: record.request.requestId,
          policyBasis: ["effect_commitment_operator_desk", "effect_commitment_operator_accept"],
          reasons: [`effect_commitment_operator_approved:${record.request.requestId}`],
          committedEffects: [
            {
              kind: "operator_approval",
              details: {
                requestId: record.request.requestId,
                proposalId: record.request.proposalId,
                actor: record.actor ?? null,
                reason: record.reason ?? null,
              },
            },
          ],
        };
      }
      if (record.state === "rejected") {
        return {
          decision: "reject",
          requestId: record.request.requestId,
          policyBasis: ["effect_commitment_operator_desk", "effect_commitment_operator_reject"],
          reasons: [`effect_commitment_operator_rejected:${record.request.requestId}`],
        };
      }
      if (record.state === "consumed") {
        return {
          decision: "reject",
          requestId: record.request.requestId,
          policyBasis: ["effect_commitment_operator_desk", "effect_commitment_operator_consumed"],
          reasons: [`effect_commitment_operator_approval_consumed:${record.request.requestId}`],
        };
      }
      return {
        decision: "defer",
        requestId: record.request.requestId,
        policyBasis: ["effect_commitment_operator_desk", "effect_commitment_operator_pending"],
        reasons: [`effect_commitment_pending_operator_approval:${record.request.requestId}`],
      };
    }

    const created = this.createRequestRecord(input.proposal, input.turn);
    state.recordsByRequestId.set(created.request.requestId, created);
    state.requestIdByProposalId.set(created.request.proposalId, created.request.requestId);
    this.recordEvent({
      sessionId: input.sessionId,
      type: EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
      turn: input.turn,
      payload: {
        requestId: created.request.requestId,
        proposalId: created.request.proposalId,
        toolName: created.request.toolName,
        toolCallId: created.request.toolCallId,
        subject: created.request.subject,
        posture: created.request.posture,
        effects: [...created.request.effects],
        argsSummary: created.request.argsSummary ?? null,
        defaultRisk: created.request.defaultRisk ?? null,
        proposal: cloneProposal(created.proposal),
      },
    });
    return {
      decision: "defer",
      requestId: created.request.requestId,
      policyBasis: ["effect_commitment_operator_desk", "effect_commitment_operator_pending"],
      reasons: [`effect_commitment_pending_operator_approval:${created.request.requestId}`],
    };
  }

  listPending(sessionId: string): PendingEffectCommitmentRequest[] {
    const state = this.getState(sessionId);
    return [...state.recordsByRequestId.values()]
      .filter((record) => record.state === "pending")
      .map((record) => record.request)
      .toSorted((left, right) => right.createdAt - left.createdAt)
      .map((request) => clonePendingRequest(request));
  }

  decide(
    sessionId: string,
    requestId: string,
    input: DecideEffectCommitmentInput,
  ): DecideEffectCommitmentResult {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      return { ok: false, error: "request_not_found" };
    }
    if (input.decision !== "accept" && input.decision !== "reject") {
      return { ok: false, error: "decision_required" };
    }
    const record = this.getState(sessionId).recordsByRequestId.get(normalizedRequestId);
    if (!record || record.state !== "pending") {
      return { ok: false, error: "request_not_found" };
    }

    record.state = input.decision === "accept" ? "accepted" : "rejected";
    record.actor = input.actor?.trim() || undefined;
    record.reason = input.reason?.trim() || undefined;
    this.recordEvent({
      sessionId,
      type: EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        requestId: normalizedRequestId,
        proposalId: record.request.proposalId,
        toolName: record.request.toolName,
        toolCallId: record.request.toolCallId,
        decision: input.decision,
        actor: record.actor ?? null,
        reason: record.reason ?? null,
      },
    });
    return {
      ok: true,
      request: clonePendingRequest(record.request),
      decision: input.decision,
    };
  }

  prepareResume(input: ResumeEffectCommitmentInput): ResumeEffectCommitmentResult {
    const normalizedRequestId = input.requestId.trim();
    if (!normalizedRequestId) {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: "effect_commitment_request_not_found",
      };
    }
    const record = this.getState(input.sessionId).recordsByRequestId.get(normalizedRequestId);
    if (!record) {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_request_not_found:${normalizedRequestId}`,
      };
    }

    const normalizedToolName = normalizeToolName(input.toolName);
    if (normalizedToolName !== record.request.toolName) {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_request_tool_mismatch:${normalizedRequestId}`,
      };
    }
    if (input.toolCallId.trim() !== record.request.toolCallId) {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_request_tool_call_id_mismatch:${normalizedRequestId}`,
      };
    }
    if (
      normalizeArgsSummary(input.argsSummary) !== normalizeArgsSummary(record.request.argsSummary)
    ) {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_request_args_mismatch:${normalizedRequestId}`,
      };
    }

    if (record.state === "pending") {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_pending_operator_approval:${normalizedRequestId}`,
      };
    }
    if (record.state === "rejected") {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_operator_rejected:${normalizedRequestId}`,
      };
    }
    if (record.state === "consumed") {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_operator_approval_consumed:${normalizedRequestId}`,
      };
    }

    return {
      ok: true,
      requestId: normalizedRequestId,
      proposal: cloneProposal(record.proposal),
    };
  }

  getRequestIdForProposal(sessionId: string, proposalId: string): string | undefined {
    return this.getState(sessionId).requestIdByProposalId.get(proposalId.trim());
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId);
  }

  private createRequestRecord(
    proposal: ProposalEnvelope<"effect_commitment">,
    turn: number,
  ): EffectCommitmentRequestRecord {
    return this.createHydratedRecord({
      requestId: `approval:${proposal.payload.toolName}:${randomUUID()}`,
      proposal,
      turn,
      createdAt: proposal.createdAt,
    });
  }

  private getState(sessionId: string): SessionDeskState {
    const existing = this.states.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: SessionDeskState = {
      recordsByRequestId: new Map<string, EffectCommitmentRequestRecord>(),
      requestIdByProposalId: new Map<string, string>(),
    };
    this.hydrateStateFromEvents(sessionId, created);
    this.states.set(sessionId, created);
    return created;
  }

  private getRecordByProposalId(
    state: SessionDeskState,
    proposalId: string,
  ): EffectCommitmentRequestRecord | undefined {
    const requestId = state.requestIdByProposalId.get(proposalId.trim());
    if (!requestId) {
      return undefined;
    }
    return state.recordsByRequestId.get(requestId);
  }

  private hydrateStateFromEvents(sessionId: string, state: SessionDeskState): void {
    const events = this.listEvents(sessionId);
    if (events.length === 0) {
      return;
    }

    const proposalsById = new Map<string, ProposalEnvelope<"effect_commitment">>();
    for (const event of events) {
      const proposal = this.readProposalEnvelopeFromEvent(event);
      if (proposal) {
        proposalsById.set(proposal.id, proposal);
      }
    }

    for (const event of events) {
      if (event.type === EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE) {
        const requested = this.readApprovalRequestedEvent(event, proposalsById);
        if (!requested) {
          continue;
        }
        state.recordsByRequestId.set(requested.request.requestId, requested);
        state.requestIdByProposalId.set(requested.request.proposalId, requested.request.requestId);
        continue;
      }
      if (event.type === EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE) {
        const payload = this.readDecisionEventPayload(event);
        if (!payload) {
          continue;
        }
        const record = this.ensureHydratedRecord(state, payload, event, proposalsById);
        if (!record) {
          continue;
        }
        record.state = payload.decision === "accept" ? "accepted" : "rejected";
        record.actor = payload.actor;
        record.reason = payload.reason;
        continue;
      }
      if (event.type === EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE) {
        const payload = this.readDecisionEventPayload(event);
        if (!payload) {
          continue;
        }
        const record = this.ensureHydratedRecord(state, payload, event, proposalsById);
        if (!record) {
          continue;
        }
        record.state = "consumed";
        record.actor = payload.actor;
        record.reason = payload.reason;
      }
    }
  }

  private ensureHydratedRecord(
    state: SessionDeskState,
    payload: {
      requestId: string;
      proposalId: string;
      toolName: string;
      toolCallId: string;
      actor?: string;
      reason?: string;
      decision?: "accept" | "reject";
    },
    event: BrewvaEventRecord,
    proposalsById: ReadonlyMap<string, ProposalEnvelope<"effect_commitment">>,
  ): EffectCommitmentRequestRecord | undefined {
    const existing = state.recordsByRequestId.get(payload.requestId);
    if (existing) {
      return existing;
    }
    const proposal = proposalsById.get(payload.proposalId);
    if (!proposal) {
      return undefined;
    }
    const created = this.createHydratedRecord({
      requestId: payload.requestId,
      proposal,
      turn: event.turn,
      createdAt: proposal.createdAt,
    });
    state.recordsByRequestId.set(created.request.requestId, created);
    state.requestIdByProposalId.set(created.request.proposalId, created.request.requestId);
    return created;
  }

  private readProposalEnvelopeFromEvent(
    event: BrewvaEventRecord,
  ): ProposalEnvelope<"effect_commitment"> | undefined {
    if (event.type === DECISION_RECEIPT_RECORDED_EVENT_TYPE) {
      const payload =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : null;
      return this.readProposalEnvelope(payload?.proposal);
    }
    if (event.type !== EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE) {
      return undefined;
    }
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null;
    return this.readProposalEnvelope(payload?.proposal);
  }

  private readProposalEnvelope(
    payload: unknown,
  ): ProposalEnvelope<"effect_commitment"> | undefined {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    const candidate = payload as Partial<ProposalEnvelope<"effect_commitment">>;
    if (
      candidate.kind !== "effect_commitment" ||
      typeof candidate.id !== "string" ||
      typeof candidate.issuer !== "string" ||
      typeof candidate.subject !== "string" ||
      !candidate.payload ||
      typeof candidate.payload !== "object" ||
      Array.isArray(candidate.payload) ||
      !Array.isArray(candidate.evidenceRefs) ||
      typeof candidate.createdAt !== "number"
    ) {
      return undefined;
    }
    const proposalPayload = candidate.payload;
    if (
      typeof proposalPayload.toolName !== "string" ||
      typeof proposalPayload.toolCallId !== "string" ||
      proposalPayload.posture !== "commitment" ||
      !Array.isArray(proposalPayload.effects)
    ) {
      return undefined;
    }
    const evidenceRefs = this.readEvidenceRefs(candidate.evidenceRefs);
    if (!evidenceRefs) {
      return undefined;
    }
    return {
      id: candidate.id,
      kind: "effect_commitment",
      issuer: candidate.issuer,
      subject: candidate.subject,
      payload: {
        toolName: proposalPayload.toolName,
        toolCallId: proposalPayload.toolCallId,
        posture: "commitment",
        effects: [...proposalPayload.effects],
        defaultRisk: proposalPayload.defaultRisk,
        argsSummary: proposalPayload.argsSummary,
      },
      evidenceRefs,
      confidence: candidate.confidence,
      expiresAt: candidate.expiresAt,
      createdAt: candidate.createdAt,
    };
  }

  private readEvidenceRefs(payload: unknown): EvidenceRef[] | null {
    if (!Array.isArray(payload)) {
      return null;
    }
    const refs: EvidenceRef[] = [];
    for (const entry of payload) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const ref = entry as Partial<EvidenceRef>;
      if (
        typeof ref.id !== "string" ||
        typeof ref.sourceType !== "string" ||
        typeof ref.locator !== "string" ||
        typeof ref.createdAt !== "number"
      ) {
        return null;
      }
      refs.push({
        id: ref.id,
        sourceType: ref.sourceType,
        locator: ref.locator,
        createdAt: ref.createdAt,
      });
    }
    return refs;
  }

  private readApprovalRequestedEvent(
    event: BrewvaEventRecord,
    proposalsById: ReadonlyMap<string, ProposalEnvelope<"effect_commitment">>,
  ): EffectCommitmentRequestRecord | undefined {
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null;
    if (!payload) {
      return undefined;
    }
    const requestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
    const proposalId = typeof payload.proposalId === "string" ? payload.proposalId.trim() : "";
    const toolName = typeof payload.toolName === "string" ? payload.toolName.trim() : "";
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId.trim() : "";
    if (!requestId || !proposalId || !toolName || !toolCallId) {
      return undefined;
    }
    const proposal =
      this.readProposalEnvelope(payload.proposal) ?? proposalsById.get(proposalId) ?? undefined;
    if (!proposal) {
      return undefined;
    }
    return this.createHydratedRecord({
      requestId,
      proposal,
      turn: event.turn,
      createdAt: event.timestamp,
    });
  }

  private readDecisionEventPayload(event: BrewvaEventRecord): {
    requestId: string;
    proposalId: string;
    toolName: string;
    toolCallId: string;
    actor?: string;
    reason?: string;
    decision?: "accept" | "reject";
  } | null {
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null;
    if (!payload) {
      return null;
    }
    const requestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
    const proposalId = typeof payload.proposalId === "string" ? payload.proposalId.trim() : "";
    const toolName = typeof payload.toolName === "string" ? payload.toolName.trim() : "";
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId.trim() : "";
    if (!requestId || !proposalId || !toolName || !toolCallId) {
      return null;
    }
    const actor =
      typeof payload.actor === "string" && payload.actor.trim().length > 0
        ? payload.actor.trim()
        : undefined;
    const reason =
      typeof payload.reason === "string" && payload.reason.trim().length > 0
        ? payload.reason.trim()
        : undefined;
    const decision =
      payload.decision === "accept" || payload.decision === "reject" ? payload.decision : undefined;
    return {
      requestId,
      proposalId,
      toolName,
      toolCallId,
      actor,
      reason,
      decision,
    };
  }

  private createHydratedRecord(input: {
    requestId: string;
    proposal: ProposalEnvelope<"effect_commitment">;
    turn?: number;
    createdAt: number;
  }): EffectCommitmentRequestRecord {
    const request: PendingEffectCommitmentRequest = {
      requestId: input.requestId,
      proposalId: input.proposal.id,
      toolName: input.proposal.payload.toolName,
      toolCallId: input.proposal.payload.toolCallId,
      subject: input.proposal.subject,
      posture: "commitment",
      effects: [...input.proposal.payload.effects],
      defaultRisk: input.proposal.payload.defaultRisk,
      argsSummary: input.proposal.payload.argsSummary,
      evidenceRefs: input.proposal.evidenceRefs.map((ref) => ({ ...ref })),
      turn:
        typeof input.turn === "number" && Number.isFinite(input.turn) ? Math.floor(input.turn) : 0,
      createdAt: input.createdAt,
    };
    return {
      request,
      proposal: cloneProposal(input.proposal),
      state: "pending",
    };
  }
}
