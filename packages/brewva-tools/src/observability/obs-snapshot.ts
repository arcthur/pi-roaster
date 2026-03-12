import { VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../types.js";
import { textResult } from "../utils/result.js";
import { getSessionId } from "../utils/session.js";
import { defineBrewvaTool } from "../utils/tool.js";

function formatPercent(value: number | null): string {
  if (value === null) return "unknown";
  return `${(value * 100).toFixed(1)}%`;
}

export function createObsSnapshotTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "obs_snapshot",
    label: "Observability Snapshot",
    description: "Show a compact health snapshot for the current session runtime state.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const tape = options.runtime.events.getTapeStatus(sessionId);
      const usage = options.runtime.context.getUsage(sessionId);
      const pressure = options.runtime.context.getPressureStatus(sessionId, usage);
      const cost = options.runtime.cost.getSummary(sessionId);
      const task = options.runtime.task.getState(sessionId);
      const verificationEvent = options.runtime.events.list(sessionId, {
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        last: 1,
      })[0];
      const verificationPayload =
        verificationEvent?.payload &&
        typeof verificationEvent.payload === "object" &&
        !Array.isArray(verificationEvent.payload)
          ? (verificationEvent.payload as Record<string, unknown>)
          : undefined;

      const lines = [
        "[ObsSnapshot]",
        `tape_pressure: ${tape.tapePressure}`,
        `tape_entries_total: ${tape.totalEntries}`,
        `context_pressure: ${pressure.level}`,
        `context_usage: ${formatPercent(pressure.usageRatio)}`,
        `cost_total_usd: ${cost.totalCostUsd.toFixed(6)}`,
        `budget_action: ${cost.budget.action}`,
        `task_phase: ${task.status?.phase ?? "none"}`,
        `task_blockers: ${task.blockers.length}`,
        `verification_outcome: ${
          typeof verificationPayload?.outcome === "string" ? verificationPayload.outcome : "none"
        }`,
        `verification_level: ${
          typeof verificationPayload?.level === "string" ? verificationPayload.level : "none"
        }`,
      ];
      if (
        typeof verificationPayload?.reason === "string" &&
        verificationPayload.reason.length > 0
      ) {
        lines.push(`verification_reason: ${verificationPayload.reason}`);
      }

      return textResult(lines.join("\n"), {
        ok: true,
        tape,
        context: {
          usage,
          pressure,
        },
        cost,
        task: {
          phase: task.status?.phase ?? null,
          blockers: task.blockers.length,
          items: task.items.length,
        },
        verification: verificationPayload ?? null,
      });
    },
  });
}
