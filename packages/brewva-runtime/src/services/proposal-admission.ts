import {
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  PROPOSAL_DECIDED_EVENT_TYPE,
  PROPOSAL_RECEIVED_EVENT_TYPE,
} from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type { SkillRegistry } from "../skills/registry.js";
import type {
  BrewvaEventRecord,
  ContextPacketProposalPayload,
  DecisionReceipt,
  EvidenceRef,
  ProposalDecision,
  ProposalEnvelope,
  ProposalKind,
  ProposalListQuery,
  ProposalPayloadByKind,
  ProposalRecord,
} from "../types.js";
import { commitContextPacketProposal } from "./proposal-admission-context-packet.js";
import {
  commitEffectCommitmentProposal,
  type AuthorizeEffectCommitmentInput,
  type EffectCommitmentAuthorizationDecision,
} from "./proposal-admission-effect-commitment.js";
import { commitSkillSelectionProposal } from "./proposal-admission-skill-selection.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";

const RESERVED_PROPOSAL_ISSUER_POLICIES = {
  "brewva.skill-broker": {
    skill_selection: {
      requiredEvidenceSourceTypes: ["broker_trace"],
    },
  },
  "brewva.extensions.debug-loop": {
    context_packet: {
      requiredEvidenceSourceTypes: ["event", "workspace_artifact", "operator_note"],
      requirePacketKey: true,
      requireScopeId: true,
      requireExpiresAt: true,
      requireProfile: "status_summary",
    },
  },
  "brewva.extensions.memory-curator": {
    context_packet: {
      requiredEvidenceSourceTypes: ["workspace_artifact"],
      requirePacketKey: true,
      requireExpiresAt: true,
    },
  },
} as const;

export interface ProposalAdmissionServiceOptions {
  listDecisionReceiptEvents: (sessionId: string) => BrewvaEventRecord[];
  recordEvent: RuntimeKernelContext["recordEvent"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  skillRegistry: Pick<SkillRegistry, "get">;
  skillLifecycleService: Pick<
    SkillLifecycleService,
    "setPendingDispatch" | "listProducedOutputKeys"
  >;
  effectCommitmentAuthorizer: (
    input: AuthorizeEffectCommitmentInput,
  ) => EffectCommitmentAuthorizationDecision;
}

export class ProposalAdmissionService {
  private readonly listDecisionReceiptEvents: (sessionId: string) => BrewvaEventRecord[];
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getSkill: (name: string) => ReturnType<SkillRegistry["get"]>;
  private readonly setPendingDispatch: (
    sessionId: string,
    decision: Parameters<SkillLifecycleService["setPendingDispatch"]>[1],
  ) => void;
  private readonly listProducedOutputKeys: (sessionId: string) => string[];
  private readonly authorizeEffectCommitment: (
    input: AuthorizeEffectCommitmentInput,
  ) => EffectCommitmentAuthorizationDecision;

