import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listCognitionArtifacts } from "@brewva/brewva-deliberation";
import { registerDebugLoop } from "@brewva/brewva-gateway/runtime-plugins";
import {
  BrewvaRuntime,
  DEBUG_LOOP_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
  DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
  DEFAULT_BREWVA_CONFIG,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  type BrewvaStructuredEvent,
  type ProposalRecord,
} from "@brewva/brewva-runtime";
import { createSkillCompleteTool, createSkillLoadTool } from "@brewva/brewva-tools";
import { createMockExtensionAPI, invokeHandlers } from "../helpers/extension.js";
import { createTestWorkspace, writeTestConfig } from "../helpers/workspace.js";

type ToolExecutionContext = Parameters<ReturnType<typeof createSkillLoadTool>["execute"]>[4];

function repoRoot(): string {
  return process.cwd();
}

function createSkillWorkspace(name: string): string {
  const workspace = createTestWorkspace(name);
  writeTestConfig(workspace, structuredClone(DEFAULT_BREWVA_CONFIG));
  symlinkSync(
    join(repoRoot(), "skills"),
    join(workspace, "skills"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return workspace;
}

function artifactPath(workspace: string, sessionId: string, fileName: string): string {
  const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
  return join(workspace, ".orchestrator/artifacts/sessions", `sess_${encoded}`, fileName);
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

function createContext(
  sessionId: string,
  workspace: string,
  leafId?: string,
): {
  cwd: string;
  sessionManager: { getSessionId(): string; getLeafId(): string | undefined };
} {
  return {
    cwd: workspace,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      getLeafId() {
        return leafId;
      },
    },
  };
}

function toToolContext(ctx: ReturnType<typeof createContext>): ToolExecutionContext {
  return ctx as ToolExecutionContext;
}

async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 1_500;
  const intervalMs = options.intervalMs ?? 10;
  const startedAt = Date.now();
  let lastValue: T | undefined;

  while (Date.now() - startedAt <= timeoutMs) {
    lastValue = await probe();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    options.label ?? "Timed out while waiting for asynchronous debug-loop side effects.",
  );
}

type DebugLoopFixture = {
  workspace: string;
  runtime: BrewvaRuntime;
  handlers: ReturnType<typeof createMockExtensionAPI>["handlers"];
  ctx: ReturnType<typeof createContext>;
  toolCtx: ToolExecutionContext;
  loadTool: ReturnType<typeof createSkillLoadTool>;
  completeTool: ReturnType<typeof createSkillCompleteTool>;
  emitRuntimeEvent(event: BrewvaStructuredEvent): void;
};

function createDebugLoopFixture(
  workspaceName: string,
  sessionId: string,
  leafId: string,
): DebugLoopFixture {
  const workspace = createSkillWorkspace(workspaceName);
  const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
  const listeners: Array<(event: BrewvaStructuredEvent) => void> = [];
  const originalSubscribe = runtime.events.subscribe.bind(runtime.events);
  (
    runtime.events as unknown as {
      subscribe(listener: (event: BrewvaStructuredEvent) => void): () => void;
    }
  ).subscribe = (listener) => {
    listeners.push(listener);
    return originalSubscribe(listener);
  };

  try {
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);
    const ctx = createContext(sessionId, workspace, leafId);
    const toolCtx = toToolContext(ctx);
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    return {
      workspace,
      runtime,
      handlers,
      ctx,
      toolCtx,
      loadTool,
      completeTool,
      emitRuntimeEvent(event) {
        for (const listener of listeners) {
          listener(event);
        }
      },
    };
  } finally {
    (
      runtime.events as unknown as {
        subscribe(listener: (event: BrewvaStructuredEvent) => void): () => void;
      }
    ).subscribe = originalSubscribe;
  }
}

