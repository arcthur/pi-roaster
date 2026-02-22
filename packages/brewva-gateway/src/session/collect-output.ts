import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { GatewaySessionResult } from "./create-session.js";

export interface GatewayToolOutput {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
}

export interface SessionPromptOutput {
  assistantText: string;
  toolOutputs: GatewayToolOutput[];
}

export type SessionStreamChunk =
  | {
      kind: "assistant_text_delta";
      delta: string;
    }
  | {
      kind: "assistant_thinking_delta";
      delta: string;
    }
  | {
      kind: "tool_update";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      text: string;
    };

export interface CollectSessionPromptOutputOptions {
  onChunk?: (chunk: SessionStreamChunk) => void;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function extractMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join("");
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result.trim();
  }
  if (!result || typeof result !== "object") {
    return "";
  }

  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) {
        texts.push(text.trim());
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  try {
    const serialized = JSON.stringify(result);
    return serialized && serialized !== "{}" ? serialized : "";
  } catch {
    return "";
  }
}

function asToolExecutionEndEvent(event: AgentSessionEvent): {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  result: unknown;
} | null {
  if (event.type !== "tool_execution_end") {
    return null;
  }
  const candidate = event as {
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
    result?: unknown;
  };
  if (typeof candidate.toolCallId !== "string" || !candidate.toolCallId.trim()) {
    return null;
  }
  if (typeof candidate.toolName !== "string" || !candidate.toolName.trim()) {
    return null;
  }
  return {
    toolCallId: candidate.toolCallId.trim(),
    toolName: candidate.toolName.trim(),
    isError: candidate.isError === true,
    result: candidate.result,
  };
}

function asToolExecutionUpdateEvent(event: AgentSessionEvent): {
  toolCallId: string;
  toolName: string;
  partialResult: unknown;
} | null {
  if (event.type !== "tool_execution_update") {
    return null;
  }
  const candidate = event as {
    toolCallId?: unknown;
    toolName?: unknown;
    partialResult?: unknown;
  };
  if (typeof candidate.toolCallId !== "string" || !candidate.toolCallId.trim()) {
    return null;
  }
  if (typeof candidate.toolName !== "string" || !candidate.toolName.trim()) {
    return null;
  }
  return {
    toolCallId: candidate.toolCallId.trim(),
    toolName: candidate.toolName.trim(),
    partialResult: candidate.partialResult,
  };
}

function asAssistantDeltaChunk(event: AgentSessionEvent): SessionStreamChunk | null {
  if (event.type !== "message_update") {
    return null;
  }

  const update = event as {
    assistantMessageEvent?: unknown;
  };
  if (!update.assistantMessageEvent || typeof update.assistantMessageEvent !== "object") {
    return null;
  }

  const assistantMessageEvent = update.assistantMessageEvent as {
    type?: unknown;
    delta?: unknown;
  };
  if (typeof assistantMessageEvent.delta !== "string" || assistantMessageEvent.delta.length === 0) {
    return null;
  }
  if (assistantMessageEvent.type === "text_delta") {
    return {
      kind: "assistant_text_delta",
      delta: assistantMessageEvent.delta,
    };
  }
  if (assistantMessageEvent.type === "thinking_delta") {
    return {
      kind: "assistant_thinking_delta",
      delta: assistantMessageEvent.delta,
    };
  }
  return null;
}

function emitChunk(
  options: CollectSessionPromptOutputOptions | undefined,
  chunk: SessionStreamChunk,
): void {
  if (!options?.onChunk) {
    return;
  }
  try {
    options.onChunk(chunk);
  } catch {
    // best effort callback isolation
  }
}

export async function collectSessionPromptOutput(
  session: GatewaySessionResult["session"],
  prompt: string,
  options?: CollectSessionPromptOutputOptions,
): Promise<SessionPromptOutput> {
  let latestAssistantText = "";
  const toolOutputs: GatewayToolOutput[] = [];
  const seenToolCallIds = new Set<string>();
  const latestToolStreamTextByCall = new Map<string, string>();

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    const assistantDelta = asAssistantDeltaChunk(event);
    if (assistantDelta) {
      emitChunk(options, assistantDelta);
    }

    const toolUpdateEvent = asToolExecutionUpdateEvent(event);
    if (toolUpdateEvent) {
      const streamedText = extractToolResultText(toolUpdateEvent.partialResult);
      const previousText = latestToolStreamTextByCall.get(toolUpdateEvent.toolCallId);
      if (streamedText && streamedText !== previousText) {
        latestToolStreamTextByCall.set(toolUpdateEvent.toolCallId, streamedText);
        emitChunk(options, {
          kind: "tool_update",
          toolCallId: toolUpdateEvent.toolCallId,
          toolName: toolUpdateEvent.toolName,
          isError: false,
          text: streamedText,
        });
      }
    }

    const toolEvent = asToolExecutionEndEvent(event);
    if (toolEvent) {
      if (seenToolCallIds.has(toolEvent.toolCallId)) {
        return;
      }
      seenToolCallIds.add(toolEvent.toolCallId);
      toolOutputs.push({
        toolCallId: toolEvent.toolCallId,
        toolName: toolEvent.toolName,
        isError: toolEvent.isError,
        text: extractToolResultText(toolEvent.result),
      });
      const finalText = toolOutputs[toolOutputs.length - 1]?.text;
      const previousText = latestToolStreamTextByCall.get(toolEvent.toolCallId);
      if (typeof finalText === "string" && finalText && finalText !== previousText) {
        latestToolStreamTextByCall.set(toolEvent.toolCallId, finalText);
        emitChunk(options, {
          kind: "tool_update",
          toolCallId: toolEvent.toolCallId,
          toolName: toolEvent.toolName,
          isError: toolEvent.isError,
          text: finalText,
        });
      }
      return;
    }

    if (event.type === "message_end") {
      const message = (event as { message?: unknown }).message;
      if (extractMessageRole(message) !== "assistant") return;
      const text = normalizeText(extractMessageText(message));
      if (text) {
        latestAssistantText = text;
      }
    }
  });

  try {
    await session.sendUserMessage(prompt);
    await session.agent.waitForIdle();
    return {
      assistantText: latestAssistantText,
      toolOutputs,
    };
  } finally {
    unsubscribe();
  }
}
