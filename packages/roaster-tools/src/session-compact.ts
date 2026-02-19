import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { RoasterToolOptions } from "./types.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";

function normalizeReason(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  return value.length > 0 ? value : undefined;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return "unknown_error";
}

export function createSessionCompactTool(options: RoasterToolOptions): ToolDefinition<any> {
  return {
    name: "session_compact",
    label: "Session Compact",
    description: "Compact LLM message history for the current session.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const reason = normalizeReason(params.reason);
      const usage = ctx.getContextUsage();
      const customInstructions = options.runtime.getCompactionInstructions?.();

      try {
        ctx.compact({
          customInstructions,
        });
        options.runtime.recordEvent?.({
          sessionId,
          type: "session_compact_requested",
          payload: {
            reason: reason ?? null,
            usageTokens: usage?.tokens ?? null,
            usagePercent: usage?.percent ?? null,
          },
        });
      } catch (error) {
        const errorMessage = normalizeErrorMessage(error);
        options.runtime.recordEvent?.({
          sessionId,
          type: "session_compact_request_failed",
          payload: {
            reason: reason ?? null,
            error: errorMessage,
          },
        });
        return textResult(`Session compaction request failed (${errorMessage}).`, {
          ok: false,
          error: errorMessage,
        });
      }

      return textResult("Session compaction requested.", {
        ok: true,
        reason: reason ?? null,
        usageTokens: usage?.tokens ?? null,
        usagePercent: usage?.percent ?? null,
      });
    },
  };
}