async function scheduleInitialRetry(
  fixture: DebugLoopFixture,
  outputs: Record<string, unknown> = {
    change_set: "updated one line",
    files_changed: ["src/example.ts"],
    verification_evidence: "pending verification",
  },
): Promise<string> {
  const sessionId = fixture.ctx.sessionManager.getSessionId();
  await fixture.loadTool.execute(
    "tc-load",
    { name: "implementation" },
    undefined,
    undefined,
    fixture.toolCtx,
  );
  fixture.runtime.tools.markCall(sessionId, "edit");
  invokeHandlers(
    fixture.handlers,
    "tool_call",
    {
      toolCallId: "tc-complete",
      toolName: "skill_complete",
      input: { outputs },
    },
    fixture.ctx,
  );

  const result = await fixture.completeTool.execute(
    "tc-complete",
    { outputs },
    undefined,
    undefined,
    fixture.toolCtx,
  );
  await waitFor(
    () =>
      fixture.runtime.proposals.list(sessionId, {
        kind: "context_packet",
        limit: 1,
      })[0] as ProposalRecord<"context_packet"> | undefined,
    (record) => record?.proposal.payload.packetKey === "debug-loop:status",
    {
      label: "Timed out while waiting for debug-loop status packet.",
    },
  );
  return extractTextContent(result as { content: Array<{ type: string; text?: string }> });
}

function recordImplementationFailure(
  runtime: BrewvaRuntime,
  sessionId: string,
  timestamp: number,
): void {
  runtime.skills.activate(sessionId, "implementation");
  runtime.events.record({
    sessionId,
    type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
    timestamp,
    payload: {
      outcome: "fail",
      activeSkill: "implementation",
      failedChecks: ["tests_failed"],
      missingEvidence: [],
      rootCause: "missing branch handling",
      recommendation: "add branch coverage",
      commandsExecuted: [],
      evidenceIds: [`evidence-${timestamp}`],
      evidence: [],
    },
  });
}

