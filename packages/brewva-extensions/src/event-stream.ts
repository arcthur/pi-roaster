import { recordAssistantUsageFromMessage, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type MessageHealth = {
  score: number;
  uniqueTokenRatio: number;
  repeatedTrigramRatio: number;
  maxSentenceChars: number;
  windowChars: number;
  drunk: boolean;
  flags: string[];
};

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

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  let out = "";
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string") {
      out += text;
    }
  }
  return out;
}

function extractDeltaFromText(current: string, previous: string): string {
  if (!previous) return current;
  if (current.startsWith(previous)) return current.slice(previous.length);

  const max = Math.min(current.length, previous.length);
  let prefix = 0;
  while (prefix < max && current.charCodeAt(prefix) === previous.charCodeAt(prefix)) {
    prefix += 1;
  }
  return current.slice(prefix);
}

function clampTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!matches) return [];
  return matches.length > 400 ? matches.slice(matches.length - 400) : matches;
}

function computeUniqueTokenRatio(tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const unique = new Set(tokens).size;
  return unique / tokens.length;
}

function computeRepeatedNgramRatio(tokens: string[], n: number): number {
  if (tokens.length < n + 8) return 0;
  const window = tokens.length > 240 ? tokens.slice(tokens.length - 240) : tokens;
  const seen = new Set<string>();
  let repeats = 0;
  let total = 0;
  for (let i = 0; i + n <= window.length; i += 1) {
    const gram = window.slice(i, i + n).join("\u0001");
    total += 1;
    if (seen.has(gram)) {
      repeats += 1;
    } else {
      seen.add(gram);
    }
  }
  return total === 0 ? 0 : repeats / total;
}

function computeMaxSentenceChars(text: string): number {
  if (!text) return 0;
  const parts = text.split(/[.!?。！？\n]/);
  let max = 0;
  for (const part of parts) {
    const len = part.trim().length;
    if (len > max) max = len;
  }
  return max;
}

function computeMessageHealth(windowText: string, windowChars: number): MessageHealth {
  const tokens = tokenize(windowText);
  const tokenCount = tokens.length;
  const uniqueTokenRatioRaw = computeUniqueTokenRatio(tokens);
  const repeatedTrigramRatioRaw = computeRepeatedNgramRatio(tokens, 3);
  const maxSentenceChars = computeMaxSentenceChars(windowText);

  let penalty = 0;
  if (tokenCount >= 24 && uniqueTokenRatioRaw < 0.35) {
    penalty += Math.min(0.35, (0.35 - uniqueTokenRatioRaw) * 1.4);
  }
  if (tokenCount >= 24 && repeatedTrigramRatioRaw > 0.2) {
    penalty += Math.min(0.6, (repeatedTrigramRatioRaw - 0.2) * 1.6);
  }
  if (maxSentenceChars > 350) {
    penalty += Math.min(0.4, (maxSentenceChars - 350) / 900);
  }

  const score = Math.max(0, Math.min(1, 1 - penalty));

  const flags: string[] = [];
  if (tokenCount >= 24 && repeatedTrigramRatioRaw > 0.4) flags.push("repetition_high");
  if (tokenCount >= 24 && uniqueTokenRatioRaw < 0.25) flags.push("token_diversity_low");
  if (maxSentenceChars > 450) flags.push("long_sentence");

  const drunk = score < 0.4 && flags.length > 0;

  return {
    score: round(score, 3),
    uniqueTokenRatio: round(uniqueTokenRatioRaw, 4),
    repeatedTrigramRatio: round(repeatedTrigramRatioRaw, 4),
    maxSentenceChars,
    windowChars,
    drunk,
    flags,
  };
}

const MESSAGE_UPDATE_MIN_INTERVAL_MS = 250;
const MESSAGE_HEALTH_WINDOW_MAX_CHARS = 2400;

export function registerEventStream(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const lastMessageUpdateAtBySession = new Map<string, number>();
  const lastAssistantTextBySession = new Map<string, string>();
  const assistantWindowBySession = new Map<string, string>();

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
    lastMessageUpdateAtBySession.delete(sessionId);
    lastAssistantTextBySession.delete(sessionId);
    assistantWindowBySession.delete(sessionId);
    runtime.clearSessionState(sessionId);
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
    lastAssistantTextBySession.delete(sessionId);
    assistantWindowBySession.delete(sessionId);
    runtime.recordEvent({
      sessionId,
      type: "message_start",
      payload: summarizeMessage(event.message),
    });
    return undefined;
  });

  pi.on("message_update", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const currentText = extractMessageText(event.message);
    const previousText = lastAssistantTextBySession.get(sessionId) ?? "";

    const deltaFromEvent =
      (event.assistantMessageEvent.type === "text_delta" ||
        event.assistantMessageEvent.type === "thinking_delta") &&
      typeof (event.assistantMessageEvent as { delta?: unknown }).delta === "string"
        ? ((event.assistantMessageEvent as { delta: string }).delta ?? "")
        : "";

    const delta = deltaFromEvent || extractDeltaFromText(currentText, previousText);
    lastAssistantTextBySession.set(sessionId, currentText);

    if (delta) {
      const nextWindow = clampTail(
        (assistantWindowBySession.get(sessionId) ?? "") + delta,
        MESSAGE_HEALTH_WINDOW_MAX_CHARS,
      );
      assistantWindowBySession.set(sessionId, nextWindow);
    }

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
        deltaChars: delta.length,
        health: computeMessageHealth(
          assistantWindowBySession.get(sessionId) ?? "",
          (assistantWindowBySession.get(sessionId) ?? "").length,
        ),
      },
    });
    return undefined;
  });

  pi.on("message_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lastMessageUpdateAtBySession.delete(sessionId);
    lastAssistantTextBySession.delete(sessionId);
    assistantWindowBySession.delete(sessionId);
    runtime.recordEvent({
      sessionId,
      type: "message_end",
      payload: summarizeMessage(event.message),
    });
    recordAssistantUsageFromMessage(runtime, sessionId, event.message);
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
