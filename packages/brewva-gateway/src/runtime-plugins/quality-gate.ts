import { coerceContextBudgetUsage, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface QualityGateLifecycle {
  toolCall: (event: unknown, ctx: unknown) => unknown;
  toolResult: (event: unknown, ctx: unknown) => unknown;
  input: (event: unknown, ctx: unknown) => unknown;
}

export function createQualityGateLifecycle(runtime: BrewvaRuntime): QualityGateLifecycle {
  const pendingAdvisoriesBySession = new Map<string, Map<string, string>>();

  const normalizeField = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (value == null) {
      return "";
    }
    return JSON.stringify(value);
  };

  const getSessionId = (ctx: unknown): string =>
    ctx &&
    typeof ctx === "object" &&
    "sessionManager" in ctx &&
    (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager &&
    typeof (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager
      ?.getSessionId === "function"
      ? ((
          ctx as { sessionManager: { getSessionId: () => string } }
        ).sessionManager.getSessionId() ?? "")
      : "";

  const getPendingAdvisories = (sessionId: string): Map<string, string> => {
    const existing = pendingAdvisoriesBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, string>();
    pendingAdvisoriesBySession.set(sessionId, created);
    return created;
  };

  const deletePendingAdvisory = (sessionId: string, toolCallId: string): void => {
    const sessionState = pendingAdvisoriesBySession.get(sessionId);
    if (!sessionState) {
      return;
    }
    sessionState.delete(toolCallId);
    if (sessionState.size === 0) {
      pendingAdvisoriesBySession.delete(sessionId);
    }
  };

  const normalizeToolResultContent = (value: unknown): Array<Record<string, unknown>> => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
    );
  };

  return {
    toolCall(event, ctx) {
      const rawEvent = event as { toolCallId?: unknown; toolName?: unknown; input?: unknown };
      const sessionId = getSessionId(ctx);
      const toolCallId = normalizeField(rawEvent.toolCallId);
      const usage = coerceContextBudgetUsage(
        typeof (ctx as { getContextUsage?: () => unknown }).getContextUsage === "function"
          ? (ctx as { getContextUsage: () => unknown }).getContextUsage()
          : undefined,
      );
      const started = runtime.tools.start({
        sessionId,
        toolCallId,
        toolName: normalizeField(rawEvent.toolName),
        args:
          rawEvent.input && typeof rawEvent.input === "object"
            ? (rawEvent.input as Record<string, unknown>)
            : undefined,
        usage,
      });
      if (!started.allowed) {
        deletePendingAdvisory(sessionId, toolCallId);
        return {
          block: true,
          reason: started.reason ?? "Tool call blocked by runtime policy.",
        };
      }
      const advisory = started.advisory?.trim();
      if (advisory) {
        getPendingAdvisories(sessionId).set(toolCallId, advisory);
      } else {
        deletePendingAdvisory(sessionId, toolCallId);
      }
      return undefined;
    },
    toolResult(event, ctx) {
      const rawEvent = event as { toolCallId?: unknown; content?: unknown };
      const sessionId = getSessionId(ctx);
      const toolCallId = normalizeField(rawEvent.toolCallId);
      if (!sessionId || !toolCallId) {
        return undefined;
      }

      const advisory = getPendingAdvisories(sessionId).get(toolCallId)?.trim();
      deletePendingAdvisory(sessionId, toolCallId);
      if (!advisory) {
        return undefined;
      }

      return {
        content: [
          { type: "text", text: advisory },
          ...normalizeToolResultContent(rawEvent.content),
        ],
      };
    },
    input(event, ctx) {
      const rawEvent = event as { text?: unknown; images?: unknown };
      const sessionId = getSessionId(ctx);
      if (sessionId.length > 0) {
        runtime.context.onUserInput(sessionId);
      }
      const text = typeof rawEvent.text === "string" ? rawEvent.text : "";
      const sanitized = runtime.context.sanitizeInput(text);
      if (sanitized === text) {
        return { action: "continue" };
      }

      return {
        action: "transform",
        text: sanitized,
        images: rawEvent.images,
      };
    },
  };
}

export function registerQualityGate(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const hooks = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createQualityGateLifecycle(runtime);
  hooks.on("tool_call", lifecycle.toolCall);
  hooks.on("tool_result", lifecycle.toolResult);
  hooks.on("input", lifecycle.input);
}
