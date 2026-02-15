import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RoasterRuntime } from "@pi-roaster/roaster-runtime";

function summarizeContent(content: unknown): { items: number; textChars: number } {
  if (!Array.isArray(content)) {
    return { items: 0, textChars: 0 };
  }

  let textChars = 0;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string") {
      textChars += text.length;
    }
  }
  return { items: content.length, textChars };
}

function summarizeMessage(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== "object") {
    return {};
  }

  const value = message as {
    role?: string;
    timestamp?: number;
    content?: unknown;
    stopReason?: string;
    model?: string;
    provider?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: {
        total?: number;
      };
    };
  };

  const content = summarizeContent(value.content);
  return {
    role: value.role ?? null,
    timestamp: typeof value.timestamp === "number" ? value.timestamp : null,
    stopReason: value.stopReason ?? null,
    provider: value.provider ?? null,
    model: value.model ?? null,
    usage: value.usage
      ? {
          input: value.usage.input ?? 0,
          output: value.usage.output ?? 0,
          cacheRead: value.usage.cacheRead ?? 0,
          cacheWrite: value.usage.cacheWrite ?? 0,
          totalTokens: value.usage.totalTokens ?? 0,
          costTotal: value.usage.cost?.total ?? 0,
        }
      : null,
    contentItems: content.items,
    contentTextChars: content.textChars,
  };
}

function maybeRecordAssistantUsage(runtime: RoasterRuntime, sessionId: string, message: unknown): void {
  if (!message || typeof message !== "object") return;

  const value = message as {
    role?: string;
    model?: string;
    provider?: string;
    stopReason?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: {
        total?: number;
      };
    };
  };
  if (value.role !== "assistant" || !value.usage) return;

  const model = value.provider && value.model ? `${value.provider}/${value.model}` : value.model ?? "unknown";
  runtime.recordAssistantUsage({
    sessionId,
    model,
    inputTokens: value.usage.input ?? 0,
    outputTokens: value.usage.output ?? 0,
    cacheReadTokens: value.usage.cacheRead ?? 0,
    cacheWriteTokens: value.usage.cacheWrite ?? 0,
    totalTokens: value.usage.totalTokens ?? 0,
    costUsd: value.usage.cost?.total ?? 0,
    stopReason: value.stopReason,
  });
}

const MESSAGE_UPDATE_MIN_INTERVAL_MS = 250;

export function registerEventStream(pi: ExtensionAPI, runtime: RoasterRuntime): void {
  const lastMessageUpdateAtBySession = new Map<string, number>();

  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    runtime.recordEvent({
      sessionId,
      type: "session_start",
      payload: {
        cwd: ctx.cwd,
      },
    });
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    runtime.recordEvent({
      sessionId,
      type: "session_shutdown",
    });
    return undefined;
  });

  pi.on("agent_start", (_event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "agent_start",
    });
    return undefined;
  });

  pi.on("agent_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    runtime.recordEvent({
      sessionId,
      type: "agent_end",
      payload: {
        messageCount: event.messages.length,
        costSummary: runtime.getCostSummary(sessionId),
      },
    });
    return undefined;
  });

  pi.on("turn_start", (event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "turn_start",
      turn: event.turnIndex,
      payload: {
        timestamp: event.timestamp,
      },
    });
    return undefined;
  });

  pi.on("turn_end", (event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "turn_end",
      turn: event.turnIndex,
      payload: {
        message: summarizeMessage(event.message),
        toolResults: event.toolResults.length,
      },
    });
    return undefined;
  });

  pi.on("message_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lastMessageUpdateAtBySession.delete(sessionId);
    runtime.recordEvent({
      sessionId,
      type: "message_start",
      payload: summarizeMessage(event.message),
    });
    return undefined;
  });

  pi.on("message_update", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const now = Date.now();
    const last = lastMessageUpdateAtBySession.get(sessionId) ?? 0;
    if (now - last < MESSAGE_UPDATE_MIN_INTERVAL_MS) {
      return undefined;
    }
    lastMessageUpdateAtBySession.set(sessionId, now);
    runtime.recordEvent({
      sessionId,
      type: "message_update",
      payload: {
        message: summarizeMessage(event.message),
        deltaType: event.assistantMessageEvent.type,
      },
    });
    return undefined;
  });

  pi.on("message_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lastMessageUpdateAtBySession.delete(sessionId);
    runtime.recordEvent({
      sessionId,
      type: "message_end",
      payload: summarizeMessage(event.message),
    });
    maybeRecordAssistantUsage(runtime, sessionId, event.message);
    return undefined;
  });

  pi.on("tool_execution_start", (event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "tool_execution_start",
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      },
    });
    return undefined;
  });

  pi.on("tool_execution_update", (event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "tool_execution_update",
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      },
    });
    return undefined;
  });

  pi.on("tool_execution_end", (event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "tool_execution_end",
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      },
    });
    return undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "tool_call",
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      },
    });
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "tool_result",
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        content: summarizeContent(event.content),
      },
    });
    return undefined;
  });

  pi.on("session_before_compact", (event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "session_before_compact",
      payload: {
        branchEntries: event.branchEntries.length,
      },
    });
    return undefined;
  });

  pi.on("session_compact", (event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "session_compact",
      payload: {
        entryId: event.compactionEntry.id,
        fromExtension: event.fromExtension,
      },
    });
    return undefined;
  });

  pi.on("model_select", (event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "model_select",
      payload: {
        provider: event.model.provider,
        model: event.model.id,
        source: event.source,
      },
    });
    return undefined;
  });

  pi.on("input", (event, ctx) => {
    runtime.recordEvent({
      sessionId: ctx.sessionManager.getSessionId(),
      type: "input",
      payload: {
        source: event.source,
        textChars: event.text.length,
        images: event.images?.length ?? 0,
      },
    });
    return undefined;
  });
}
