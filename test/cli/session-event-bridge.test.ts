import { describe, expect, test } from "bun:test";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { registerRuntimeCoreEventBridge } from "../../packages/brewva-cli/src/session-event-bridge.js";

type RecordedEvent = {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: Record<string, unknown>;
};

type RecordedUsage = {
  sessionId: string;
  model: string;
  totalTokens: number;
  costUsd: number;
};

function createRuntimeMock() {
  const events: RecordedEvent[] = [];
  const usage: RecordedUsage[] = [];
  const costSummaryBySession = new Map<string, Record<string, unknown>>();
  const turnStarts: Array<{ sessionId: string; turnIndex: number }> = [];

  const runtime = {
    recordEvent(input: RecordedEvent): void {
      events.push({ ...input });
    },
    onTurnStart(sessionId: string, turnIndex: number): void {
      turnStarts.push({ sessionId, turnIndex });
    },
    recordAssistantUsage(input: {
      sessionId: string;
      model: string;
      totalTokens: number;
      costUsd: number;
    }): void {
      usage.push({
        sessionId: input.sessionId,
        model: input.model,
        totalTokens: input.totalTokens,
        costUsd: input.costUsd,
      });
    },
    getCostSummary(sessionId: string): Record<string, unknown> {
      return costSummaryBySession.get(sessionId) ?? { totalTokens: 0, totalCostUsd: 0 };
    },
  } as unknown as BrewvaRuntime;

  return {
    runtime,
    events,
    usage,
    costSummaryBySession,
    turnStarts,
  };
}

function createSessionMock(initialSessionId: string) {
  let currentSessionId = initialSessionId;
  let listener: ((event: AgentSessionEvent) => void) | undefined;

  return {
    session: {
      sessionManager: {
        getSessionId(): string {
          return currentSessionId;
        },
      },
      subscribe(fn: (event: AgentSessionEvent) => void): () => void {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
    setSessionId(next: string): void {
      currentSessionId = next;
    },
    emit(event: AgentSessionEvent): void {
      if (!listener) {
        throw new Error("bridge listener is not registered");
      }
      listener(event);
    },
  };
}

function createTurnEndEvent(toolResults: unknown[] = []): AgentSessionEvent {
  return {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      timestamp: Date.now(),
    },
    toolResults,
  } as AgentSessionEvent;
}

describe("session event bridge", () => {
  test("reads session id at event time instead of capture time", () => {
    const { runtime, events, turnStarts } = createRuntimeMock();
    const sessionMock = createSessionMock("session-a");

    registerRuntimeCoreEventBridge(runtime, sessionMock.session);

    sessionMock.emit({ type: "turn_start" } as AgentSessionEvent);
    sessionMock.emit(createTurnEndEvent());
    sessionMock.setSessionId("session-b");
    sessionMock.emit({ type: "turn_start" } as AgentSessionEvent);
    sessionMock.emit(createTurnEndEvent());

    const turnStartEvents = events.filter((event) => event.type === "turn_start");
    expect(turnStartEvents).toHaveLength(2);
    expect(turnStartEvents[0]?.sessionId).toBe("session-a");
    expect(turnStartEvents[1]?.sessionId).toBe("session-b");
    expect(turnStartEvents[0]?.turn).toBe(0);
    expect(turnStartEvents[1]?.turn).toBe(1);

    expect(turnStarts).toEqual([
      { sessionId: "session-a", turnIndex: 0 },
      { sessionId: "session-b", turnIndex: 1 },
    ]);
  });

  test("records agent_end cost summary for the active session", () => {
    const { runtime, events, costSummaryBySession } = createRuntimeMock();
    const sessionMock = createSessionMock("session-a");

    costSummaryBySession.set("session-a", { totalTokens: 11, totalCostUsd: 0.11 });
    costSummaryBySession.set("session-b", { totalTokens: 22, totalCostUsd: 0.22 });

    registerRuntimeCoreEventBridge(runtime, sessionMock.session);

    sessionMock.emit({ type: "agent_end", messages: [{ role: "assistant" }] } as AgentSessionEvent);
    sessionMock.setSessionId("session-b");
    sessionMock.emit({
      type: "agent_end",
      messages: [{ role: "assistant" }, { role: "assistant" }],
    } as AgentSessionEvent);

    const agentEndEvents = events.filter((event) => event.type === "agent_end");
    expect(agentEndEvents).toHaveLength(2);
    expect(agentEndEvents[0]?.sessionId).toBe("session-a");
    expect(agentEndEvents[1]?.sessionId).toBe("session-b");
    expect(agentEndEvents[0]?.payload?.messageCount).toBe(1);
    expect(agentEndEvents[1]?.payload?.messageCount).toBe(2);
    expect((agentEndEvents[0]?.payload?.costSummary as { totalTokens?: number })?.totalTokens).toBe(
      11,
    );
    expect((agentEndEvents[1]?.payload?.costSummary as { totalTokens?: number })?.totalTokens).toBe(
      22,
    );
  });

  test("records assistant usage from message_end only when usage exists", () => {
    const { runtime, usage } = createRuntimeMock();
    const sessionMock = createSessionMock("usage-session");

    registerRuntimeCoreEventBridge(runtime, sessionMock.session);

    sessionMock.emit({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: Date.now(),
        usage: { totalTokens: 10, cost: { total: 1 } },
      },
    } as AgentSessionEvent);

    sessionMock.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
        provider: "openai",
        model: "gpt-test",
        usage: {
          input: 3,
          output: 4,
          cacheRead: 1,
          cacheWrite: 0,
          totalTokens: 8,
          cost: { total: 0.02 },
        },
      },
    } as AgentSessionEvent);

    expect(usage).toHaveLength(1);
    expect(usage[0]?.sessionId).toBe("usage-session");
    expect(usage[0]?.model).toBe("openai/gpt-test");
    expect(usage[0]?.totalTokens).toBe(8);
    expect(usage[0]?.costUsd).toBe(0.02);
  });

  test("records tool_execution lifecycle events", () => {
    const { runtime, events } = createRuntimeMock();
    const sessionMock = createSessionMock("tool-events-session");

    registerRuntimeCoreEventBridge(runtime, sessionMock.session);

    sessionMock.emit({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "exec",
      args: { command: "echo start" },
    } as AgentSessionEvent);
    sessionMock.emit({
      type: "tool_execution_update",
      toolCallId: "tc-1",
      toolName: "exec",
      args: { command: "echo start" },
      partialResult: "running",
    } as AgentSessionEvent);
    sessionMock.emit({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "exec",
      result: "done",
      isError: false,
    } as AgentSessionEvent);

    const toolEvents = events.filter((event) => event.type.startsWith("tool_execution_"));
    expect(toolEvents).toHaveLength(3);
    expect(toolEvents[0]?.type).toBe("tool_execution_start");
    expect(toolEvents[1]?.type).toBe("tool_execution_update");
    expect(toolEvents[2]?.type).toBe("tool_execution_end");
    expect(toolEvents[0]?.payload?.toolCallId).toBe("tc-1");
    expect(toolEvents[2]?.payload?.isError).toBe(false);
  });
});
