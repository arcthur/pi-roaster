import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerContextTransform,
  registerEventStream,
  registerLedgerWriter,
  registerQualityGate,
} from "@brewva/brewva-gateway/runtime-plugins";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  createObsQueryTool,
  createObsSloAssertTool,
  createOutputSearchTool,
} from "@brewva/brewva-tools";
import {
  AuthStorage,
  createEventBus,
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { createMockExtensionAPI, invokeHandlers } from "../helpers/extension.js";

describe("Extension integration: observability", () => {
  test("given extension runner contract, when emitBeforeAgentStart executes, then brewva context message is included", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-dual-injection-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });
    mkdirSync(join(workspace, ".brewva"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          projection: {
            enabled: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const agentDir = join(workspace, ".brewva-agent-test-dual-injection");

    const extensionPath = join(workspace, "brewva-inline-extension.ts");
    const brewvaExtensionEntry = join(
      process.cwd(),
      "packages/brewva-gateway/src/runtime-plugins/index.ts",
    ).replaceAll("\\", "/");
    writeFileSync(
      extensionPath,
      [
        `import { createBrewvaExtension } from '${brewvaExtensionEntry}';`,
        `export default createBrewvaExtension({ registerTools: false, cwd: ${JSON.stringify(workspace)} });`,
      ].join("\n"),
      "utf8",
    );

    const loaded = await discoverAndLoadExtensions(
      [extensionPath],
      workspace,
      agentDir,
      createEventBus(),
    );
    expect(loaded.errors).toHaveLength(0);

    const sessionManager = SessionManager.inMemory(workspace);
    const modelRegistry = new ModelRegistry(
      AuthStorage.create(join(workspace, ".auth-test.json")),
      join(workspace, ".models-test.json"),
    );
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      workspace,
      sessionManager,
      modelRegistry,
    );

    runner.bindCore(
      {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        appendEntry: () => undefined,
        setSessionName: () => undefined,
        getSessionName: () => undefined,
        setLabel: () => undefined,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => undefined,
        refreshTools: () => undefined,
        getCommands: () => [],
        setModel: async () => true,
        getThinkingLevel: () => "medium",
        setThinkingLevel: () => undefined,
      },
      {
        getModel: () => undefined,
        isIdle: () => true,
        abort: () => undefined,
        hasPendingMessages: () => false,
        shutdown: () => undefined,
        getContextUsage: () => ({ tokens: 700, contextWindow: 4000, percent: 0.175 }),
        compact: () => undefined,
        getSystemPrompt: () => "base",
      },
    );

    await runner.emit({ type: "agent_end", messages: [] });

    const result = await runner.emitBeforeAgentStart(
      "continue fixing flaky tests",
      undefined,
      "base",
    );
    const messageTypes = (result?.messages ?? []).map((message) => message.customType);
    const mergedContent = (result?.messages ?? [])
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");

    expect(result?.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
    expect(messageTypes).toEqual(["brewva-context-injection"]);
    expect(mergedContent.length).toBeGreaterThan(0);
    expect(mergedContent.includes("brewva.memory-recall")).toBe(false);
  });

  test("given tool_call and tool_result events, when observability handlers run, then ledger and correlation events are persisted", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-obs-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/a.ts"), "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-obs-1";

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);
    registerContextTransform(api, runtime);
    registerQualityGate(api, runtime);
    registerLedgerWriter(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    invokeHandlers(handlers, "session_start", {}, ctx);
    invokeHandlers(handlers, "turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);

    const toolCallId = "tc-edit-1";
    invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId,
        toolName: "edit",
        input: {
          file_path: "src/a.ts",
          old_text: "export const value = 1;\n",
          new_text: "export const value = 2;\n",
        },
      },
      ctx,
      { stopOnBlock: true },
    );

    writeFileSync(join(workspace, "src/a.ts"), "export const value = 2;\n", "utf8");

    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId,
        toolName: "edit",
        input: { file_path: "src/a.ts" },
        isError: false,
        content: [{ type: "text", text: "edited" }],
        details: { durationMs: 2 },
      },
      ctx,
    );

    const observed = runtime.events.query(sessionId, { type: "tool_output_observed", last: 1 })[0];
    expect(observed).toBeDefined();
    const observedPayload = observed?.payload as
      | {
          toolCallId?: string;
          toolName?: string;
          rawChars?: number;
          rawBytes?: number;
          rawTokens?: number;
          contextPressure?: string;
          artifactRef?: string | null;
        }
      | undefined;
    expect(observedPayload?.toolCallId).toBe(toolCallId);
    expect(observedPayload?.toolName).toBe("edit");
    expect(observedPayload?.rawChars).toBeGreaterThan(0);
    expect(observedPayload?.rawBytes).toBeGreaterThan(0);
    expect(observedPayload?.rawTokens).toBeGreaterThan(0);
    expect(typeof observedPayload?.contextPressure).toBe("string");
    expect(typeof observedPayload?.artifactRef).toBe("string");

    const artifactPersisted = runtime.events.query(sessionId, {
      type: "tool_output_artifact_persisted",
      last: 1,
    })[0];
    expect(artifactPersisted).toBeDefined();
    const artifactPersistedPayload = artifactPersisted?.payload as
      | {
          artifactRef?: string;
        }
      | undefined;
    expect(typeof artifactPersistedPayload?.artifactRef).toBe("string");
    const artifactRef = artifactPersistedPayload?.artifactRef ?? "";
    const artifactPath = join(workspace, artifactRef);
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, "utf8")).toContain("edited");

    const ledgerRows = runtime.ledger.listRows(sessionId);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.tool).toBe("edit");

    const recorded = runtime.events.query(sessionId, { type: "tool_result_recorded", last: 1 })[0];
    expect(recorded).toBeDefined();
    const payload = recorded?.payload as
      | {
          ledgerId?: string;
          outputObservation?: {
            rawChars?: number;
            rawBytes?: number;
            rawTokens?: number;
            artifactRef?: string | null;
          };
          outputArtifact?: {
            artifactRef?: string;
            rawChars?: number;
            rawBytes?: number;
            sha256?: string;
          } | null;
          outputDistillation?: {
            strategy?: string;
            summaryTokens?: number;
          } | null;
        }
      | undefined;
    expect(payload?.ledgerId).toBe(ledgerRows[0]?.id);
    expect(payload?.outputObservation?.rawChars).toBeGreaterThan(0);
    expect(payload?.outputObservation?.rawBytes).toBeGreaterThan(0);
    expect(payload?.outputObservation?.rawTokens).toBeGreaterThan(0);
    expect(typeof payload?.outputObservation?.artifactRef).toBe("string");
    expect(typeof payload?.outputArtifact?.artifactRef).toBe("string");
    expect(payload?.outputDistillation).toBeNull();
    expect(runtime.events.query(sessionId, { type: "tool_result", last: 1 })).toHaveLength(0);

    const snapshot = runtime.events.query(sessionId, {
      type: "file_snapshot_captured",
      last: 1,
    })[0];
    expect(snapshot).toBeDefined();
    const snapshotPayload = snapshot?.payload as { files?: string[] } | undefined;
    expect(snapshotPayload?.files).toContain("src/a.ts");

    const patchRecorded = runtime.events.query(sessionId, { type: "patch_recorded", last: 1 })[0];
    expect(patchRecorded).toBeDefined();
    const patchPayload = patchRecorded?.payload as
      | { changes?: Array<{ path: string; action: string }> }
      | undefined;
    expect(patchPayload?.changes).toEqual([{ path: "src/a.ts", action: "modify" }]);

    const reloaded = new BrewvaRuntime({ cwd: workspace });
    expect(reloaded.events.query(sessionId).length).toBeGreaterThan(0);
    expect(reloaded.ledger.listRows(sessionId)).toHaveLength(1);
  });

  test("given high-volume exec tool output with explicit fail verdict, when ledger writer handles tool_result, then verdict propagates into observed and distilled telemetry", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-distill-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-distill-1";

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);
    registerLedgerWriter(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    const noisyOutput = Array.from({ length: 180 }, (_value, index) =>
      index % 17 === 0
        ? `error at step ${index}: timeout while waiting for response`
        : `line ${index}: working`,
    ).join("\n");

    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-exec-distill",
        toolName: "exec",
        input: { command: "echo test" },
        isError: false,
        content: [{ type: "text", text: noisyOutput }],
        details: { durationMs: 12, verdict: "fail" },
      },
      ctx,
    );

    const observed = runtime.events.query(sessionId, {
      type: "tool_output_observed",
      last: 1,
    })[0];
    expect(observed).toBeDefined();
    const observedPayload = observed?.payload as
      | {
          isError?: boolean;
          verdict?: string;
        }
      | undefined;
    expect(observedPayload?.isError).toBe(false);
    expect(observedPayload?.verdict).toBe("fail");

    const distilled = runtime.events.query(sessionId, {
      type: "tool_output_distilled",
      last: 1,
    })[0];
    expect(distilled).toBeDefined();
    const distilledPayload = distilled?.payload as
      | {
          strategy?: string;
          rawTokens?: number;
          summaryTokens?: number;
          compressionRatio?: number;
          summaryText?: string;
          artifactRef?: string | null;
          verdict?: string;
        }
      | undefined;
    expect(distilledPayload?.strategy).toBe("exec_heuristic");
    expect(distilledPayload?.verdict).toBe("fail");
    expect((distilledPayload?.rawTokens ?? 0) > (distilledPayload?.summaryTokens ?? 0)).toBe(true);
    expect((distilledPayload?.compressionRatio ?? 1) < 1).toBe(true);
    expect((distilledPayload?.summaryText ?? "").includes("status: failed")).toBe(true);
    expect((distilledPayload?.summaryText ?? "").includes("[ExecDistilled]")).toBe(true);
    expect(typeof distilledPayload?.artifactRef).toBe("string");

    const artifactPersisted = runtime.events.query(sessionId, {
      type: "tool_output_artifact_persisted",
      last: 1,
    })[0];
    expect(artifactPersisted).toBeDefined();
    const artifactPayload = artifactPersisted?.payload as
      | {
          artifactRef?: string;
        }
      | undefined;
    expect(typeof artifactPayload?.artifactRef).toBe("string");
    const artifactRef = artifactPayload?.artifactRef ?? "";
    const artifactPath = join(workspace, artifactRef);
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, "utf8")).toContain("error at step");

    const recorded = runtime.events.query(sessionId, { type: "tool_result_recorded", last: 1 })[0];
    const recordedPayload = recorded?.payload as
      | {
          outputArtifact?: {
            artifactRef?: string;
            rawBytes?: number;
          } | null;
          outputDistillation?: {
            strategy?: string;
            rawTokens?: number;
            summaryTokens?: number;
            artifactRef?: string | null;
          } | null;
        }
      | undefined;
    expect(recordedPayload?.outputDistillation?.strategy).toBe("exec_heuristic");
    expect(typeof recordedPayload?.outputDistillation?.artifactRef).toBe("string");
    expect(typeof recordedPayload?.outputArtifact?.artifactRef).toBe("string");
    expect(
      (recordedPayload?.outputDistillation?.rawTokens ?? 0) >
        (recordedPayload?.outputDistillation?.summaryTokens ?? 0),
    ).toBe(true);
  });

  test("given process explicit inconclusive verdict, when tool_result is recorded, then verdict is inconclusive", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-running-inconclusive-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-running-inconclusive-1";

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);
    registerLedgerWriter(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-process-running",
        toolName: "process",
        input: { action: "poll", sessionId: "exec-1" },
        isError: false,
        content: [{ type: "text", text: "Process still running." }],
        details: { verdict: "inconclusive", sessionId: "exec-1" },
      },
      ctx,
    );

    const recorded = runtime.events.query(sessionId, { type: "tool_result_recorded", last: 1 })[0];
    expect(recorded).toBeDefined();
    const recordedPayload = recorded?.payload as
      | {
          verdict?: string;
          channelSuccess?: boolean;
        }
      | undefined;
    expect(recordedPayload?.verdict).toBe("inconclusive");
    expect(recordedPayload?.channelSuccess).toBe(true);

    const rows = runtime.ledger.listRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe("inconclusive");
  });

  test("given obs_query result override, when ledger writer records the tool result, then output_search can reuse the raw artifact", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-obs-query-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-obs-query-1";

    runtime.events.record({
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 780,
      },
    });
    runtime.events.record({
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 820,
      },
    });

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);
    registerLedgerWriter(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    const tool = createObsQueryTool({ runtime });
    const toolResult = await tool.execute(
      "tc-obs-query",
      {
        types: ["startup_sample"],
        where: { service: "api" },
        metric: "startupMs",
        aggregation: "p95",
      },
      undefined,
      undefined,
      ctx as never,
    );
    const details = toolResult.details as Record<string, unknown> | undefined;

    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-obs-query",
        toolName: "obs_query",
        input: {
          types: ["startup_sample"],
          where: { service: "api" },
          metric: "startupMs",
          aggregation: "p95",
        },
        isError: false,
        content: toolResult.content,
        details,
      },
      ctx,
    );

    const artifactEvent = runtime.events.query(sessionId, {
      type: "tool_output_artifact_persisted",
      last: 1,
    })[0];
    const artifactRef =
      (artifactEvent?.payload as { artifactRef?: string } | undefined)?.artifactRef ?? "";
    expect(artifactRef.length).toBeGreaterThan(0);
    expect(readFileSync(join(workspace, artifactRef), "utf8")).toContain('"toolName": "obs_query"');

    const outputSearchTool = createOutputSearchTool({ runtime });
    const outputSearchResult = await outputSearchTool.execute(
      "tc-output-search",
      { query: "startupMs" },
      undefined,
      undefined,
      ctx as never,
    );
    const outputSearchText = outputSearchResult.content
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("\n");
    expect(outputSearchText.includes(artifactRef)).toBe(true);

    const recorded = runtime.events.query(sessionId, { type: "tool_result_recorded", last: 1 })[0];
    const recordedPayload = recorded?.payload as
      | {
          outputArtifact?: {
            artifactRef?: string;
          } | null;
        }
      | undefined;
    expect(recordedPayload?.outputArtifact?.artifactRef).toBe(artifactRef);
  });

  test("given obs_slo_assert explicit verdicts, when ledger writer records the tool result, then ledger verdicts and truth sync follow the declared verdict", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-obs-assert-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-obs-assert-1";

    runtime.events.record({
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 910,
      },
    });
    runtime.events.record({
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 930,
      },
    });

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);
    registerLedgerWriter(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };
    const tool = createObsSloAssertTool({ runtime });

    const failResult = await tool.execute(
      "tc-obs-assert-fail",
      {
        types: ["startup_sample"],
        where: { service: "api" },
        metric: "startupMs",
        aggregation: "p95",
        operator: "<=",
        threshold: 800,
        minSamples: 2,
      },
      undefined,
      undefined,
      ctx as never,
    );
    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-obs-assert-fail",
        toolName: "obs_slo_assert",
        input: {
          types: ["startup_sample"],
          where: { service: "api" },
          metric: "startupMs",
          aggregation: "p95",
          operator: "<=",
          threshold: 800,
          minSamples: 2,
        },
        isError: false,
        content: failResult.content,
        details: failResult.details as Record<string, unknown> | undefined,
      },
      ctx,
    );

    const failRecorded = runtime.events.query(sessionId, {
      type: "tool_result_recorded",
      last: 1,
    })[0];
    const failPayload = failRecorded?.payload as
      | {
          verdict?: string;
          channelSuccess?: boolean;
        }
      | undefined;
    expect(failPayload?.verdict).toBe("fail");
    expect(failPayload?.channelSuccess).toBe(true);
    expect(runtime.ledger.listRows(sessionId).at(-1)?.verdict).toBe("fail");
    expect(
      runtime.truth
        .getState(sessionId)
        .facts.some(
          (fact) => fact.kind === "observability_slo_violation" && fact.status === "active",
        ),
    ).toBe(true);

    const inconclusiveResult = await tool.execute(
      "tc-obs-assert-inconclusive",
      {
        types: ["startup_sample"],
        where: { service: "api" },
        metric: "startupMs",
        aggregation: "p95",
        operator: "<=",
        threshold: 800,
        minSamples: 3,
      },
      undefined,
      undefined,
      ctx as never,
    );
    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-obs-assert-inconclusive",
        toolName: "obs_slo_assert",
        input: {
          types: ["startup_sample"],
          where: { service: "api" },
          metric: "startupMs",
          aggregation: "p95",
          operator: "<=",
          threshold: 800,
          minSamples: 3,
        },
        isError: false,
        content: inconclusiveResult.content,
        details: inconclusiveResult.details as Record<string, unknown> | undefined,
      },
      ctx,
    );

    expect(runtime.ledger.listRows(sessionId).at(-1)?.verdict).toBe("inconclusive");
  });

  test("given failed tool_execution_end without tool_result, when observability handlers run, then fallback output and ledger events are persisted", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-fallback-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-fallback-1";

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);
    registerLedgerWriter(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    invokeHandlers(handlers, "session_start", {}, ctx);
    invokeHandlers(handlers, "turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
    invokeHandlers(
      handlers,
      "tool_execution_start",
      {
        toolCallId: "tc-fallback-lsp",
        toolName: "lsp_symbols",
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "tool_execution_end",
      {
        toolCallId: "tc-fallback-lsp",
        toolName: "lsp_symbols",
        isError: true,
      },
      ctx,
    );

    const observed = runtime.events.query(sessionId, { type: "tool_output_observed", last: 1 })[0];
    expect(observed).toBeDefined();
    const observedPayload = observed?.payload as
      | {
          toolCallId?: string;
          toolName?: string;
        }
      | undefined;
    expect(observedPayload?.toolCallId).toBe("tc-fallback-lsp");
    expect(observedPayload?.toolName).toBe("lsp_symbols");

    const recorded = runtime.events.query(sessionId, { type: "tool_result_recorded", last: 1 })[0];
    expect(recorded).toBeDefined();
    const recordedPayload = recorded?.payload as
      | {
          verdict?: string;
        }
      | undefined;
    expect(recordedPayload?.verdict).toBe("fail");

    const ledgerRows = runtime.ledger.listRows(sessionId);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.tool).toBe("lsp_symbols");
    expect(
      (ledgerRows[0]?.metadata as { lifecycleFallbackReason?: string } | undefined)
        ?.lifecycleFallbackReason,
    ).toBe("tool_execution_end_without_tool_result");
  });

  test("given session_shutdown event, when observability handler runs, then in-memory runtime session state is cleared", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-shutdown-clean-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-shutdown-clean-1";

    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "edit");
    runtime.context.observeUsage(sessionId, {
      tokens: 128,
      contextWindow: 4096,
      percent: 0.03125,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo ok" },
      outputText: "ok",
      channelSuccess: true,
    });

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);

    invokeHandlers(
      handlers,
      "session_shutdown",
      {},
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    const sessionState = (runtime as any).sessionState as {
      getExistingCell: (session: string) => { turn: number; toolCalls: number } | undefined;
    };
    expect(sessionState.getExistingCell(sessionId)).toBeUndefined();
    expect(((runtime as any).contextBudget.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
    expect(((runtime as any).costTracker.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
  });

  test("given blocked tool_call, when handlers run with stopOnBlock, then tool_call is recorded and tool_call_marked is omitted", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-blocked-"));
    mkdirSync(join(workspace, ".brewva/skills/core/blocktool"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/core/blocktool/SKILL.md"),
      `---
name: blocktool
description: blocktool skill
tags: [blocktool]
intent:
  outputs: []
effects:
  allowed_effects: [workspace_read]
  denied_effects: [workspace_write]
resources:
  default_lease:
    max_tool_calls: 10
    max_tokens: 10000
  hard_ceiling:
    max_tool_calls: 20
    max_tokens: 20000
execution_hints:
  preferred_tools: [read]
  fallback_tools: [edit]
consumes: []
requires: []
---
blocktool`,
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-blocked-1";
    expect(runtime.skills.activate(sessionId, "blocktool").ok).toBe(true);

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);
    registerQualityGate(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    const toolCallId = "tc-write-1";
    const results = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId,
        toolName: "write",
        input: { file_path: "src/a.ts", content: "x" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(results.some((result) => (result as any)?.block === true)).toBe(true);
    expect(runtime.events.query(sessionId, { type: "tool_call", last: 1 })).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "tool_call_marked", last: 1 })).toHaveLength(0);
    expect(
      runtime.events.query(sessionId, { type: "file_snapshot_captured", last: 1 }),
    ).toHaveLength(0);
  });

  test("given max_tool_calls exceeded, when normal and lifecycle tools are invoked, then normal tool is blocked and skill_complete is allowed", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-max-tool-calls-"));
    mkdirSync(join(workspace, ".brewva/skills/core/maxcalls"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/core/maxcalls/SKILL.md"),
      `---
name: maxcalls
description: maxcalls skill
tags: [maxcalls]
intent:
  outputs: []
effects:
  allowed_effects: [workspace_read, workspace_write]
resources:
  default_lease:
    max_tool_calls: 1
    max_tokens: 10000
  hard_ceiling:
    max_tool_calls: 2
    max_tokens: 20000
execution_hints:
  preferred_tools: [read, edit]
  fallback_tools: []
consumes: []
requires: []
---
maxcalls`,
      "utf8",
    );

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.security.mode = "strict";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "ext-max-tool-calls-1";
    expect(runtime.skills.activate(sessionId, "maxcalls").ok).toBe(true);
    expect(
      runtime.skills.getActive(sessionId)?.contract.resources?.defaultLease?.maxToolCalls,
    ).toBe(1);

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);
    registerQualityGate(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    runtime.tools.markCall(sessionId, "read");

    const blocked = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-grep-1",
        toolName: "edit",
        input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(blocked.some((result) => (result as { block?: boolean })?.block === true)).toBe(true);

    const lifecycle = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-complete-2",
        toolName: "skill_complete",
        input: { outputs: {} },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(lifecycle.some((result) => (result as { block?: boolean })?.block === true)).toBe(false);

    expect(runtime.events.query(sessionId, { type: "tool_call" })).toHaveLength(2);
    expect(runtime.events.query(sessionId, { type: "tool_call_marked" })).toHaveLength(2);
    const blockedEvents = runtime.events.query(sessionId, { type: "tool_call_blocked" });
    expect(
      blockedEvents.some(
        (event) =>
          typeof event.payload?.reason === "string" &&
          event.payload.reason.includes("maxToolCalls"),
      ),
    ).toBe(true);
  });

  test("given rapid message updates, when event stream throttling applies, then sampled message_update events are persisted", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-throttle-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-throttle-1";

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    const originalNow = Date.now;
    let now = 10_000;
    Date.now = () => now;

    try {
      invokeHandlers(
        handlers,
        "message_start",
        { message: { role: "assistant", content: [] } },
        ctx,
      );

      invokeHandlers(
        handlers,
        "message_update",
        {
          message: { role: "assistant", content: [{ type: "text", text: "a" }] },
          assistantMessageEvent: { type: "text_delta", delta: "a" },
        },
        ctx,
      );
      now += 100;
      invokeHandlers(
        handlers,
        "message_update",
        {
          message: { role: "assistant", content: [{ type: "text", text: "ab" }] },
          assistantMessageEvent: { type: "text_delta", delta: "b" },
        },
        ctx,
      );
      now += 300;
      invokeHandlers(
        handlers,
        "message_update",
        {
          message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
          assistantMessageEvent: { type: "text_delta", delta: "c" },
        },
        ctx,
      );
    } finally {
      Date.now = originalNow;
    }

    const updates = runtime.events.query(sessionId, { type: "message_update" });
    expect(updates.length).toBe(2);
    const payload = updates[0]?.payload as any;
    expect(payload.deltaChars).toBe(1);
    expect(payload.health).toBeTruthy();
    expect(typeof payload.health.score).toBe("number");
  });
});
