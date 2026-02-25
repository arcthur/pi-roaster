import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerContextTransform,
  registerEventStream,
  registerLedgerWriter,
  registerQualityGate,
} from "@brewva/brewva-extensions";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime } from "@brewva/brewva-runtime";
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
          memory: {
            enabled: true,
            dailyRefreshHourLocal: 0,
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
      "packages/brewva-extensions/src/index.ts",
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
    expect(mergedContent.includes("[WorkingMemory]")).toBe(true);
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

    const ledgerRows = runtime.ledger.list(sessionId);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.tool).toBe("edit");

    const recorded = runtime.events.query(sessionId, { type: "tool_result_recorded", last: 1 })[0];
    expect(recorded).toBeDefined();
    const payload = recorded?.payload as { ledgerId?: string } | undefined;
    expect(payload?.ledgerId).toBe(ledgerRows[0]?.id);
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
    expect(reloaded.ledger.list(sessionId)).toHaveLength(1);
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
      success: true,
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
      turnsBySession: Map<string, number>;
      toolCallsBySession: Map<string, number>;
    };
    expect(sessionState.turnsBySession.has(sessionId)).toBe(false);
    expect(sessionState.toolCallsBySession.has(sessionId)).toBe(false);
    expect(((runtime as any).contextBudget.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
    expect(((runtime as any).costTracker.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
  });

  test("given blocked tool_call, when handlers run with stopOnBlock, then tool_call is recorded and tool_call_marked is omitted", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-blocked-"));
    mkdirSync(join(workspace, "skills/base/patching"), { recursive: true });
    writeFileSync(
      join(workspace, "skills/base/patching/SKILL.md"),
      `---
name: patching
description: patching skill
tier: base
tags: [patching]
tools:
  required: [read]
  optional: [edit]
  denied: [write]
budget:
  max_tool_calls: 10
  max_tokens: 10000
---
patching`,
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-blocked-1";
    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);

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
    mkdirSync(join(workspace, ".brewva/skills/base/maxcalls"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/base/maxcalls/SKILL.md"),
      `---
name: maxcalls
description: maxcalls skill
tier: base
tags: [maxcalls]
tools:
  required: [read]
  optional: [edit]
  denied: [write]
budget:
  max_tool_calls: 1
  max_tokens: 10000
---
maxcalls`,
      "utf8",
    );

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.security.mode = "strict";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "ext-max-tool-calls-1";
    expect(runtime.skills.activate(sessionId, "maxcalls").ok).toBe(true);
    expect(runtime.skills.getActive(sessionId)?.contract.budget.maxToolCalls).toBe(1);

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
