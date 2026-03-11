import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { listCognitionArtifacts, readCognitionArtifact } from "@brewva/brewva-deliberation";
import {
  createEmptyMemoryAdaptationPolicy,
  registerMemoryFormation,
  resolveMemoryAdaptationPolicyPath,
} from "@brewva/brewva-gateway/runtime-plugins";
import { createMockExtensionAPI, invokeHandlersAsync } from "../helpers/extension.js";
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

async function waitForSummaryArtifacts(
  runtime: ReturnType<typeof createRuntimeFixture>,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const artifacts = await listCognitionArtifacts(runtime.workspaceRoot, "summaries");
    if (artifacts.length >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedCount} summary artifact(s).`);
}

async function waitForReferenceArtifacts(
  runtime: ReturnType<typeof createRuntimeFixture>,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const artifacts = await listCognitionArtifacts(runtime.workspaceRoot, "reference");
    if (artifacts.length >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedCount} reference artifact(s).`);
}

describe("memory formation extension", () => {
  test("writes resumable session summaries on agent end", async () => {
    const { api } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-formation-agent-end";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Finish the proposal boundary rollout and validate the gateway wake path.",
    });
    runtime.task.addItem(sessionId, {
      text: "Validate heartbeat wake-up context against memory rehydration.",
      status: "doing",
    });
    runtime.task.recordBlocker(sessionId, {
      id: "blk-release-readiness",
      message: "Need release readiness evidence before shipping.",
      source: "test.memory",
    });
    runtime.events.record({
      sessionId,
      type: "skill_completed",
      payload: {
        skillName: "implementation",
        outputKeys: ["patch_set", "verification_report"],
        outputs: {
          patch_set: "patch-1",
          verification_report: "clean",
        },
        completedAt: Date.now(),
      },
    });

    registerMemoryFormation(api, runtime);
    runtime.events.record({
      sessionId,
      type: "agent_end",
    });

    await waitForSummaryArtifacts(runtime, 2);
    const artifacts = await listCognitionArtifacts(runtime.workspaceRoot, "summaries");
    expect(artifacts).toHaveLength(2);
    const summaryArtifact = artifacts.find((artifact) => artifact.fileName.includes("summary"));
    expect(summaryArtifact).toBeDefined();
    const content = await readCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      fileName: summaryArtifact!.fileName,
    });
    expect(content).toContain("summary_kind: session_summary");
    expect(content).toContain("status: blocked");
    expect(content).toContain(`session_scope: ${sessionId}`);
    expect(content).toContain("goal: Finish the proposal boundary rollout");
    expect(content).toContain("recent_skill: implementation");
    expect(content).toContain("recent_outputs: patch_set; verification_report");
    expect(content).toContain("blocked_on: blk-release-readiness:");
    expect(runtime.events.query(sessionId).map((event) => event.type)).toContain(
      "memory_summary_written",
    );
  });

  test("does not duplicate identical summaries across agent_end and session_shutdown", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-formation-dedupe";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Keep the session resumable.",
    });
    runtime.task.addItem(sessionId, {
      text: "Resume the same session later.",
      status: "doing",
    });

    registerMemoryFormation(api, runtime);
    runtime.events.record({
      sessionId,
      type: "agent_end",
    });
    await waitForSummaryArtifacts(runtime, 2);

    await invokeHandlersAsync(handlers, "session_shutdown", {}, createSessionContext(sessionId));
    await waitForSummaryArtifacts(runtime, 2);

    expect(await listCognitionArtifacts(runtime.workspaceRoot, "summaries")).toHaveLength(2);
  });

  test("writes verified procedure notes from verification outcomes", async () => {
    const { api } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-formation-procedure-note";

    registerMemoryFormation(api, runtime);
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      payload: {
        schema: "brewva.verification.outcome.v1",
        level: "standard",
        outcome: "pass",
        lessonKey: "verification:standard:implementation",
        pattern: "reuse verification profile standard for implementation work",
        recommendation: "reuse verification profile standard for similar tasks",
        taskGoal: "Ship the implementation with stable verification.",
        activeSkill: "implementation",
        failedChecks: [],
        commandsExecuted: ["type-check", "tests"],
      },
    });

    await waitForReferenceArtifacts(runtime, 1);
    const artifacts = await listCognitionArtifacts(runtime.workspaceRoot, "reference");
    expect(artifacts).toHaveLength(1);
    const content = await readCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      fileName: artifacts[0]!.fileName,
    });
    expect(content).toContain("[ProcedureNote]");
    expect(content).toContain("note_kind: verification_outcome");
    expect(content).toContain("lesson_key: verification:standard:implementation");
    expect(content).toContain(
      "recommendation: reuse verification profile standard for similar tasks",
    );
    expect(runtime.events.query(sessionId).map((event) => event.type)).toContain(
      "memory_procedure_note_written",
    );
  });

  test("writes episodic process memory at session boundaries", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-formation-episode";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Finish the release readiness pass.",
    });
    runtime.task.addItem(sessionId, {
      text: "Validate release blockers and verification evidence.",
      status: "doing",
    });
    runtime.events.record({
      sessionId,
      type: "skill_completed",
      payload: {
        skillName: "verification",
        outputKeys: ["verification_report"],
        completedAt: Date.now(),
      },
    });

    registerMemoryFormation(api, runtime);
    await invokeHandlersAsync(handlers, "session_shutdown", {}, createSessionContext(sessionId));

    await waitForSummaryArtifacts(runtime, 2);
    const artifacts = await listCognitionArtifacts(runtime.workspaceRoot, "summaries");
    const episodeArtifact = artifacts.find((artifact) => artifact.fileName.includes("episode"));
    expect(episodeArtifact).toBeDefined();
    const content = await readCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      fileName: episodeArtifact!.fileName,
    });
    expect(content).toContain("[EpisodeNote]");
    expect(content).toContain("episode_kind: session_episode");
    expect(content).toContain(`session_scope: ${sessionId}`);
    expect(content).toContain("recent_events: skill_completed:verification");
    expect(runtime.events.query(sessionId).map((event) => event.type)).toContain(
      "memory_episode_written",
    );
  });

  test("formation guidance can suppress low-signal procedure notes without stable anchors", async () => {
    const { api } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-formation-guidance";

    const policy = createEmptyMemoryAdaptationPolicy(1731000000500);
    policy.strategies.procedure = {
      attempts: 6,
      useful: 0,
      useless: 6,
      lastObservedAt: 1731000000500,
      lastUsefulAt: null,
    };
    const adaptationPath = resolveMemoryAdaptationPolicyPath(runtime.workspaceRoot);
    await mkdir(dirname(adaptationPath), { recursive: true });
    await writeFile(adaptationPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

    registerMemoryFormation(api, runtime);
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      payload: {
        schema: "brewva.verification.outcome.v1",
        level: "standard",
        outcome: "pass",
        recommendation: "repeat the same verification command",
        activeSkill: "implementation",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await listCognitionArtifacts(runtime.workspaceRoot, "reference")).toHaveLength(0);
  });
});
