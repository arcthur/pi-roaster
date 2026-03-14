import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitContextPacketProposal } from "@brewva/brewva-deliberation";
import {
  BrewvaRuntime,
  createTrustedLocalGovernancePort,
  type ProposalRecord,
  registerToolGovernanceDescriptor,
  unregisterToolGovernanceDescriptor,
} from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "brewva-proposals-"));
}

function buildEvidence(sessionId: string, createdAt: number) {
  return [
    {
      id: `${sessionId}:operator-note:${createdAt}`,
      sourceType: "operator_note" as const,
      locator: `session://${sessionId}/operator-note/${createdAt}`,
      createdAt,
    },
  ];
}

const originalDateNow = Date.now;

afterEach(() => {
  Date.now = originalDateNow;
});

describe("runtime proposals API", () => {
  test("commitment posture tool starts emit accepted effect_commitment receipts", () => {
    const runtime = new BrewvaRuntime({
      cwd: repoRoot(),
      governancePort: createTrustedLocalGovernancePort(),
    });
    const sessionId = `runtime-proposals-commitment-${crypto.randomUUID()}`;

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-commitment",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(started.allowed).toBe(true);
    expect(started.posture).toBe("commitment");
    expect(started.commitmentReceipt?.decision).toBe("accept");

    const postureEvent = runtime.events.query(sessionId, {
      type: "tool_posture_selected",
      last: 1,
    })[0];
    const listed = runtime.proposals.list(sessionId, {
      kind: "effect_commitment",
      limit: 1,
    })[0] as ProposalRecord<"effect_commitment"> | undefined;
    expect(listed?.proposal.payload.toolName).toBe("exec");
    expect(listed?.proposal.payload.toolCallId).toBe("tc-exec-commitment");
    expect(listed?.receipt.decision).toBe("accept");
    expect(listed?.receipt.committedEffects[0]?.kind).toBe("tool_commitment");
    expect(listed?.proposal.evidenceRefs[0]?.locator).toBe(`event://${postureEvent?.id}`);
  });

  test("default runtime opens an operator approval request for commitment posture tools", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `runtime-proposals-commitment-default-${crypto.randomUUID()}`;

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-default-defer",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(started.allowed).toBe(false);
    expect(started.posture).toBe("commitment");
    expect(started.commitmentReceipt?.decision).toBe("defer");
    expect(started.reason).toContain("effect_commitment_pending_operator_approval:");
    expect(typeof started.effectCommitmentRequestId).toBe("string");
    const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolName).toBe("exec");
    expect(pending[0]?.toolCallId).toBe("tc-exec-default-defer");
    expect(pending[0]?.requestId).toBe(started.effectCommitmentRequestId);
  });

  test("operator approval desk approves an exact pending request that must be explicitly resumed", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `runtime-proposals-commitment-approve-${crypto.randomUUID()}`;

    const deferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-approval-pending",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(deferred.allowed).toBe(false);
    expect(deferred.commitmentReceipt?.decision).toBe("defer");
    expect(typeof deferred.effectCommitmentRequestId).toBe("string");

    const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolCallId).toBe("tc-exec-approval-pending");

    const decision = runtime.proposals.decideEffectCommitment(sessionId, pending[0]!.requestId, {
      decision: "accept",
      actor: "operator:test",
      reason: "safe local command",
    });
    expect(decision.ok).toBe(true);
    expect(decision.ok ? decision.decision : null).toBe("accept");

    const wrongToolCall = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-approval-mismatch",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pending[0]!.requestId,
    });
    expect(wrongToolCall.allowed).toBe(false);
    expect(wrongToolCall.reason).toContain("effect_commitment_request_tool_call_id_mismatch:");

    const approved = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-approval-pending",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pending[0]!.requestId,
    });

    expect(approved.allowed).toBe(true);
    expect(approved.commitmentReceipt?.decision).toBe("accept");
    expect(approved.effectCommitmentRequestId).toBe(pending[0]!.requestId);
    expect(runtime.proposals.listPendingEffectCommitments(sessionId)).toHaveLength(0);
  });

  test("operator approval requests rehydrate across runtime restart before and after approval", () => {
    const workspace = createWorkspace();
    const sessionId = `runtime-proposals-commitment-rehydrate-${crypto.randomUUID()}`;
    const runtime = new BrewvaRuntime({ cwd: workspace });

    const deferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-rehydrate",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(deferred.allowed).toBe(false);
    expect(typeof deferred.effectCommitmentRequestId).toBe("string");

    const restarted = new BrewvaRuntime({ cwd: workspace });
    const pendingAfterRestart = restarted.proposals.listPendingEffectCommitments(sessionId);
    expect(pendingAfterRestart).toHaveLength(1);
    expect(pendingAfterRestart[0]?.requestId).toBe(deferred.effectCommitmentRequestId);
    expect(pendingAfterRestart[0]?.toolCallId).toBe("tc-exec-rehydrate");

    const accepted = restarted.proposals.decideEffectCommitment(
      sessionId,
      pendingAfterRestart[0]!.requestId,
      {
        decision: "accept",
        actor: "operator:test",
        reason: "rehydrated approval",
      },
    );
    expect(accepted.ok).toBe(true);

    const restartedAgain = new BrewvaRuntime({ cwd: workspace });
    expect(restartedAgain.proposals.listPendingEffectCommitments(sessionId)).toHaveLength(0);

    const resumed = restartedAgain.tools.start({
      sessionId,
      toolCallId: "tc-exec-rehydrate",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pendingAfterRestart[0]!.requestId,
    });

    expect(resumed.allowed).toBe(true);
    expect(resumed.commitmentReceipt?.decision).toBe("accept");
    expect(resumed.effectCommitmentRequestId).toBe(pendingAfterRestart[0]!.requestId);
  });

  test("rejected effect commitment requests do not become sticky deny caches for future requests", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `runtime-proposals-commitment-reject-${crypto.randomUUID()}`;

    const firstDeferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-reject-once",
      toolName: "exec",
      args: { command: "echo hi" },
    });
    expect(firstDeferred.allowed).toBe(false);
    const firstPending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(firstPending).toHaveLength(1);

    const rejected = runtime.proposals.decideEffectCommitment(
      sessionId,
      firstPending[0]!.requestId,
      {
        decision: "reject",
        actor: "operator:test",
        reason: "not enough context",
      },
    );
    expect(rejected.ok).toBe(true);

    const rejectedResume = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-reject-once",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: firstPending[0]!.requestId,
    });
    expect(rejectedResume.allowed).toBe(false);
    expect(rejectedResume.reason).toContain("effect_commitment_operator_rejected:");

    const secondDeferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-reject-twice",
      toolName: "exec",
      args: { command: "echo hi" },
    });
    expect(secondDeferred.allowed).toBe(false);
    expect(secondDeferred.commitmentReceipt?.decision).toBe("defer");
    const remainingPending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(remainingPending).toHaveLength(1);
    expect(remainingPending[0]?.requestId).not.toBe(firstPending[0]!.requestId);
    expect(remainingPending[0]?.toolCallId).toBe("tc-exec-reject-twice");
  });

  test("custom commitment posture descriptors also fail closed without a governance port", () => {
    const toolName = "custom_commitment_probe";
    registerToolGovernanceDescriptor(toolName, {
      effects: ["workspace_read"],
      defaultRisk: "high",
      posture: "commitment",
    });
    try {
      const runtime = new BrewvaRuntime({ cwd: repoRoot() });
      const sessionId = `runtime-proposals-custom-commitment-${crypto.randomUUID()}`;

      const started = runtime.tools.start({
        sessionId,
        toolCallId: "tc-custom-commitment",
        toolName,
        args: { file_path: "README.md" },
      });

      expect(started.allowed).toBe(false);
      expect(started.posture).toBe("commitment");
      expect(started.commitmentReceipt?.decision).toBe("defer");
      expect(started.reason).toContain("effect_commitment_pending_operator_approval:");
      expect(runtime.proposals.listPendingEffectCommitments(sessionId)).toHaveLength(1);
    } finally {
      unregisterToolGovernanceDescriptor(toolName);
    }
  });

  test("governancePort authorization can defer commitment tool execution", () => {
    const runtime = new BrewvaRuntime({
      cwd: repoRoot(),
      governancePort: {
        authorizeEffectCommitment: () => ({
          decision: "defer",
          reason: "operator review required",
          policyBasis: ["test_governance_port"],
        }),
      },
    });
    const sessionId = `runtime-proposals-commitment-defer-${crypto.randomUUID()}`;

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-deferred",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(started.allowed).toBe(false);
    expect(started.posture).toBe("commitment");
    expect(started.commitmentReceipt?.decision).toBe("defer");
    expect(started.reason).toContain("operator review required");

    const listed = runtime.proposals.list(sessionId, {
      kind: "effect_commitment",
      limit: 1,
    })[0] as ProposalRecord<"effect_commitment"> | undefined;
    expect(listed?.receipt.decision).toBe("defer");
    expect(listed?.receipt.policyBasis).toContain("test_governance_port");
  });

  test("observe posture tool starts do not emit effect_commitment proposals", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `runtime-proposals-observe-${crypto.randomUUID()}`;

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-grep-observe",
      toolName: "grep",
      args: { pattern: "TODO", include: "*.ts" },
    });

    expect(started.allowed).toBe(true);
    expect(started.posture).toBe("observe");
    expect(started.commitmentReceipt).toBeUndefined();
    expect(runtime.proposals.list(sessionId, { kind: "effect_commitment" })).toHaveLength(0);
  });

  test("lists proposal records newest first by receipt timestamp", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `runtime-proposals-${crypto.randomUUID()}`;

    Date.now = () => 100;
    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "first packet",
      label: "OperatorMemo",
      content: "first",
      evidenceRefs: buildEvidence(sessionId, 100),
    });

    Date.now = () => 300;
    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "third packet",
      label: "OperatorMemo",
      content: "third",
      evidenceRefs: buildEvidence(sessionId, 300),
    });

    Date.now = () => 200;
    submitContextPacketProposal({
      runtime,
      sessionId,
      issuer: "test.operator",
      subject: "second packet",
      label: "OperatorMemo",
      content: "second",
      evidenceRefs: buildEvidence(sessionId, 200),
    });

    const listed = runtime.proposals.list(sessionId, {
      kind: "context_packet",
    }) as ProposalRecord<"context_packet">[];
    expect(listed.map((record) => record.receipt.timestamp)).toEqual([300, 200, 100]);
    expect(listed.map((record) => record.proposal.payload.content)).toEqual([
      "third",
      "second",
      "first",
    ]);
    const latest = runtime.proposals.list(sessionId, {
      kind: "context_packet",
      limit: 1,
    })[0] as ProposalRecord<"context_packet"> | undefined;
    expect(latest?.proposal.payload.content).toBe("third");
  });

  test("isolates proposal listings across sessions even when packet keys and timestamps match", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionA = `runtime-proposals-a-${crypto.randomUUID()}`;
    const sessionB = `runtime-proposals-b-${crypto.randomUUID()}`;

    Date.now = () => 500;
    submitContextPacketProposal({
      runtime,
      sessionId: sessionA,
      issuer: "test.operator",
      subject: "session a packet",
      label: "OperatorMemo",
      content: "summary from session a",
      packetKey: "summary",
      createdAt: 500,
      evidenceRefs: buildEvidence(sessionA, 500),
    });
    submitContextPacketProposal({
      runtime,
      sessionId: sessionB,
      issuer: "test.operator",
      subject: "session b packet",
      label: "OperatorMemo",
      content: "summary from session b",
      packetKey: "summary",
      createdAt: 500,
      evidenceRefs: buildEvidence(sessionB, 500),
    });

    const listedA = runtime.proposals.list(sessionA, {
      kind: "context_packet",
    }) as ProposalRecord<"context_packet">[];
    const listedB = runtime.proposals.list(sessionB, {
      kind: "context_packet",
    }) as ProposalRecord<"context_packet">[];

    expect(listedA).toHaveLength(1);
    expect(listedB).toHaveLength(1);
    expect(listedA[0]?.proposal.payload.content).toBe("summary from session a");
    expect(listedB[0]?.proposal.payload.content).toBe("summary from session b");
    expect(runtime.proposals.list(`missing-${crypto.randomUUID()}`)).toHaveLength(0);
  });
});