  constructor(options: ProposalAdmissionServiceOptions) {
    this.listDecisionReceiptEvents = (sessionId) => options.listDecisionReceiptEvents(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getSkill = (name) => options.skillRegistry.get(name);
    this.setPendingDispatch = (sessionId, decision) =>
      options.skillLifecycleService.setPendingDispatch(sessionId, decision, { emitEvent: true });
    this.listProducedOutputKeys = (sessionId) =>
      options.skillLifecycleService.listProducedOutputKeys(sessionId);
    this.authorizeEffectCommitment = (input) => options.effectCommitmentAuthorizer(input);
  }

  submitProposal<K extends ProposalKind>(
    sessionId: string,
    proposal: ProposalEnvelope<K>,
  ): DecisionReceipt {
    const normalizedProposal = this.normalizeProposalEnvelope(proposal);
    const turn = this.getCurrentTurn(sessionId);

    this.recordEvent({
      sessionId,
      type: PROPOSAL_RECEIVED_EVENT_TYPE,
      turn,
      payload: {
        proposalId: normalizedProposal.id,
        kind: normalizedProposal.kind,
        issuer: normalizedProposal.issuer,
        subject: normalizedProposal.subject,
        evidenceCount: normalizedProposal.evidenceRefs.length,
        expiresAt: normalizedProposal.expiresAt ?? null,
      },
    });

    const receipt = this.decideProposal(sessionId, normalizedProposal, turn);

    this.recordEvent({
      sessionId,
      type: PROPOSAL_DECIDED_EVENT_TYPE,
      turn: receipt.turn,
      payload: {
        proposalId: normalizedProposal.id,
        kind: normalizedProposal.kind,
        decision: receipt.decision,
        policyBasis: [...receipt.policyBasis],
        reasons: [...receipt.reasons],
      },
    });
    this.recordEvent({
      sessionId,
      type: DECISION_RECEIPT_RECORDED_EVENT_TYPE,
      turn: receipt.turn,
      payload: {
        proposal: normalizedProposal,
        receipt,
      },
    });

    return structuredClone(receipt);
  }

  listProposalRecords(sessionId: string, query: ProposalListQuery = {}): ProposalRecord[] {
    const records = this.listDecisionReceiptEvents(sessionId)
      .map((event) => this.readProposalRecord(event.payload))
      .filter((record): record is ProposalRecord => record !== null)
      .filter((record) => (query.kind ? record.proposal.kind === query.kind : true))
      .filter((record) => (query.decision ? record.receipt.decision === query.decision : true))
      .toSorted((left, right) => {
        if (right.receipt.timestamp !== left.receipt.timestamp) {
          return right.receipt.timestamp - left.receipt.timestamp;
        }
        if (right.proposal.createdAt !== left.proposal.createdAt) {
          return right.proposal.createdAt - left.proposal.createdAt;
        }
        return right.proposal.id.localeCompare(left.proposal.id);
      });

    if (typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
      return records.slice(0, Math.floor(query.limit)).map((record) => structuredClone(record));
    }
    return records.map((record) => structuredClone(record));
  }

  getLatestProposalRecord(
    sessionId: string,
    kind: ProposalKind,
    decision?: ProposalDecision,
  ): ProposalRecord | undefined {
    return this.listProposalRecords(sessionId, { kind, decision, limit: 1 })[0];
  }

  listInjectableContextPackets(
    sessionId: string,
    injectionScopeId?: string,
    now = Date.now(),
  ): ProposalRecord<"context_packet">[] {
    const seenKeys = new Set<string>();
    const records = this.listProposalRecords(sessionId, {
      kind: "context_packet",
      decision: "accept",
    }) as ProposalRecord<"context_packet">[];
    const effective: ProposalRecord<"context_packet">[] = [];

    for (const record of records) {
      const scopeId = record.proposal.payload.scopeId;
      if (scopeId && scopeId !== injectionScopeId) {
        continue;
      }
      if (typeof record.proposal.expiresAt === "number" && record.proposal.expiresAt < now) {
        continue;
      }
      const packetKey = record.proposal.payload.packetKey;
      const action = record.proposal.payload.action ?? "upsert";
      if (packetKey) {
        const dedupeKey = `${record.proposal.issuer}:${scopeId ?? "global"}:${packetKey}`;
        if (seenKeys.has(dedupeKey)) {
          continue;
        }
        seenKeys.add(dedupeKey);
        if (action === "revoke") {
          continue;
        }
      }
      if (action === "revoke") {
        continue;
      }
      effective.push(record);
    }

    return effective.map((record) => structuredClone(record));
  }

  private readProposalRecord(payload: unknown): ProposalRecord | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const candidate = payload as { proposal?: ProposalEnvelope; receipt?: DecisionReceipt };
    if (!candidate.proposal || !candidate.receipt) {
      return null;
    }
    return {
      proposal: structuredClone(candidate.proposal),
      receipt: structuredClone(candidate.receipt),
    };
  }

