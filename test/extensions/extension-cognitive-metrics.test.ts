import { describe, expect, test } from "bun:test";
import { registerCognitiveMetrics } from "@brewva/brewva-gateway/runtime-plugins";
import { createMockExtensionAPI, invokeHandler, invokeHandlers } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function createSessionContext(sessionId: string): {
  sessionManager: { getSessionId: () => string };
} {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

function recordToolResult(
  runtime: ReturnType<typeof createRuntimeFixture>,
  input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    verdict: string;
  },
): void {
  runtime.events.record({
    sessionId: input.sessionId,
    type: "tool_result_recorded",
    payload: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      verdict: input.verdict,
    },
  });
}

describe("cognitive metrics extension", () => {
  test("records the first productive action once for the first non-operator pass", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "metrics-first-productive";

    registerCognitiveMetrics(api, runtime);

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 0, timestamp: 1 },
      createSessionContext(sessionId),
    );

    recordToolResult(runtime, {
      sessionId,
      toolCallId: "tc-1",
      toolName: "exec",
      verdict: "pass",
    });
    invokeHandler(
      handlers,
      "tool_result",
      { toolCallId: "tc-1", toolName: "exec" },
      createSessionContext(sessionId),
    );

    recordToolResult(runtime, {
      sessionId,
      toolCallId: "tc-2",
      toolName: "edit_file",
      verdict: "pass",
    });
    invokeHandler(
      handlers,
      "tool_result",
      { toolCallId: "tc-2", toolName: "edit_file" },
      createSessionContext(sessionId),
    );

    const events = runtime.events.query(sessionId, {
      type: "cognitive_metric_first_productive_action",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      turnIndex: 1,
      toolName: "exec",
    });
  });

  test("records resumption progress and useful rehydration after a productive action", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "metrics-resumption";

    registerCognitiveMetrics(api, runtime);

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 0, timestamp: 10 },
      createSessionContext(sessionId),
    );
    runtime.events.record({
      sessionId,
      type: "memory_summary_rehydrated",
      payload: {
        artifactRef: ".brewva/cognition/summaries/resume.md",
        packetKey: "summary:resume",
      },
    });

    invokeHandler(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "Continue the rollout." },
      createSessionContext(sessionId),
    );

    recordToolResult(runtime, {
      sessionId,
      toolCallId: "tc-resume-1",
      toolName: "exec",
      verdict: "pass",
    });
    invokeHandler(
      handlers,
      "tool_result",
      { toolCallId: "tc-resume-1", toolName: "exec" },
      createSessionContext(sessionId),
    );

    const progressEvents = runtime.events.query(sessionId, {
      type: "cognitive_metric_resumption_progress",
    });
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.payload).toMatchObject({
      turnIndex: 1,
      turnsFromResume: 1,
      toolName: "exec",
      rehydrationKinds: ["summary"],
      rehydrationPackets: [
        {
          kind: "summary",
          packetKey: "summary:resume",
          artifactRef: ".brewva/cognition/summaries/resume.md",
        },
      ],
    });

    const usefulnessEvents = runtime.events.query(sessionId, {
      type: "cognitive_metric_rehydration_usefulness",
    });
    expect(usefulnessEvents).toHaveLength(1);
    expect(usefulnessEvents[0]?.payload).toMatchObject({
      useful: true,
      reason: "productive_action",
      toolName: "exec",
      rehydrationKinds: ["summary"],
      rehydrationPackets: [
        {
          kind: "summary",
          packetKey: "summary:resume",
          artifactRef: ".brewva/cognition/summaries/resume.md",
        },
      ],
    });
  });

  test("records failed rehydration usefulness after the resume window elapses", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "metrics-window-expired";

    registerCognitiveMetrics(api, runtime);

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 0, timestamp: 20 },
      createSessionContext(sessionId),
    );
    runtime.events.record({
      sessionId,
      type: "memory_reference_rehydrated",
      payload: {
        artifactRef: ".brewva/cognition/reference/runtime.md",
        packetKey: "reference:runtime",
      },
    });

    invokeHandler(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "Resume the runtime work." },
      createSessionContext(sessionId),
    );

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 1, timestamp: 21 },
      createSessionContext(sessionId),
    );
    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 2, timestamp: 22 },
      createSessionContext(sessionId),
    );

    const usefulnessEvents = runtime.events.query(sessionId, {
      type: "cognitive_metric_rehydration_usefulness",
    });
    expect(usefulnessEvents).toHaveLength(1);
    expect(usefulnessEvents[0]?.payload).toMatchObject({
      useful: false,
      reason: "window_elapsed",
      rehydrationKinds: ["reference"],
      rehydrationPackets: [
        {
          kind: "reference",
          packetKey: "reference:runtime",
          artifactRef: ".brewva/cognition/reference/runtime.md",
        },
      ],
    });
  });

  test("records failed rehydration usefulness on session shutdown when progress never happens", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "metrics-session-shutdown";

    registerCognitiveMetrics(api, runtime);

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 0, timestamp: 30 },
      createSessionContext(sessionId),
    );
    runtime.events.record({
      sessionId,
      type: "memory_open_loop_rehydrated",
      payload: {
        artifactRef: ".brewva/cognition/summaries/open-loop.md",
        packetKey: "open-loop:resume",
      },
    });

    invokeHandler(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "Continue from the open loop." },
      createSessionContext(sessionId),
    );

    invokeHandlers(handlers, "session_shutdown", {}, createSessionContext(sessionId));

    const usefulnessEvents = runtime.events.query(sessionId, {
      type: "cognitive_metric_rehydration_usefulness",
    });
    expect(usefulnessEvents).toHaveLength(1);
    expect(usefulnessEvents[0]?.payload).toMatchObject({
      useful: false,
      reason: "session_shutdown",
      rehydrationKinds: ["open_loop"],
      rehydrationPackets: [
        {
          kind: "open_loop",
          packetKey: "open-loop:resume",
          artifactRef: ".brewva/cognition/summaries/open-loop.md",
        },
      ],
    });
  });

  test("does not count operator or diagnostic tools as productive actions", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "metrics-operator-tools";

    registerCognitiveMetrics(api, runtime);

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 0, timestamp: 40 },
      createSessionContext(sessionId),
    );

    recordToolResult(runtime, {
      sessionId,
      toolCallId: "tc-operator-1",
      toolName: "obs_query",
      verdict: "pass",
    });
    invokeHandler(
      handlers,
      "tool_result",
      { toolCallId: "tc-operator-1", toolName: "obs_query" },
      createSessionContext(sessionId),
    );

    expect(
      runtime.events.query(sessionId, {
        type: "cognitive_metric_first_productive_action",
      }),
    ).toHaveLength(0);
    expect(
      runtime.events.query(sessionId, {
        type: "cognitive_metric_resumption_progress",
      }),
    ).toHaveLength(0);
  });

  test("records procedure rehydration kind when procedural memory leads to progress", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "metrics-procedure-rehydration";

    registerCognitiveMetrics(api, runtime);

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 0, timestamp: 50 },
      createSessionContext(sessionId),
    );
    runtime.events.record({
      sessionId,
      type: "memory_procedure_rehydrated",
      payload: {
        artifactRef: ".brewva/cognition/reference/procedure-note.md",
        packetKey: "procedure:verification-standard",
      },
    });

    invokeHandler(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Continue implementation with the known verification flow.",
      },
      createSessionContext(sessionId),
    );

    recordToolResult(runtime, {
      sessionId,
      toolCallId: "tc-procedure-1",
      toolName: "exec",
      verdict: "pass",
    });
    invokeHandler(
      handlers,
      "tool_result",
      { toolCallId: "tc-procedure-1", toolName: "exec" },
      createSessionContext(sessionId),
    );

    const progressEvents = runtime.events.query(sessionId, {
      type: "cognitive_metric_resumption_progress",
    });
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.payload).toMatchObject({
      rehydrationKinds: ["procedure"],
    });
  });

  test("bounds tracked rehydration and tool-call ids for long-lived sessions", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "metrics-bounded-dedupe";

    registerCognitiveMetrics(api, runtime);

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 0, timestamp: 60 },
      createSessionContext(sessionId),
    );

    for (let index = 0; index < 300; index += 1) {
      runtime.events.record({
        sessionId,
        type: "memory_summary_rehydrated",
        payload: {
          artifactRef: `.brewva/cognition/summaries/summary-${index}.md`,
          packetKey: `summary:${index}`,
        },
      });
      invokeHandler(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", prompt: `Continue ${index}` },
        createSessionContext(sessionId),
      );

      recordToolResult(runtime, {
        sessionId,
        toolCallId: `tc-bounded-${index}`,
        toolName: "exec",
        verdict: "pass",
      });
      invokeHandler(
        handlers,
        "tool_result",
        { toolCallId: `tc-bounded-${index}`, toolName: "exec" },
        createSessionContext(sessionId),
      );
    }

    const usefulnessEvents = runtime.events.query(sessionId, {
      type: "cognitive_metric_rehydration_usefulness",
    });
    expect(usefulnessEvents.length).toBeGreaterThan(0);
    expect(usefulnessEvents.at(-1)?.payload).toMatchObject({
      useful: true,
      reason: "productive_action",
    });
  });
});
