import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeCognitionArtifact } from "@brewva/brewva-deliberation";
import {
  createEmptyMemoryAdaptationPolicy,
  readMemoryAdaptationPolicy,
  registerCognitiveMetrics,
  registerMemoryAdaptation,
  registerMemoryCurator,
  resolveMemoryAdaptationPolicyPath,
} from "@brewva/brewva-gateway/runtime-plugins";
import {
  createMockExtensionAPI,
  invokeHandler,
  invokeHandlerAsync,
  invokeHandlersAsync,
} from "../helpers/extension.js";
import { createRuntimeConfig, createRuntimeFixture } from "./fixtures/runtime.js";

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

describe("memory adaptation extension", () => {
  test("persists usefulness observations under ops event level", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.events.level = "ops";
      }),
    });
    const sessionId = "memory-adaptation-ops";

    registerCognitiveMetrics(api, runtime);
    registerMemoryAdaptation(api, runtime);

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

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "Continue the rollout." },
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

    await invokeHandlersAsync(handlers, "session_shutdown", {}, createSessionContext(sessionId));

    const policy = await readMemoryAdaptationPolicy(runtime.workspaceRoot);
    expect(policy.strategies.summary).toMatchObject({
      attempts: 1,
      useful: 1,
      useless: 0,
    });
    expect(policy.packets["summary:resume"]).toMatchObject({
      strategy: "summary",
      useful: 1,
      attempts: 1,
      artifactRef: ".brewva/cognition/summaries/resume.md",
    });

    const eventTypes = runtime.events.query(sessionId).map((event) => event.type);
    expect(eventTypes).toContain("memory_summary_rehydrated");
    expect(eventTypes).toContain("cognitive_metric_rehydration_usefulness");
    expect(eventTypes).toContain("memory_adaptation_updated");
  });

  test("uses persisted adaptation policy to prioritize more useful reference packets", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-adaptation-ranking";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      name: "runtime-dispatch-guide",
      content: [
        "[ReferenceSediment]",
        "kind: guide",
        "focus: proposal admission runtime dispatch regression guidance",
      ].join("\n"),
      createdAt: 1731000000400,
    });
    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      name: "proposal-admission-playbook",
      content: [
        "[ReferenceSediment]",
        "kind: guide",
        "focus: proposal admission runtime dispatch regression guidance",
      ].join("\n"),
      createdAt: 1731000000300,
    });

    const policy = createEmptyMemoryAdaptationPolicy(1731000000500);
    policy.packets["reference:1731000000400-runtime-dispatch-guide"] = {
      strategy: "reference",
      artifactRef: ".brewva/cognition/reference/1731000000400-runtime-dispatch-guide.md",
      attempts: 6,
      useful: 0,
      useless: 6,
      lastObservedAt: 1731000000450,
      lastUsefulAt: null,
    };
    policy.packets["reference:1731000000300-proposal-admission-playbook"] = {
      strategy: "reference",
      artifactRef: ".brewva/cognition/reference/1731000000300-proposal-admission-playbook.md",
      attempts: 6,
      useful: 6,
      useless: 0,
      lastObservedAt: 1731000000460,
      lastUsefulAt: 1731000000460,
    };
    const adaptationPath = resolveMemoryAdaptationPolicyPath(runtime.workspaceRoot);
    await mkdir(dirname(adaptationPath), { recursive: true });
    await writeFile(adaptationPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

    registerMemoryCurator(api, runtime);

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Investigate the proposal admission runtime dispatch regression guidance.",
      },
      createSessionContext(sessionId),
    );

    const rehydrated = runtime.events
      .query(sessionId)
      .filter((event) => event.type === "memory_reference_rehydrated");
    expect(rehydrated).toHaveLength(2);
    expect(rehydrated[0]?.payload).toMatchObject({
      packetKey: "reference:1731000000300-proposal-admission-playbook",
    });
    expect(rehydrated[1]?.payload).toMatchObject({
      packetKey: "reference:1731000000400-runtime-dispatch-guide",
    });
  });

  test("degrades to an empty policy when adaptation state is corrupt", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-adaptation-corrupt-policy";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      name: "runtime-guidance",
      content: [
        "[ReferenceSediment]",
        "kind: guide",
        "focus: runtime proposal admission guidance",
      ].join("\n"),
      createdAt: 1731000000600,
    });

    const adaptationPath = resolveMemoryAdaptationPolicyPath(runtime.workspaceRoot);
    await mkdir(dirname(adaptationPath), { recursive: true });
    await writeFile(adaptationPath, "{invalid json", "utf8");

    registerMemoryCurator(api, runtime);

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Review the runtime proposal admission guidance.",
      },
      createSessionContext(sessionId),
    );

    expect(
      runtime.proposals.list(sessionId, {
        kind: "context_packet",
      }),
    ).toHaveLength(1);

    const policy = await readMemoryAdaptationPolicy(runtime.workspaceRoot);
    expect(policy).toMatchObject({
      schema: "brewva.memory_adaptation_policy.v1",
    });
    expect(Object.keys(policy.packets)).toHaveLength(0);
  });
});
