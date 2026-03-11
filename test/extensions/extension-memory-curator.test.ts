import { describe, expect, test } from "bun:test";
import { writeCognitionArtifact } from "@brewva/brewva-deliberation";
import {
  recordProactivityWakeup,
  registerMemoryCurator,
} from "@brewva/brewva-gateway/runtime-plugins";
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

  test("rehydrates procedural notes as a distinct reference-lane strategy", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-curator-procedure";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      name: "verification-standard-implementation",
      content: [
        "[ProcedureNote]",
        "profile: procedure_note",
        "note_kind: verification_outcome",
        "lesson_key: verification:standard:implementation",
        "pattern: reuse verification profile standard for implementation work",
        "recommendation: reuse verification profile standard for similar tasks",
        "active_skill: implementation",
      ].join("\n"),
      createdAt: 1731000000250,
    });

    registerMemoryCurator(api, runtime);

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Continue implementation work and reuse the standard verification path.",
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
    const procedureRecord = records.find((record) =>
      (record.proposal.payload.packetKey ?? "").startsWith("procedure:"),
    );
    expect(procedureRecord?.receipt.decision).toBe("accept");
    expect(procedureRecord?.proposal.payload.content).toContain("[ProcedureNote]");
    expect(runtime.events.query(sessionId).map((event) => event.type)).toContain(
      "memory_procedure_rehydrated",
    );
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
        "status: done",
        `session_scope: ${sessionId}`,
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

  test("rehydrates prompt-matched episodic artifacts through the same curator boundary", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-curator-episode";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      name: "release-episode",
      content: [
        "[EpisodeNote]",
        "profile: episode_note",
        "episode_kind: session_episode",
        `session_scope: ${sessionId}`,
        "focus: release readiness pass",
        "next_action: inspect blocker regression and verification evidence",
        "recent_events: skill_completed:verification; proposal:context_packet:accept",
      ].join("\n"),
      createdAt: 1731000000310,
    });

    registerMemoryCurator(api, runtime);

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Resume the release readiness pass and inspect the blocker regression.",
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
    const episodeRecord = records.find((record) =>
      (record.proposal.payload.packetKey ?? "").startsWith("episode:"),
    );
    expect(episodeRecord?.receipt.decision).toBe("accept");
    expect(episodeRecord?.proposal.payload.content).toContain("[EpisodeNote]");
    expect(runtime.events.query(sessionId).map((event) => event.type)).toContain(
      "memory_episode_rehydrated",
    );
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
        `session_scope: ${sessionId}`,
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
        `session_scope: ${sessionId}`,
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

  test("uses proactivity wake-up objective and hints to rehydrate relevant memory for generic heartbeat prompts", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-curator-proactivity";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      name: "release-readiness-summary",
      content: [
        "[StatusSummary]",
        "profile: status_summary",
        "summary_kind: session_summary",
        "status: in_progress",
        `session_scope: ${sessionId}`,
        "goal: release readiness review",
        "next_action: inspect release readiness blockers and backlog risk",
      ].join("\n"),
      createdAt: 1731000000500,
    });

    registerMemoryCurator(api, runtime);
    recordProactivityWakeup(runtime, sessionId, {
      source: "heartbeat",
      ruleId: "nightly-release-readiness",
      prompt: "Check project status.",
      objective: "Review release readiness and backlog risk.",
      contextHints: ["release readiness", "backlog risk"],
    });

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Check project status.",
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
    const successEvent = runtime.events
      .query(sessionId)
      .find((event) => event.type === "memory_summary_rehydrated");
    expect(successEvent?.payload?.triggerSource).toBe("heartbeat");
    expect(successEvent?.payload?.triggerRuleId).toBe("nightly-release-readiness");
  });

  test("ignores stale proactivity wake-up metadata after the wake-up TTL expires", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-curator-stale-proactivity";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      name: "stale-release-readiness-summary",
      content: [
        "[StatusSummary]",
        "profile: status_summary",
        "summary_kind: session_summary",
        "status: in_progress",
        `session_scope: ${sessionId}`,
        "goal: release readiness review",
        "next_action: inspect release readiness blockers and backlog risk",
      ].join("\n"),
      createdAt: 1731000000600,
    });

    registerMemoryCurator(api, runtime);
    recordProactivityWakeup(runtime, sessionId, {
      source: "heartbeat",
      ruleId: "nightly-release-readiness",
      prompt: "Check project status.",
      objective: "Review release readiness and backlog risk.",
      contextHints: ["release readiness", "backlog risk"],
      preparedAt: Date.now() - 120_000,
    });

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Check project status.",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    expect(
      runtime.proposals.list(sessionId, {
        kind: "context_packet",
      }),
    ).toHaveLength(0);
  });

  test("does not rehydrate summary or episode memory from a different session scope", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-curator-scope-target";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      name: "foreign-summary",
      content: [
        "[StatusSummary]",
        "profile: status_summary",
        "summary_kind: session_summary",
        "status: blocked",
        "session_scope: foreign-session",
        "goal: foreign rollout",
        "next_action: inspect foreign blocker",
      ].join("\n"),
      createdAt: 1731000000700,
    });
    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      name: "foreign-episode",
      content: [
        "[EpisodeNote]",
        "profile: episode_note",
        "episode_kind: session_episode",
        "session_scope: foreign-session",
        "focus: foreign release pass",
        "next_action: inspect foreign verification gap",
      ].join("\n"),
      createdAt: 1731000000710,
    });

    registerMemoryCurator(api, runtime);

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Continue the release pass and inspect the blocker.",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    expect(
      runtime.proposals.list(sessionId, {
        kind: "context_packet",
      }),
    ).toHaveLength(0);
  });
});
