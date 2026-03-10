import { describe, expect, test } from "bun:test";
import { writeCognitionArtifact } from "@brewva/brewva-deliberation";
import { registerMemoryCurator } from "@brewva/brewva-extensions";
import type { ProposalRecord } from "@brewva/brewva-runtime";
import {
  createMockExtensionAPI,
  invokeHandlerAsync,
  invokeHandlers,
} from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

describe("memory curator extension", () => {
  test("rehydrates matching reference artifacts into accepted context packets once per session", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-curator-s1";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      name: "runtime-routing-regression",
      content: [
        "[ReferenceSediment]",
        "kind: debug_loop_terminal",
        "status: blocked",
        "next_action: inspect proposal admission regression in runtime dispatch",
      ].join("\n"),
      createdAt: 1731000000200,
    });

    registerMemoryCurator(api, runtime);

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Investigate the runtime dispatch regression around proposal admission.",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );
    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Investigate the runtime dispatch regression around proposal admission.",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    const records = runtime.proposals.list(sessionId, {
      kind: "context_packet",
    }) as ProposalRecord<"context_packet">[];
    expect(records).toHaveLength(1);
    expect(records[0]?.receipt.decision).toBe("accept");
    expect(records[0]?.proposal.issuer).toBe("brewva.extensions.memory-curator");
    expect(records[0]?.proposal.payload.packetKey).toContain("reference:");

    invokeHandlers(
      handlers,
      "session_shutdown",
      {},
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Investigate the runtime dispatch regression around proposal admission.",
      },
      {
        sessionManager: {
          getSessionId: () => "memory-curator-s2",
        },
      },
    );

    expect(
      runtime.proposals.list("memory-curator-s2", {
        kind: "context_packet",
        limit: 1,
      }),
    ).toHaveLength(1);
  });

  test("rehydrates prompt-matched summary artifacts through the same curator boundary", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-curator-summary";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      name: "proposal-boundary-summary",
      content: [
        "[StatusSummary]",
        "profile: status_summary",
        "summary_kind: session_summary",
        "status: in_progress",
        "focus: proposal boundary rollout",
      ].join("\n"),
      createdAt: 1731000000300,
    });

    registerMemoryCurator(api, runtime);

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Continue the proposal boundary rollout and review the current summary.",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    const records = runtime.proposals.list(sessionId, {
      kind: "context_packet",
    }) as ProposalRecord<"context_packet">[];
    const summaryRecord = records.find((record) =>
      (record.proposal.payload.packetKey ?? "").startsWith("summary:"),
    );
    expect(summaryRecord?.receipt.decision).toBe("accept");
    expect(summaryRecord?.proposal.issuer).toBe("brewva.extensions.memory-curator");

    const eventTypes = runtime.events.query(sessionId).map((event) => event.type);
    expect(eventTypes).toContain("memory_summary_rehydrated");
  });

  test("rehydrates the latest unresolved open-loop summary on continuation prompts", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-curator-open-loop";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      name: "older-open-loop",
      content: [
        "[StatusSummary]",
        "profile: status_summary",
        "summary_kind: debug_loop_retry",
        "status: blocked",
        "next_action: inspect earlier runtime trace",
        "blocked_on: missing evidence",
      ].join("\n"),
      createdAt: 1731000000100,
    });
    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      name: "latest-open-loop",
      content: [
        "[StatusSummary]",
        "profile: status_summary",
        "summary_kind: debug_loop_handoff",
        "status: blocked",
        "next_action: resume proposal admission fix",
        "blocked_on: verification evidence",
      ].join("\n"),
      createdAt: 1731000000400,
    });

    registerMemoryCurator(api, runtime);

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Continue from where we left off.",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    const records = runtime.proposals.list(sessionId, {
      kind: "context_packet",
    }) as ProposalRecord<"context_packet">[];
    const openLoopRecord = records.find((record) =>
      (record.proposal.payload.packetKey ?? "").startsWith("open-loop:"),
    );
    expect(openLoopRecord?.receipt.decision).toBe("accept");
    expect(openLoopRecord?.proposal.payload.content).toContain(
      "next_action: resume proposal admission fix",
    );

    const events = runtime.events.query(sessionId);
    expect(events.map((event) => event.type)).toContain("memory_open_loop_rehydrated");
  });
});
