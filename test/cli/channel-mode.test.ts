import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  SUPPORTED_CHANNELS,
  canonicalizeInboundTurnSession,
  collectPromptTurnOutputs,
  resolveSupportedChannel,
} from "../../packages/brewva-cli/src/channel-mode.js";
import type { TurnEnvelope } from "../../packages/brewva-runtime/src/channels/turn.js";

type SessionLike = {
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  sendUserMessage: (content: string) => Promise<void>;
  agent: {
    waitForIdle: () => Promise<void>;
  };
};

function createSessionMock(eventsToEmit: AgentSessionEvent[]): SessionLike {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  return {
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async sendUserMessage(_content: string): Promise<void> {
      for (const event of eventsToEmit) {
        listener?.(event);
      }
    },
    agent: {
      async waitForIdle(): Promise<void> {
        return;
      },
    },
  };
}

describe("channel mode prompt output collector", () => {
  test("resolves supported channel aliases and rejects unsupported ids", () => {
    expect(SUPPORTED_CHANNELS).toEqual(["telegram"]);
    expect(resolveSupportedChannel("telegram")).toBe("telegram");
    expect(resolveSupportedChannel("TG")).toBe("telegram");
    expect(resolveSupportedChannel("discord")).toBeNull();
  });

  test("canonicalizeInboundTurnSession keeps turn when session id already matches", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "user",
      sessionId: "agent-session",
      turnId: "turn-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: "hello" }],
    };
    const canonical = canonicalizeInboundTurnSession(turn, "agent-session");
    expect(canonical).toBe(turn);
  });

  test("canonicalizeInboundTurnSession remaps channel session id into metadata", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "user",
      sessionId: "channel-session",
      turnId: "turn-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: "hello" }],
      meta: { source: "telegram" },
    };
    const canonical = canonicalizeInboundTurnSession(turn, "agent-session");
    expect(canonical.sessionId).toBe("agent-session");
    expect(canonical.meta).toEqual({
      source: "telegram",
      channelSessionId: "channel-session",
    });
  });

  test("collects tool outputs and latest assistant message text", async () => {
    const session = createSessionMock([
      {
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "exec",
        result: {
          content: [{ type: "text", text: "done" }],
        },
        isError: false,
      } as AgentSessionEvent,
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "intermediate" }],
        },
      } as AgentSessionEvent,
      {
        type: "tool_execution_end",
        toolCallId: "tc-2",
        toolName: "read",
        result: "missing file",
        isError: true,
      } as AgentSessionEvent,
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
        },
      } as AgentSessionEvent,
    ]);

    const outputs = await collectPromptTurnOutputs(
      session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
      "hello",
    );

    expect(outputs.assistantText).toBe("final answer");
    expect(outputs.toolOutputs).toHaveLength(2);
    expect(outputs.toolOutputs[0]?.text).toContain("Tool exec (tc-1) completed");
    expect(outputs.toolOutputs[0]?.text).toContain("done");
    expect(outputs.toolOutputs[1]?.text).toContain("Tool read (tc-2) failed");
    expect(outputs.toolOutputs[1]?.text).toContain("missing file");
  });

  test("deduplicates repeated tool_execution_end events with same toolCallId", async () => {
    const repeatedEvent = {
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "exec",
      result: "done",
      isError: false,
    } as AgentSessionEvent;
    const session = createSessionMock([repeatedEvent, repeatedEvent]);

    const outputs = await collectPromptTurnOutputs(
      session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
      "hello",
    );

    expect(outputs.toolOutputs).toHaveLength(1);
    expect(outputs.toolOutputs[0]?.toolCallId).toBe("tc-1");
  });

  test("ignores non-assistant message_end events", async () => {
    const session = createSessionMock([
      {
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "user message" }],
        },
      } as AgentSessionEvent,
    ]);

    const outputs = await collectPromptTurnOutputs(
      session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
      "hello",
    );

    expect(outputs.assistantText).toBe("");
    expect(outputs.toolOutputs).toEqual([]);
  });
});