  private normalizeProposalEnvelope<K extends ProposalKind>(
    proposal: ProposalEnvelope<K>,
  ): ProposalEnvelope<K> {
    const contextPacketPayload =
      proposal.kind === "context_packet"
        ? (proposal.payload as ProposalEnvelope<"context_packet">["payload"])
        : null;
    const normalizedPayload = contextPacketPayload
      ? ({
          ...contextPacketPayload,
          label: contextPacketPayload.label.trim(),
          content: contextPacketPayload.content.trim(),
          scopeId:
            typeof contextPacketPayload.scopeId === "string" &&
            contextPacketPayload.scopeId.trim().length > 0
              ? contextPacketPayload.scopeId.trim()
              : undefined,
          packetKey:
            typeof contextPacketPayload.packetKey === "string" &&
            contextPacketPayload.packetKey.trim().length > 0
              ? contextPacketPayload.packetKey.trim()
              : undefined,
          action: contextPacketPayload.action === "revoke" ? "revoke" : "upsert",
          profile: contextPacketPayload.profile === "status_summary" ? "status_summary" : undefined,
        } satisfies ProposalEnvelope<"context_packet">["payload"])
      : proposal.payload;
    return {
      ...proposal,
      id: proposal.id.trim(),
      issuer: proposal.issuer.trim(),
      subject: proposal.subject.trim(),
      payload: normalizedPayload as ProposalPayloadByKind[K],
      evidenceRefs: this.normalizeEvidenceRefs(proposal.evidenceRefs),
      confidence:
        typeof proposal.confidence === "number" && Number.isFinite(proposal.confidence)
          ? Math.max(0, Math.min(1, proposal.confidence))
          : undefined,
      expiresAt:
        typeof proposal.expiresAt === "number" && Number.isFinite(proposal.expiresAt)
          ? Math.max(0, Math.floor(proposal.expiresAt))
          : undefined,
      createdAt: Math.max(0, Math.floor(proposal.createdAt)),
    };
  }

  private normalizeEvidenceRefs(evidenceRefs: EvidenceRef[]): EvidenceRef[] {
    return evidenceRefs
      .filter(
        (entry) =>
          typeof entry.id === "string" &&
          entry.id.trim().length > 0 &&
          typeof entry.sourceType === "string" &&
          entry.sourceType.trim().length > 0 &&
          typeof entry.locator === "string" &&
          entry.locator.trim().length > 0 &&
          typeof entry.createdAt === "number" &&
          Number.isFinite(entry.createdAt),
      )
      .map((entry) => ({
        id: entry.id.trim(),
        sourceType: entry.sourceType,
        locator: entry.locator.trim(),
        hash:
          typeof entry.hash === "string" && entry.hash.trim().length > 0 ? entry.hash : undefined,
        createdAt: Math.max(0, Math.floor(entry.createdAt)),
      }));
  }