describe("extension debug loop", () => {
  test("failed implementation completion arms debug loop and persists failure artifacts", async () => {
    const workspace = createSkillWorkspace("ext-debug-loop");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);

    const sessionId = "ext-debug-loop-1";
    const ctx = createContext(sessionId, workspace, "leaf-debug-loop");
    const toolCtx = toToolContext(ctx);
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute("tc-load", { name: "implementation" }, undefined, undefined, toolCtx);
    runtime.tools.markCall(sessionId, "edit");

    const outputs = {
      change_set: "updated one line",
      files_changed: ["src/example.ts"],
      verification_evidence: "pending verification",
    };

    invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-complete",
        toolName: "skill_complete",
        input: { outputs },
      },
      ctx,
    );

    const result = await completeTool.execute(
      "tc-complete",
      { outputs },
      undefined,
      undefined,
      toolCtx,
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });

    expect(text).toContain("Debug loop scheduled. Next step: runtime-forensics");
    expect(text).toContain("failure-case.json");
    expect(text).toContain("debug-loop.json");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("runtime-forensics");
    expect(runtime.skills.getCascadeIntent(sessionId)?.steps.map((step) => step.skill)).toEqual([
      "runtime-forensics",
      "debugging",
      "implementation",
    ]);
    expect(
      runtime.events.query(sessionId, { type: DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE, last: 1 }),
    ).toHaveLength(1);
    const retryScheduledEvent = runtime.events.query(sessionId, {
      type: DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
      last: 1,
    })[0];
    expect(retryScheduledEvent?.payload?.committedBy).toBe("direct_cascade_start");
    expect(retryScheduledEvent?.payload?.intentId).toBe(
      runtime.skills.getCascadeIntent(sessionId)?.id,
    );

    const failureCase = readJsonFile<{
      attemptedOutputs?: Record<string, unknown>;
      failedChecks: string[];
    }>(artifactPath(workspace, sessionId, "failure-case.json"));
    expect(failureCase.attemptedOutputs?.change_set).toBe("updated one line");

    const debugLoop = readJsonFile<{ status: string; retryCount: number }>(
      artifactPath(workspace, sessionId, "debug-loop.json"),
    );
    expect(debugLoop.status).toBe("forensics");
    expect(debugLoop.retryCount).toBe(0);
    const latestContextPacket = await waitFor(
      () =>
        runtime.proposals.list(sessionId, {
          kind: "context_packet",
          limit: 1,
        })[0] as ProposalRecord<"context_packet"> | undefined,
      (record) => record?.proposal.payload.packetKey === "debug-loop:status",
      {
        label: "Timed out while waiting for initial debug-loop status packet.",
      },
    );
    expect(latestContextPacket?.proposal.payload.packetKey).toBe("debug-loop:status");
    expect(latestContextPacket?.proposal.payload.scopeId).toBe("leaf-debug-loop");
    expect(latestContextPacket?.proposal.payload.profile).toBe("status_summary");

    const scopedInjection = await waitFor(
      () =>
        runtime.context.buildInjection(sessionId, "resume debugging", undefined, "leaf-debug-loop"),
      (injection) => injection.text.includes("summary_kind: debug_loop_retry"),
      {
        label: "Timed out while waiting for retry summary injection.",
      },
    );
    expect(scopedInjection.text).toContain("[StatusSummary]");
    expect(scopedInjection.text).toContain("summary_kind: debug_loop_retry");
    expect(scopedInjection.text).toContain("mode: retry_scheduled");
    expect(scopedInjection.text).toContain("next_skill: runtime-forensics");
    expect(scopedInjection.text).toContain("references:");

    const otherLeafInjection = await runtime.context.buildInjection(
      sessionId,
      "resume debugging",
      undefined,
      "leaf-other",
    );
    expect(otherLeafInjection.text).not.toContain("[DebugLoopSummary]");
  });

  test("existing runtime trace skips runtime-forensics and jumps straight to debugging", async () => {
    const workspace = createSkillWorkspace("ext-debug-loop-trace");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);

    const sessionId = "ext-debug-loop-2";
    const ctx = createContext(sessionId, workspace, "leaf-debug-loop-2");
    const toolCtx = toToolContext(ctx);
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    runtime.skills.activate(sessionId, "runtime-forensics");
    runtime.skills.complete(sessionId, {
      runtime_trace: "Observed repeated guard arming, status polling, and late completion retries.",
      session_summary:
        "The session stayed in analysis mode and never converged on a stable completion contract.",
      artifact_findings: "No durable artifact explained the repeated guard resets.",
    });

    await loadTool.execute("tc-load", { name: "implementation" }, undefined, undefined, toolCtx);
    runtime.tools.markCall(sessionId, "edit");

    const outputs = {
      change_set: "updated one line",
      files_changed: ["src/example.ts"],
      verification_evidence: "pending verification",
    };

    invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-complete",
        toolName: "skill_complete",
        input: { outputs },
      },
      ctx,
    );

    const result = await completeTool.execute(
      "tc-complete",
      { outputs },
      undefined,
      undefined,
      toolCtx,
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });

    expect(text).toContain("Debug loop scheduled. Next step: debugging");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("debugging");
    expect(runtime.skills.getCascadeIntent(sessionId)?.steps.map((step) => step.skill)).toEqual([
      "debugging",
      "implementation",
    ]);
  });

  test("agent end and session shutdown persist latest-wins deterministic handoff packets", async () => {
    const workspace = createSkillWorkspace("ext-debug-loop-handoff");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);

    const sessionId = "ext-debug-loop-3";
    const ctx = createContext(sessionId, workspace, "leaf-debug-loop-3");
    const toolCtx = toToolContext(ctx);
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute("tc-load", { name: "implementation" }, undefined, undefined, toolCtx);
    runtime.tools.markCall(sessionId, "edit");

    const outputs = {
      change_set: "updated one line",
      files_changed: ["src/example.ts"],
      verification_evidence: "pending verification",
    };
    invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-complete",
        toolName: "skill_complete",
        input: { outputs },
      },
      ctx,
    );
    await completeTool.execute("tc-complete", { outputs }, undefined, undefined, toolCtx);

    runtime.events.record({ sessionId, type: "agent_end" });
    let handoff = readJsonFile<{
      reason: string;
      nextAction: string;
      debugLoop: { status: string } | null;
    }>(artifactPath(workspace, sessionId, "handoff.json"));
    expect(handoff.reason).toBe("agent_end");
    expect(handoff.nextAction).toBe("load:runtime-forensics");
    expect(handoff.debugLoop?.status).toBe("forensics");
    let injection = await waitFor(
      () => runtime.context.buildInjection(sessionId, "resume", undefined, "leaf-debug-loop-3"),
      (candidate) => candidate.text.includes("reason: agent_end"),
      {
        label: "Timed out while waiting for agent_end handoff summary injection.",
      },
    );
    expect(injection.text).toContain("[StatusSummary]");
    expect(injection.text).toContain("summary_kind: debug_loop_handoff");
    expect(injection.text).toContain("mode: handoff");
    expect(injection.text).toContain("reason: agent_end");
    expect(injection.text).not.toContain("mode: retry_scheduled");

    runtime.events.record({ sessionId, type: "session_shutdown" });
    handoff = readJsonFile<{
      reason: string;
      nextAction: string;
      debugLoop: { status: string } | null;
    }>(artifactPath(workspace, sessionId, "handoff.json"));
    expect(handoff.reason).toBe("session_shutdown");
    expect(handoff.nextAction).toBe("load:runtime-forensics");
    injection = await waitFor(
      () => runtime.context.buildInjection(sessionId, "resume", undefined, "leaf-debug-loop-3"),
      (candidate) => candidate.text.includes("reason: session_shutdown"),
      {
        label: "Timed out while waiting for session_shutdown handoff summary injection.",
      },
    );
    expect(injection.text).toContain("summary_kind: debug_loop_handoff");
    expect(injection.text).toContain("mode: handoff");
    expect(injection.text).toContain("reason: session_shutdown");
    expect(injection.text).not.toContain("reason: agent_end");
  });

  test("terminal converged state persists debug-loop terminal handoff after successful implementation", async () => {
    const fixture = createDebugLoopFixture(
      "ext-debug-loop-converged",
      "ext-debug-loop-5",
      "leaf-debug-loop-5",
    );

    await scheduleInitialRetry(fixture);
    fixture.runtime.skills.activate("ext-debug-loop-5", "runtime-forensics");
    fixture.runtime.skills.complete("ext-debug-loop-5", {
      runtime_trace: "Observed repeated guard arming, status polling, and late completion retries.",
      session_summary:
        "The session stayed in analysis mode and never converged on a stable completion contract.",
      artifact_findings: "No durable artifact explained the repeated guard resets.",
    });
    fixture.runtime.skills.activate("ext-debug-loop-5", "debugging");
    fixture.runtime.skills.complete("ext-debug-loop-5", {
      root_cause: "null guard missing",
      fix_strategy: "add explicit null handling",
      failure_evidence: "stack trace",
    });
    fixture.runtime.skills.activate("ext-debug-loop-5", "implementation");
    fixture.runtime.skills.complete("ext-debug-loop-5", {
      change_set: "added null guard",
      files_changed: ["src/example.ts"],
      verification_evidence: "tests pass",
    });

    const debugLoop = readJsonFile<{
      status: string;
      hypothesisCount: number;
      blockedReason?: string | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-5", "debug-loop.json"));
    expect(debugLoop.status).toBe("converged");
    expect(debugLoop.hypothesisCount).toBe(1);
    expect(debugLoop.blockedReason ?? null).toBeNull();

    const handoff = readJsonFile<{
      reason: string;
      debugLoop: { status: string } | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-5", "handoff.json"));
    expect(handoff.reason).toBe("debug_loop_terminal");
    expect(handoff.debugLoop?.status).toBe("converged");

    const injection = await waitFor(
      () =>
        fixture.runtime.context.buildInjection(
          "ext-debug-loop-5",
          "resume",
          undefined,
          "leaf-debug-loop-5",
        ),
      (candidate) => candidate.text.includes("reason: debug_loop_terminal"),
      {
        label: "Timed out while waiting for terminal handoff summary injection.",
      },
    );
    expect(injection.text).toContain("summary_kind: debug_loop_handoff");
    expect(injection.text).toContain("reason: debug_loop_terminal");

    const referenceArtifacts = await listCognitionArtifacts(
      fixture.runtime.workspaceRoot,
      "reference",
    );
    expect(
      referenceArtifacts.some((artifact) =>
        artifact.fileName.includes("debug-loop-converged-handoff"),
      ),
    ).toBe(true);
  });

  test("retry limit transitions debug loop into exhausted", async () => {
    const fixture = createDebugLoopFixture(
      "ext-debug-loop-retry-limit",
      "ext-debug-loop-6",
      "leaf-debug-loop-6",
    );

    await scheduleInitialRetry(fixture);
    recordImplementationFailure(fixture.runtime, "ext-debug-loop-6", 2_000);
    recordImplementationFailure(fixture.runtime, "ext-debug-loop-6", 3_000);

    const debugLoop = readJsonFile<{
      status: string;
      retryCount: number;
      blockedReason?: string | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-6", "debug-loop.json"));
    expect(debugLoop.status).toBe("exhausted");
    expect(debugLoop.retryCount).toBe(2);
    expect(debugLoop.blockedReason).toBe("retry_limit");
    expect(
      fixture.runtime.events.query("ext-debug-loop-6", {
        type: DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
      }),
    ).toHaveLength(2);

    const handoff = readJsonFile<{
      reason: string;
      nextAction: string;
      debugLoop: { status: string } | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-6", "handoff.json"));
    expect(handoff.reason).toBe("debug_loop_terminal");
    expect(handoff.nextAction).toContain("inspect:");
    expect(handoff.debugLoop?.status).toBe("exhausted");
  });

  test("session shutdown clears in-memory state so persisted hypothesis limits take effect", async () => {
    const fixture = createDebugLoopFixture(
      "ext-debug-loop-hypothesis-limit",
      "ext-debug-loop-7",
      "leaf-debug-loop-7",
    );

    await scheduleInitialRetry(fixture);
    fixture.runtime.events.record({ sessionId: "ext-debug-loop-7", type: "session_shutdown" });

    const statePath = artifactPath(fixture.workspace, "ext-debug-loop-7", "debug-loop.json");
    const persistedState = readJsonFile<Record<string, unknown>>(statePath);
    writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          ...persistedState,
          status: "implementing",
          activeSkillName: "implementation",
          hypothesisCount: 3,
          updatedAt: 4_000,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    recordImplementationFailure(fixture.runtime, "ext-debug-loop-7", 5_000);

    const debugLoop = readJsonFile<{
      status: string;
      hypothesisCount: number;
      blockedReason?: string | null;
    }>(statePath);
    expect(debugLoop.status).toBe("exhausted");
    expect(debugLoop.hypothesisCount).toBe(3);
    expect(debugLoop.blockedReason).toBe("hypothesis_limit");
  });

  test("duplicate verification events do not reschedule retries twice", async () => {
    const fixture = createDebugLoopFixture(
      "ext-debug-loop-dedup",
      "ext-debug-loop-8",
      "leaf-debug-loop-8",
    );

    await scheduleInitialRetry(fixture);
    const debugLoop = readJsonFile<{
      retryCount: number;
      lastVerification?: { eventId?: string };
    }>(artifactPath(fixture.workspace, "ext-debug-loop-8", "debug-loop.json"));
    const duplicateEventId = debugLoop.lastVerification?.eventId;
    if (!duplicateEventId) {
      throw new Error("Expected debug loop state to persist the last verification event id.");
    }

    fixture.emitRuntimeEvent({
      schema: "brewva.event.v1",
      id: duplicateEventId,
      sessionId: "ext-debug-loop-8",
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      category: "verification",
      timestamp: 6_000,
      isoTime: new Date(6_000).toISOString(),
      turn: 1,
      payload: {
        outcome: "fail",
        activeSkill: "implementation",
        failedChecks: ["tests_failed"],
        missingEvidence: [],
        rootCause: "duplicate event should be ignored",
        recommendation: "none",
        commandsExecuted: [],
        evidenceIds: ["duplicate"],
        evidence: [],
      },
    });

    const updatedState = readJsonFile<{ retryCount: number }>(
      artifactPath(fixture.workspace, "ext-debug-loop-8", "debug-loop.json"),
    );
    expect(updatedState.retryCount).toBe(debugLoop.retryCount);
    expect(
      fixture.runtime.events.query("ext-debug-loop-8", {
        type: DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
      }),
    ).toHaveLength(1);
  });

  test("cascade start failures push debug loop into blocked terminal state", async () => {
    const fixture = createDebugLoopFixture(
      "ext-debug-loop-blocked",
      "ext-debug-loop-9",
      "leaf-debug-loop-9",
    );
    const originalStartCascade = fixture.runtime.skills.startCascade.bind(fixture.runtime.skills);
    (
      fixture.runtime.skills as unknown as {
        startCascade: typeof originalStartCascade;
      }
    ).startCascade = () => {
      return {
        ok: false,
        reason: "forced_blocked_path",
      };
    };

    try {
      await scheduleInitialRetry(fixture);
    } finally {
      (
        fixture.runtime.skills as unknown as {
          startCascade: typeof originalStartCascade;
        }
      ).startCascade = originalStartCascade;
    }

    const debugLoop = readJsonFile<{
      status: string;
      blockedReason?: string | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-9", "debug-loop.json"));
    expect(debugLoop.status).toBe("blocked");
    expect(debugLoop.blockedReason).toBe("forced_blocked_path");

    const handoff = readJsonFile<{
      reason: string;
      debugLoop: { status: string } | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-9", "handoff.json"));
    expect(handoff.reason).toBe("debug_loop_terminal");
    expect(handoff.debugLoop?.status).toBe("blocked");
  });

  test("artifact persistence failures are recorded as explicit runtime events", async () => {
    const workspace = createSkillWorkspace("ext-debug-loop-persist-fail");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);

    const sessionId = "ext-debug-loop-4";
    const ctx = createContext(sessionId, workspace, "leaf-debug-loop-4");
    const toolCtx = toToolContext(ctx);
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    mkdirSync(join(workspace, ".orchestrator", "artifacts"), { recursive: true });
    writeFileSync(join(workspace, ".orchestrator", "artifacts", "sessions"), "blocked", "utf8");

    await loadTool.execute("tc-load", { name: "implementation" }, undefined, undefined, toolCtx);
    runtime.tools.markCall(sessionId, "edit");

    const outputs = {
      change_set: "updated one line",
      files_changed: ["src/example.ts"],
      verification_evidence: "pending verification",
    };

    invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-complete",
        toolName: "skill_complete",
        input: { outputs },
      },
      ctx,
    );
    await completeTool.execute("tc-complete", { outputs }, undefined, undefined, toolCtx);

    const events = runtime.events.query(sessionId, {
      type: DEBUG_LOOP_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.payload?.artifactKind === "failure_case")).toBe(true);
    expect(events.some((event) => event.payload?.artifactKind === "state")).toBe(true);
    const latestContextPacket = await waitFor(
      () =>
        runtime.proposals.list(sessionId, {
          kind: "context_packet",
          limit: 1,
        })[0] as ProposalRecord<"context_packet"> | undefined,
      (record) => record?.receipt.decision === "accept",
      {
        label: "Timed out while waiting for debug-loop summary packet after persist failure.",
      },
    );
    if (!latestContextPacket) {
      throw new Error("Expected a debug-loop context packet after persist failure.");
    }
    expect(latestContextPacket.receipt.decision).toBe("accept");
    const injection = await waitFor(
      () =>
        runtime.context.buildInjection(
          sessionId,
          "resume debugging",
          undefined,
          "leaf-debug-loop-4",
        ),
      (candidate) => candidate.text.includes("mode: retry_scheduled"),
      {
        label: "Timed out while waiting for retry summary injection after persist failure.",
      },
    );
    expect(injection.text).toContain("[StatusSummary]");
    expect(injection.text).toContain("mode: retry_scheduled");
  });
});
