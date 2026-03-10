import { describe, expect, test } from "bun:test";
import {
  buildStatusSummaryPacketContent,
  buildOperatorNoteEvidenceRef,
  COGNITION_ARTIFACT_EXTENSIONS,
  ensureCognitionArtifactsDirs,
  listCognitionArtifacts,
  parseStatusSummaryPacketContent,
  readCognitionArtifact,
  resolveCognitionArtifactsDir,
  submitCognitionContextPacket,
  submitStatusSummaryContextPacket,
  writeCognitionArtifact,
} from "@brewva/brewva-deliberation";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../helpers/workspace.js";

describe("deliberation cognition artifacts", () => {
  test("writeCognitionArtifact persists operator-owned artifacts under .brewva/cognition", async () => {
    const workspace = createTestWorkspace("deliberation-cognition-write");
    const dirs = await ensureCognitionArtifactsDirs(workspace);

    expect(dirs.referenceDir).toBe(resolveCognitionArtifactsDir(workspace, "reference"));
    expect(dirs.summariesDir).toBe(resolveCognitionArtifactsDir(workspace, "summaries"));

    const artifact = await writeCognitionArtifact({
      workspaceRoot: workspace,
      lane: "reference",
      name: "Architecture Notes",
      content: "Keep cognition outside the kernel.",
      createdAt: 1_731_000_000_000,
    });

    expect(artifact.relativePath).toBe(
      ".brewva/cognition/reference/1731000000000-architecture-notes.md",
    );
    expect(
      await readCognitionArtifact({
        workspaceRoot: workspace,
        lane: "reference",
        fileName: artifact.fileName,
      }),
    ).toBe("Keep cognition outside the kernel.");
    expect(
      (await listCognitionArtifacts(workspace, "reference")).map((entry) => entry.fileName),
    ).toEqual([artifact.fileName]);
  });

  test("writeCognitionArtifact avoids timestamp collisions with deterministic suffixes", async () => {
    const workspace = createTestWorkspace("deliberation-cognition-collision");

    const first = await writeCognitionArtifact({
      workspaceRoot: workspace,
      lane: "summaries",
      name: "Debug Loop Status",
      content: "first",
      createdAt: 1_731_000_000_222,
      extension: COGNITION_ARTIFACT_EXTENSIONS[0],
    });
    const second = await writeCognitionArtifact({
      workspaceRoot: workspace,
      lane: "summaries",
      name: "Debug Loop Status",
      content: "second",
      createdAt: 1_731_000_000_222,
      extension: COGNITION_ARTIFACT_EXTENSIONS[0],
    });

    expect(first.fileName).toBe("1731000000222-debug-loop-status.md");
    expect(second.fileName).toBe("1731000000222-debug-loop-status-1.md");
    expect(
      (await listCognitionArtifacts(workspace, "summaries")).map((entry) => entry.fileName),
    ).toEqual([first.fileName, second.fileName]);
  });

  test("submitCognitionContextPacket writes a cognition artifact and crosses the proposal boundary", async () => {
    const workspace = createTestWorkspace("deliberation-cognition-packet");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "cognition-context-packet";

    const { artifact, proposal, receipt } = await submitCognitionContextPacket({
      runtime,
      sessionId,
      issuer: "test.operator",
      lane: "summaries",
      name: "Retry Summary",
      label: "RetrySummary",
      subject: "retry summary",
      content: "Need one more debugging pass before implementation.",
      createdAt: 1_731_000_000_100,
      evidenceRefs: [
        buildOperatorNoteEvidenceRef({
          id: `${sessionId}:operator-note`,
          locator: "session://cognition-context-packet/operator-note",
          createdAt: 1_731_000_000_050,
        }),
      ],
    });

    expect(receipt.decision).toBe("accept");
    expect(artifact).toBeDefined();
    if (!artifact) {
      throw new Error("Expected accepted cognition proposal to keep its artifact.");
    }
    expect(artifact.relativePath).toBe(
      ".brewva/cognition/summaries/1731000000100-retry-summary.md",
    );
    expect(proposal.payload.packetKey).toBe("summaries:retry-summary");
    expect(proposal.evidenceRefs).toHaveLength(2);
    expect(proposal.evidenceRefs[0]?.locator).toBe(
      "session://cognition-context-packet/operator-note",
    );
    expect(proposal.evidenceRefs[1]?.locator).toBe(artifact.artifactRef);
    expect(
      await readCognitionArtifact({
        workspaceRoot: workspace,
        lane: "summaries",
        fileName: artifact.fileName,
      }),
    ).toContain("debugging pass");
    expect(
      runtime.proposals.list(sessionId, { kind: "context_packet", limit: 1 })[0]?.receipt.decision,
    ).toBe("accept");
  });

  test("submitCognitionContextPacket prunes artifacts when the kernel rejects the proposal", async () => {
    const workspace = createTestWorkspace("deliberation-cognition-reject");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "cognition-context-reject";
    const createdAt = 1_731_000_000_333;

    const { artifact, receipt } = await submitCognitionContextPacket({
      runtime,
      sessionId,
      issuer: "brewva.extensions.debug-loop",
      lane: "summaries",
      name: "Rejected Debug Loop Status",
      label: "RejectedDebugLoopStatus",
      subject: "rejected debug loop status",
      content: "This packet is intentionally malformed for reserved issuer policy.",
      createdAt,
      evidenceRefs: [
        buildOperatorNoteEvidenceRef({
          id: `${sessionId}:operator-note`,
          locator: "session://cognition-context-reject/operator-note",
          createdAt: createdAt - 50,
        }),
      ],
    });

    expect(receipt.decision).toBe("reject");
    expect(artifact).toBeUndefined();
    expect(await listCognitionArtifacts(workspace, "summaries")).toHaveLength(0);
  });

  test("submitStatusSummaryContextPacket standardizes status summary packets for reserved issuers", async () => {
    const workspace = createTestWorkspace("deliberation-status-summary-packet");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "status-summary-context-packet";
    const createdAt = Date.now();

    const { proposal, receipt } = await submitStatusSummaryContextPacket({
      runtime,
      sessionId,
      issuer: "brewva.extensions.debug-loop",
      name: "Debug Loop Status",
      label: "DebugLoopStatus",
      subject: "debug loop status",
      summaryKind: "debug_loop_retry",
      status: "forensics",
      fields: [
        { key: "next_action", value: "load:runtime-forensics" },
        { key: "references", value: ["failure-case.json"] },
      ],
      scopeId: "leaf-a",
      packetKey: "debug-loop:status",
      createdAt,
      expiresAt: createdAt + 60_000,
      evidenceRefs: [
        buildOperatorNoteEvidenceRef({
          id: `${sessionId}:operator-note`,
          locator: "session://status-summary-context-packet/operator-note",
          createdAt: createdAt - 50,
        }),
      ],
    });

    expect(receipt.decision).toBe("accept");
    expect(proposal.payload.profile).toBe("status_summary");
    expect(proposal.payload.content).toContain("[StatusSummary]");
    expect(proposal.payload.content).toContain("summary_kind: debug_loop_retry");
    expect(proposal.payload.content).toContain("references: failure-case.json");
  });

  test("buildStatusSummaryPacketContent normalizes empty fields to none", () => {
    expect(
      buildStatusSummaryPacketContent({
        summaryKind: "debug_loop_handoff",
        status: "blocked",
        fields: [
          { key: "next_action", value: "inspect:debug-loop" },
          { key: "blocked_on", value: [] },
        ],
      }),
    ).toContain("blocked_on: none");
  });

  test("parseStatusSummaryPacketContent exposes stable fields for curator strategies", () => {
    const parsed = parseStatusSummaryPacketContent(
      [
        "[StatusSummary]",
        "profile: status_summary",
        "summary_kind: debug_loop_handoff",
        "status: blocked",
        "next_action: resume proposal admission fix",
        "blocked_on: verification evidence",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      profile: "status_summary",
      summaryKind: "debug_loop_handoff",
      status: "blocked",
      fields: {
        profile: "status_summary",
        summary_kind: "debug_loop_handoff",
        status: "blocked",
        next_action: "resume proposal admission fix",
        blocked_on: "verification evidence",
      },
    });
  });
});