  private decideProposal(
    sessionId: string,
    proposal: ProposalEnvelope,
    turn: number,
  ): DecisionReceipt {
    if (!proposal.id || !proposal.issuer || !proposal.subject) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["proposal_shape"],
        ["proposal_missing_required_identity_fields"],
        turn,
      );
    }
    if (proposal.evidenceRefs.length === 0) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["evidence_required"],
        ["proposal_missing_evidence"],
        turn,
      );
    }
    if (typeof proposal.expiresAt === "number" && proposal.expiresAt < Date.now()) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["proposal_ttl"],
        ["proposal_expired"],
        turn,
      );
    }
    const issuerPolicyDecision = this.validateReservedProposalIssuerPolicy(proposal, turn);
    if (issuerPolicyDecision) {
      return issuerPolicyDecision;
    }

    if (proposal.kind === "skill_selection") {
      return commitSkillSelectionProposal({
        sessionId,
        proposal: proposal as ProposalEnvelope<"skill_selection">,
        turn,
        getSkill: (name) => this.getSkill(name),
        setPendingDispatch: (nextSessionId, decision) =>
          this.setPendingDispatch(nextSessionId, decision),
        listProducedOutputKeys: (nextSessionId) => this.listProducedOutputKeys(nextSessionId),
        buildDecisionReceipt: (
          nextProposal,
          decision,
          policyBasis,
          reasons,
          nextTurn,
          committedEffects = [],
        ) =>
          this.buildDecisionReceipt(
            nextProposal,
            decision,
            policyBasis,
            reasons,
            nextTurn,
            committedEffects,
          ),
      });
    }
    if (proposal.kind === "effect_commitment") {
      return commitEffectCommitmentProposal({
        sessionId,
        proposal: proposal as ProposalEnvelope<"effect_commitment">,
        turn,
        buildDecisionReceipt: (
          nextProposal,
          decision,
          policyBasis,
          reasons,
          nextTurn,
          committedEffects = [],
        ) =>
          this.buildDecisionReceipt(
            nextProposal,
            decision,
            policyBasis,
            reasons,
            nextTurn,
            committedEffects,
          ),
        authorize: (input) => this.authorizeEffectCommitment(input),
      });
    }
    return commitContextPacketProposal({
      proposal: proposal as ProposalEnvelope<"context_packet">,
      turn,
      buildDecisionReceipt: (
        nextProposal,
        decision,
        policyBasis,
        reasons,
        nextTurn,
        committedEffects = [],
      ) =>
        this.buildDecisionReceipt(
          nextProposal,
          decision,
          policyBasis,
          reasons,
          nextTurn,
          committedEffects,
        ),
    });
  }

  private buildDecisionReceipt(
    proposal: ProposalEnvelope,
    decision: ProposalDecision,
    policyBasis: string[],
    reasons: string[],
    turn: number,
    committedEffects: DecisionReceipt["committedEffects"] = [],
  ): DecisionReceipt {
    return {
      proposalId: proposal.id,
      decision,
      policyBasis,
      reasons,
      committedEffects,
      evidenceRefs: structuredClone(proposal.evidenceRefs),
      turn,
      timestamp: Date.now(),
    };
  }

  private validateReservedProposalIssuerPolicy(
    proposal: ProposalEnvelope,
    turn: number,
  ): DecisionReceipt | null {
    const issuerPolicy =
      RESERVED_PROPOSAL_ISSUER_POLICIES[
        proposal.issuer as keyof typeof RESERVED_PROPOSAL_ISSUER_POLICIES
      ];
    if (!issuerPolicy) {
      return null;
    }
    const kindPolicy = issuerPolicy[proposal.kind as keyof typeof issuerPolicy] as
      | {
          requiredEvidenceSourceTypes?: readonly string[];
          requirePacketKey?: boolean;
          requireScopeId?: boolean;
          requireExpiresAt?: boolean;
          requireProfile?: string;
        }
      | undefined;
    if (!kindPolicy) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["issuer_policy"],
        [`reserved_issuer_kind_disallowed:${proposal.issuer}:${proposal.kind}`],
        turn,
      );
    }
    const requiredEvidenceSourceTypes = kindPolicy.requiredEvidenceSourceTypes;
    if (
      requiredEvidenceSourceTypes &&
      !proposal.evidenceRefs.some((entry) => requiredEvidenceSourceTypes.includes(entry.sourceType))
    ) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["issuer_policy"],
        [
          `reserved_issuer_missing_evidence_type:${proposal.issuer}:${requiredEvidenceSourceTypes.join("|")}`,
        ],
        turn,
      );
    }
    if (proposal.kind !== "context_packet") {
      return null;
    }
    const payload = proposal.payload as ContextPacketProposalPayload;
    if (kindPolicy.requirePacketKey && !payload.packetKey) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["issuer_policy"],
        [`reserved_context_packet_missing_packet_key:${proposal.issuer}`],
        turn,
      );
    }
    if (kindPolicy.requireScopeId && !payload.scopeId) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["issuer_policy"],
        [`reserved_context_packet_missing_scope:${proposal.issuer}`],
        turn,
      );
    }
    if (kindPolicy.requireExpiresAt && typeof proposal.expiresAt !== "number") {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["issuer_policy"],
        [`reserved_context_packet_missing_expires_at:${proposal.issuer}`],
        turn,
      );
    }
    if (kindPolicy.requireProfile && payload.profile !== kindPolicy.requireProfile) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["issuer_policy"],
        [
          `reserved_context_packet_profile_required:${proposal.issuer}:${kindPolicy.requireProfile}`,
        ],
        turn,
      );
    }
    return null;
  }
}
