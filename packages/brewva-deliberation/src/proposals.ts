import type {
  BrewvaRuntime,
  ContextPacketAction,
  ContextPacketProfile,
  DecisionReceipt,
  EvidenceRef,
  EvidenceSourceType,
  ProposalEnvelope,
  ProposalKind,
  SkillRoutingOutcome,
  SkillSelection,
} from "@brewva/brewva-runtime";

export const DELIBERATION_ISSUERS = {
  skillBroker: "brewva.skill-broker",
  debugLoop: "brewva.extensions.debug-loop",
  memoryCurator: "brewva.extensions.memory-curator",
} as const;

type ProposalRuntime = Pick<BrewvaRuntime, "proposals">;

export interface SubmittedProposal<K extends ProposalKind> {
  proposal: ProposalEnvelope<K>;
  receipt: DecisionReceipt;
}

function clampConfidence(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function normalizeSubject(subject: string, fallback: string): string {
  const normalized = subject.trim() || fallback;
  return normalized.slice(0, 240);
}

export function createProposalId(input: {
  sessionId: string;
  kind: ProposalKind;
  seed?: string;
  createdAt?: number;
}): string {
  const parts = [input.sessionId.trim()];
  if (typeof input.seed === "string" && input.seed.trim().length > 0) {
    parts.push(input.seed.trim());
  }
  parts.push(input.kind);
  parts.push(String(Math.max(0, Math.floor(input.createdAt ?? Date.now()))));
  return parts.join(":");
}

export function buildEvidenceRef(input: {
  id: string;
  sourceType: EvidenceSourceType;
  locator: string;
  createdAt?: number;
  hash?: string;
}): EvidenceRef {
  return {
    id: input.id.trim(),
    sourceType: input.sourceType,
    locator: input.locator.trim(),
    hash: typeof input.hash === "string" && input.hash.trim().length > 0 ? input.hash : undefined,
    createdAt: Math.max(0, Math.floor(input.createdAt ?? Date.now())),
  };
}

export function buildBrokerTraceEvidenceRef(input: {
  sessionId: string;
  prompt: string;
  createdAt?: number;
}): EvidenceRef {
  const createdAt = Math.max(0, Math.floor(input.createdAt ?? Date.now()));
  return buildEvidenceRef({
    id: `${input.sessionId}:broker_trace:${createdAt}`,
    sourceType: "broker_trace",
    locator: `broker://catalog-skill-broker/${encodeURIComponent(input.prompt.slice(0, 120))}`,
    createdAt,
  });
}

export function buildEventEvidenceRef(input: {
  id: string;
  eventId: string;
  createdAt?: number;
}): EvidenceRef {
  return buildEvidenceRef({
    id: input.id,
    sourceType: "event",
    locator: `event://${input.eventId}`,
    createdAt: input.createdAt,
  });
}

export function buildProposalReceiptEvidenceRef(input: {
  sessionId: string;
  proposalId: string;
  createdAt?: number;
}): EvidenceRef {
  return buildEvidenceRef({
    id: `${input.sessionId}:proposal_receipt:${input.proposalId}`,
    sourceType: "event",
    locator: `proposal-receipt://${input.proposalId}`,
    createdAt: input.createdAt,
  });
}

export function buildWorkspaceArtifactEvidenceRef(input: {
  id: string;
  locator: string;
  createdAt?: number;
  hash?: string;
}): EvidenceRef {
  return buildEvidenceRef({
    id: input.id,
    sourceType: "workspace_artifact",
    locator: input.locator,
    createdAt: input.createdAt,
    hash: input.hash,
  });
}

export function buildOperatorNoteEvidenceRef(input: {
  id: string;
  locator: string;
  createdAt?: number;
}): EvidenceRef {
  return buildEvidenceRef({
    id: input.id,
    sourceType: "operator_note",
    locator: input.locator,
    createdAt: input.createdAt,
  });
}

export function submitSkillSelectionProposal(input: {
  runtime: ProposalRuntime;
  sessionId: string;
  issuer: string;
  subject: string;
  selected: SkillSelection[];
  evidenceRefs: EvidenceRef[];
  routingOutcome?: SkillRoutingOutcome;
  reason?: string;
  source?: string;
  prompt?: string;
  confidence?: number;
  createdAt?: number;
  expiresAt?: number;
  id?: string;
}): SubmittedProposal<"skill_selection"> {
  const createdAt = Math.max(0, Math.floor(input.createdAt ?? Date.now()));
  const proposal: ProposalEnvelope<"skill_selection"> = {
    id:
      input.id ??
      createProposalId({
        sessionId: input.sessionId,
        kind: "skill_selection",
        createdAt,
      }),
    kind: "skill_selection",
    issuer: input.issuer,
    subject: normalizeSubject(input.subject, "skill selection"),
    payload: {
      selected: input.selected,
      routingOutcome: input.routingOutcome,
      reason: input.reason,
      source: input.source,
      prompt: input.prompt,
    },
    evidenceRefs: input.evidenceRefs,
    confidence: clampConfidence(input.confidence),
    expiresAt: input.expiresAt,
    createdAt,
  };
  return {
    proposal,
    receipt: input.runtime.proposals.submit(input.sessionId, proposal),
  };
}

export function submitSkillChainIntentProposal(input: {
  runtime: ProposalRuntime;
  sessionId: string;
  issuer: string;
  subject: string;
  steps: Array<{
    skill: string;
    consumes?: string[];
    produces?: string[];
    lane?: string;
  }>;
  evidenceRefs: EvidenceRef[];
  reason?: string;
  source?: string;
  createdAt?: number;
  expiresAt?: number;
  id?: string;
  seed?: string;
}): SubmittedProposal<"skill_chain_intent"> {
  const createdAt = Math.max(0, Math.floor(input.createdAt ?? Date.now()));
  const proposal: ProposalEnvelope<"skill_chain_intent"> = {
    id:
      input.id ??
      createProposalId({
        sessionId: input.sessionId,
        seed: input.seed,
        kind: "skill_chain_intent",
        createdAt,
      }),
    kind: "skill_chain_intent",
    issuer: input.issuer,
    subject: normalizeSubject(input.subject, "skill chain intent"),
    payload: {
      steps: input.steps,
      reason: input.reason,
      source: input.source,
    },
    evidenceRefs: input.evidenceRefs,
    expiresAt: input.expiresAt,
    createdAt,
  };
  return {
    proposal,
    receipt: input.runtime.proposals.submit(input.sessionId, proposal),
  };
}

export function submitContextPacketProposal(input: {
  runtime: ProposalRuntime;
  sessionId: string;
  issuer: string;
  subject: string;
  label: string;
  content: string;
  evidenceRefs: EvidenceRef[];
  scopeId?: string;
  packetKey?: string;
  action?: ContextPacketAction;
  profile?: ContextPacketProfile;
  createdAt?: number;
  expiresAt?: number;
  id?: string;
}): SubmittedProposal<"context_packet"> {
  const createdAt = Math.max(0, Math.floor(input.createdAt ?? Date.now()));
  const proposal: ProposalEnvelope<"context_packet"> = {
    id:
      input.id ??
      createProposalId({
        sessionId: input.sessionId,
        kind: "context_packet",
        createdAt,
      }),
    kind: "context_packet",
    issuer: input.issuer,
    subject: normalizeSubject(input.subject, input.label),
    payload: {
      label: input.label,
      content: input.content,
      scopeId: input.scopeId,
      packetKey: input.packetKey,
      action: input.action,
      profile: input.profile,
    },
    evidenceRefs: input.evidenceRefs,
    expiresAt: input.expiresAt,
    createdAt,
  };
  return {
    proposal,
    receipt: input.runtime.proposals.submit(input.sessionId, proposal),
  };
}

export function revokeContextPacketProposal(input: {
  runtime: ProposalRuntime;
  sessionId: string;
  issuer: string;
  subject: string;
  label: string;
  packetKey: string;
  evidenceRefs: EvidenceRef[];
  scopeId?: string;
  profile?: ContextPacketProfile;
  createdAt?: number;
  expiresAt?: number;
  id?: string;
}): SubmittedProposal<"context_packet"> {
  return submitContextPacketProposal({
    runtime: input.runtime,
    sessionId: input.sessionId,
    issuer: input.issuer,
    subject: input.subject,
    label: input.label,
    content: "",
    packetKey: input.packetKey,
    scopeId: input.scopeId,
    action: "revoke",
    profile: input.profile,
    evidenceRefs: input.evidenceRefs,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    id: input.id,
  });
}
