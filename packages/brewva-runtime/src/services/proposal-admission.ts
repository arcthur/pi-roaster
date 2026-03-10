import {
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  PROPOSAL_DECIDED_EVENT_TYPE,
  PROPOSAL_RECEIVED_EVENT_TYPE,
} from "../events/event-types.js";
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
  SkillDispatchDecision,
  SkillDocument,
  SkillRoutingOutcome,
  SkillSelection,
} from "../types.js";

const RESERVED_PROPOSAL_ISSUER_POLICIES = {
  "brewva.skill-broker": {
    skill_selection: {
      requiredEvidenceSourceTypes: ["broker_trace"],
    },
  },
  "brewva.extensions.debug-loop": {
    skill_chain_intent: {
      requiredEvidenceSourceTypes: ["event", "workspace_artifact", "operator_note"],
    },
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

const DEFAULT_PROPOSAL_SELECTION_LIMIT = 4;

interface RuntimeRecordEventInput {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: Record<string, unknown>;
  timestamp?: number;
  skipTapeCheckpoint?: boolean;
}

interface SkillChainIntentCommitResult {
  ok: boolean;
  reason?: string;
  intent?: {
    status: string;
    cursor: number;
    steps: Array<{ skill: string }>;
  };
}

export interface ProposalAdmissionServiceOptions {
  listDecisionReceiptEvents(sessionId: string): BrewvaEventRecord[];
  recordEvent(input: RuntimeRecordEventInput): BrewvaEventRecord | undefined;
  getCurrentTurn(sessionId: string): number;
  getSkill(name: string): SkillDocument | undefined;
  setPendingDispatch(sessionId: string, decision: SkillDispatchDecision): void;
  createExplicitIntent(
    sessionId: string,
    input: {
      steps: Array<{ skill: string; consumes?: string[]; produces?: string[]; lane?: string }>;
    },
  ): SkillChainIntentCommitResult;
  listProducedOutputKeys(sessionId: string): string[];
}

export class ProposalAdmissionService {
  private readonly listDecisionReceiptEvents: ProposalAdmissionServiceOptions["listDecisionReceiptEvents"];
  private readonly recordEvent: ProposalAdmissionServiceOptions["recordEvent"];
  private readonly getCurrentTurn: ProposalAdmissionServiceOptions["getCurrentTurn"];
  private readonly getSkill: ProposalAdmissionServiceOptions["getSkill"];
  private readonly setPendingDispatch: ProposalAdmissionServiceOptions["setPendingDispatch"];
  private readonly createExplicitIntent: ProposalAdmissionServiceOptions["createExplicitIntent"];
  private readonly listProducedOutputKeys: ProposalAdmissionServiceOptions["listProducedOutputKeys"];

  constructor(options: ProposalAdmissionServiceOptions) {
    this.listDecisionReceiptEvents = (sessionId) => options.listDecisionReceiptEvents(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getSkill = (name) => options.getSkill(name);
    this.setPendingDispatch = (sessionId, decision) =>
      options.setPendingDispatch(sessionId, decision);
    this.createExplicitIntent = (sessionId, input) =>
      options.createExplicitIntent(sessionId, input);
    this.listProducedOutputKeys = (sessionId) => options.listProducedOutputKeys(sessionId);
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

  private normalizeSkillSelections(selected: SkillSelection[]): SkillSelection[] {
    return selected
      .filter(
        (entry) =>
          typeof entry.name === "string" &&
          entry.name.trim().length > 0 &&
          typeof entry.score === "number" &&
          Number.isFinite(entry.score) &&
          entry.score > 0,
      )
      .map((entry) => ({
        name: entry.name.trim(),
        score: Math.max(1, Math.floor(entry.score)),
        reason: typeof entry.reason === "string" ? entry.reason : "",
        breakdown: Array.isArray(entry.breakdown) ? entry.breakdown : [],
      }))
      .toSorted((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.name.localeCompare(b.name);
      })
      .slice(0, DEFAULT_PROPOSAL_SELECTION_LIMIT);
  }

  private normalizeRoutingOutcome(value: unknown): SkillRoutingOutcome | undefined {
    return value === "selected" || value === "empty" || value === "failed" ? value : undefined;
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
      return this.commitSkillSelectionProposal(
        sessionId,
        proposal as ProposalEnvelope<"skill_selection">,
        turn,
      );
    }
    if (proposal.kind === "skill_chain_intent") {
      return this.commitSkillChainIntentProposal(
        sessionId,
        proposal as ProposalEnvelope<"skill_chain_intent">,
        turn,
      );
    }
    return this.commitContextPacketProposal(proposal as ProposalEnvelope<"context_packet">, turn);
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

  private commitSkillSelectionProposal(
    sessionId: string,
    proposal: ProposalEnvelope<"skill_selection">,
    turn: number,
  ): DecisionReceipt {
    const selected = this.normalizeSkillSelections(proposal.payload.selected);
    const routingOutcome = this.normalizeRoutingOutcome(proposal.payload.routingOutcome);
    if (selected.length === 0) {
      return this.buildDecisionReceipt(
        proposal,
        routingOutcome === "failed" ? "defer" : "reject",
        ["selection_candidates"],
        [routingOutcome === "failed" ? "selection_failed_without_commitment" : "selection_empty"],
        turn,
      );
    }

    const primary = selected[0]!;
    const skill = this.getSkill(primary.name);
    if (!skill) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["skill_catalog"],
        [`unknown_skill:${primary.name}`],
        turn,
      );
    }

    const decision = this.buildSkillSelectionDecision({
      sessionId,
      selected,
      routingOutcome,
      turn,
    });
    this.setPendingDispatch(sessionId, decision);

    return this.buildDecisionReceipt(
      proposal,
      "accept",
      ["skill_contract_admission", "tool_gate_ready"],
      ["skill_selection_committed"],
      turn,
      [
        {
          kind: "skill_dispatch_gate",
          details: {
            primarySkill: decision.primary?.name ?? null,
            mode: decision.mode,
            chain: [...decision.chain],
            routingOutcome: decision.routingOutcome ?? null,
          },
        },
      ],
    );
  }

  private commitSkillChainIntentProposal(
    sessionId: string,
    proposal: ProposalEnvelope<"skill_chain_intent">,
    turn: number,
  ): DecisionReceipt {
    if (proposal.payload.steps.length === 0) {
      return this.buildDecisionReceipt(proposal, "reject", ["chain_steps"], ["empty_steps"], turn);
    }
    const missingSkill = proposal.payload.steps.find((step) => !this.getSkill(step.skill.trim()));
    if (missingSkill) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["skill_catalog"],
        [`unknown_chain_skill:${missingSkill.skill}`],
        turn,
      );
    }

    const result = this.createExplicitIntent(sessionId, {
      steps: proposal.payload.steps,
    });
    if (!result.ok) {
      return this.buildDecisionReceipt(
        proposal,
        "defer",
        ["cascade_policy"],
        [result.reason ?? "cascade_intent_rejected"],
        turn,
      );
    }

    return this.buildDecisionReceipt(
      proposal,
      "accept",
      ["cascade_commitment"],
      ["skill_chain_intent_committed"],
      turn,
      [
        {
          kind: "skill_chain_intent",
          details: {
            status: result.intent?.status ?? null,
            cursor: result.intent?.cursor ?? null,
            nextSkill: result.intent?.steps[result.intent?.cursor ?? 0]?.skill ?? null,
          },
        },
      ],
    );
  }

  private commitContextPacketProposal(
    proposal: ProposalEnvelope<"context_packet">,
    turn: number,
  ): DecisionReceipt {
    const label = proposal.payload.label.trim();
    const content = proposal.payload.content.trim();
    const action = proposal.payload.action ?? "upsert";
    if (!label) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["context_packet_shape"],
        ["context_packet_missing_label"],
        turn,
      );
    }
    if (action === "revoke") {
      if (!proposal.payload.packetKey) {
        return this.buildDecisionReceipt(
          proposal,
          "reject",
          ["context_packet_shape"],
          ["context_packet_revoke_requires_packet_key"],
          turn,
        );
      }

      return this.buildDecisionReceipt(
        proposal,
        "accept",
        ["context_packet_admitted"],
        ["context_packet_revoked_for_injection"],
        turn,
        [
          {
            kind: "context_packet",
            details: {
              label,
              action,
              profile: proposal.payload.profile ?? null,
              scopeId: proposal.payload.scopeId ?? null,
              packetKey: proposal.payload.packetKey ?? null,
              expiresAt: proposal.expiresAt ?? null,
            },
          },
        ],
      );
    }
    if (!content) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["context_packet_shape"],
        ["context_packet_missing_content"],
        turn,
      );
    }

    return this.buildDecisionReceipt(
      proposal,
      "accept",
      ["context_packet_admitted"],
      ["context_packet_available_for_injection"],
      turn,
      [
        {
          kind: "context_packet",
          details: {
            label,
            action,
            profile: proposal.payload.profile ?? null,
            scopeId: proposal.payload.scopeId ?? null,
            packetKey: proposal.payload.packetKey ?? null,
            expiresAt: proposal.expiresAt ?? null,
          },
        },
      ],
    );
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

  private buildSkillSelectionDecision(input: {
    sessionId: string;
    selected: SkillSelection[];
    routingOutcome?: SkillRoutingOutcome;
    turn: number;
  }): SkillDispatchDecision {
    const primary = input.selected[0] ?? null;
    const skill = primary ? this.getSkill(primary.name) : undefined;
    const dispatch = skill?.contract.dispatch ?? {
      gateThreshold: 10,
      autoThreshold: 16,
      defaultMode: "suggest" as const,
    };
    const gateThreshold = Math.max(1, Math.floor(dispatch.gateThreshold));
    const autoThreshold = Math.max(gateThreshold, Math.floor(dispatch.autoThreshold));
    const score = primary?.score ?? 0;
    let mode: SkillDispatchDecision["mode"] = "none";
    if (primary) {
      if (score >= autoThreshold) {
        mode = "auto";
      } else if (score >= gateThreshold) {
        mode = "gate";
      } else {
        mode =
          dispatch.defaultMode === "gate" || dispatch.defaultMode === "auto"
            ? "suggest"
            : dispatch.defaultMode;
      }
    }
    const unresolvedConsumes = primary
      ? this.collectPrimaryUnresolvedConsumes(input.sessionId, primary.name)
      : [];

    return {
      mode,
      primary,
      selected: input.selected,
      chain: primary ? [primary.name] : [],
      unresolvedConsumes,
      confidence: Number(
        this.resolveSelectionConfidence(score, gateThreshold, autoThreshold).toFixed(3),
      ),
      reason: primary
        ? score >= autoThreshold
          ? `score(${score})>=auto_threshold(${autoThreshold})`
          : score >= gateThreshold
            ? `score(${score})>=gate_threshold(${gateThreshold})`
            : `score(${score})<gate_threshold(${gateThreshold})`
        : "no-skill-match",
      turn: input.turn,
      routingOutcome: input.routingOutcome,
    };
  }

  private collectPrimaryUnresolvedConsumes(sessionId: string, skillName: string): string[] {
    const skill = this.getSkill(skillName);
    if (!skill) return [];
    const availableOutputs = new Set(this.listProducedOutputKeys(sessionId));
    return [...new Set(skill.contract.requires ?? [])]
      .filter((outputName) => !availableOutputs.has(outputName))
      .toSorted((left, right) => left.localeCompare(right));
  }

  private resolveSelectionConfidence(
    score: number,
    gateThreshold: number,
    autoThreshold: number,
  ): number {
    if (score <= 0) return 0;
    if (score >= autoThreshold) {
      const extra = (score - autoThreshold) / Math.max(1, autoThreshold);
      return Math.min(1, 0.85 + extra * 0.15);
    }
    if (score >= gateThreshold) {
      const span = Math.max(1, autoThreshold - gateThreshold);
      const progress = (score - gateThreshold) / span;
      return 0.55 + Math.max(0, Math.min(1, progress)) * 0.3;
    }
    return Math.max(0.1, Math.min(0.5, score / Math.max(1, gateThreshold)));
  }
}
