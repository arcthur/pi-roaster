import { recordAssistantUsageFromMessage, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

type SessionLike = {
  sessionManager: {
    getSessionId(): string;
  };
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
};

export function registerRuntimeCoreEventBridge(
  runtime: BrewvaRuntime,
  session: SessionLike,
): () => void {
  let turnIndex = 0;

  return session.subscribe((event) => {
    const sessionId = session.sessionManager.getSessionId();

    switch (event.type) {
      case "agent_start":
        turnIndex = 0;
        runtime.events.record({
          sessionId,
          type: "agent_start",
        });
        break;
      case "turn_start":
        runtime.context.onTurnStart(sessionId, turnIndex);
        runtime.events.record({
          sessionId,
          type: "turn_start",
          turn: turnIndex,
        });
        break;
      case "turn_end": {
        const toolResults = Array.isArray((event as { toolResults?: unknown }).toolResults)
          ? (event as { toolResults: unknown[] }).toolResults.length
          : 0;
        runtime.events.record({
          sessionId,
          type: "turn_end",
          turn: turnIndex,
          payload: { toolResults },
        });
        turnIndex += 1;
        break;
      }
      case "message_end":
        recordAssistantUsageFromMessage(
          runtime,
          sessionId,
          (event as { message?: unknown }).message,
        );
        break;
      case "tool_execution_start":
        runtime.events.record({
          sessionId,
          type: "tool_execution_start",
          payload: {
            toolCallId: (event as { toolCallId?: unknown }).toolCallId,
            toolName: (event as { toolName?: unknown }).toolName,
          },
        });
        break;
      case "tool_execution_update":
        runtime.events.record({
          sessionId,
          type: "tool_execution_update",
          payload: {
            toolCallId: (event as { toolCallId?: unknown }).toolCallId,
            toolName: (event as { toolName?: unknown }).toolName,
          },
        });
        break;
      case "tool_execution_end":
        runtime.events.record({
          sessionId,
          type: "tool_execution_end",
          payload: {
            toolCallId: (event as { toolCallId?: unknown }).toolCallId,
            toolName: (event as { toolName?: unknown }).toolName,
            isError: (event as { isError?: unknown }).isError === true,
          },
        });
        break;
      case "agent_end": {
        const messages = (event as { messages?: unknown }).messages;
        const messageCount = Array.isArray(messages) ? messages.length : 0;
        runtime.events.record({
          sessionId,
          type: "agent_end",
          payload: {
            messageCount,
            costSummary: runtime.cost.getSummary(sessionId),
          },
        });
        break;
      }
      default:
        break;
    }
  });
}
