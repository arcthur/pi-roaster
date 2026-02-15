import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { RoasterToolOptions } from "./types.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";

export function createLedgerQueryTool(options: RoasterToolOptions): ToolDefinition<any> {
  return {
    name: "ledger_query",
    label: "Ledger Query",
    description: "Query evidence ledger by file, skill, verdict, tool, or last N entries.",
    parameters: Type.Object({
      file: Type.Optional(Type.String()),
      skill: Type.Optional(Type.String()),
      verdict: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("inconclusive")])),
      tool: Type.Optional(Type.String()),
      last: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const text = options.runtime.queryLedger(sessionId, params);
      return textResult(text, { sessionId, query: params });
    },
  };
}
