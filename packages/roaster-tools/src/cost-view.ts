import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { RoasterToolOptions } from "./types.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";

function formatTopRows<T>(
  rows: Array<[string, T]>,
  options: {
    limit: number;
    line: (name: string, value: T) => string;
  },
): string[] {
  return rows.slice(0, options.limit).map(([name, value]) => options.line(name, value));
}

export function createCostViewTool(options: RoasterToolOptions): ToolDefinition<any> {
  return {
    name: "cost_view",
    label: "Cost View",
    description: "Show session, skill, and tool cost breakdown with budget status.",
    parameters: Type.Object({
      top: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 5 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const top = typeof params.top === "number" ? Math.max(1, Math.trunc(params.top)) : 5;
      const summary = options.runtime.getCostSummary(sessionId);

      const skillRows = Object.entries(summary.skills).sort((a, b) => b[1].totalCostUsd - a[1].totalCostUsd);
      const toolRows = Object.entries(summary.tools).sort((a, b) => b[1].allocatedCostUsd - a[1].allocatedCostUsd);

      const lines = [
        "# Cost View",
        `- total tokens: ${summary.totalTokens}`,
        `- total cost usd: ${summary.totalCostUsd.toFixed(6)}`,
        `- budget action: ${summary.budget.action}`,
        `- budget blocked: ${summary.budget.blocked}`,
        "",
        "## Top Skills",
        ...formatTopRows(skillRows, {
          limit: top,
          line: (name, value) =>
            `- ${name}: usd=${value.totalCostUsd.toFixed(6)}, tokens=${value.totalTokens}, usage=${value.usageCount}, turns=${value.turns}`,
        }),
        "",
        "## Top Tools",
        ...formatTopRows(toolRows, {
          limit: top,
          line: (name, value) =>
            `- ${name}: calls=${value.callCount}, allocated_usd=${value.allocatedCostUsd.toFixed(6)}, allocated_tokens=${value.allocatedTokens.toFixed(2)}`,
        }),
      ];

      if (summary.alerts.length > 0) {
        lines.push("", "## Alerts");
        for (const alert of summary.alerts.slice(-top)) {
          lines.push(
            `- ${new Date(alert.timestamp).toISOString()} ${alert.kind} scope=${alert.scope}${alert.scopeId ? `(${alert.scopeId})` : ""} cost=${alert.costUsd.toFixed(6)} threshold=${alert.thresholdUsd.toFixed(6)}`,
          );
        }
      }

      return textResult(lines.join("\n"), {
        sessionId,
        summary,
      });
    },
  };
}
