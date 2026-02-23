import type {
  ScheduleIntentProjectionRecord,
  ScheduleIntentStatus,
  ScheduleIntentUpdateInput,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { addMilliseconds, formatISO } from "date-fns";
import type { BrewvaToolOptions } from "./types.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineTool } from "./utils/tool.js";

const ScheduleActionSchema = Type.Union([
  Type.Literal("create"),
  Type.Literal("update"),
  Type.Literal("cancel"),
  Type.Literal("list"),
]);

const ContinuityModeSchema = Type.Union([Type.Literal("inherit"), Type.Literal("fresh")]);

const ListStatusSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("active"),
  Type.Literal("cancelled"),
  Type.Literal("converged"),
  Type.Literal("error"),
]);

const ConvergencePredicateSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Object({
      kind: Type.Literal("truth_resolved"),
      factId: Type.String({ minLength: 1, maxLength: 300 }),
    }),
    Type.Object({
      kind: Type.Literal("task_phase"),
      phase: Type.Union([
        Type.Literal("align"),
        Type.Literal("investigate"),
        Type.Literal("execute"),
        Type.Literal("verify"),
        Type.Literal("blocked"),
        Type.Literal("done"),
      ]),
    }),
    Type.Object({
      kind: Type.Literal("max_runs"),
      limit: Type.Integer({ minimum: 1 }),
    }),
    Type.Object({
      kind: Type.Literal("all_of"),
      predicates: Type.Array(Self, { minItems: 1, maxItems: 16 }),
    }),
    Type.Object({
      kind: Type.Literal("any_of"),
      predicates: Type.Array(Self, { minItems: 1, maxItems: 16 }),
    }),
  ]),
);

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatIntentSummary(intent: ScheduleIntentProjectionRecord): string {
  const nextRunAtIso = typeof intent.nextRunAt === "number" ? formatISO(intent.nextRunAt) : "none";
  return [
    `- ${intent.intentId}`,
    `status=${intent.status}`,
    `runs=${intent.runCount}/${intent.maxRuns}`,
    `timeZone=${intent.timeZone ?? "none"}`,
    `nextRunAt=${nextRunAtIso}`,
    `reason=${intent.reason}`,
  ].join(" ");
}

function toStatusFilter(value: unknown): ScheduleIntentStatus | undefined {
  if (value === "active" || value === "cancelled" || value === "converged" || value === "error") {
    return value;
  }
  return undefined;
}

function resolveScheduleTarget(params: {
  runAt?: number;
  delayMs?: number;
  cron?: string;
  timeZone?: string;
}): {
  runAt?: number;
  cron?: string;
  timeZone?: string;
  error?: string;
} {
  if (params.runAt !== undefined && params.delayMs !== undefined) {
    return { error: "runAt_and_delayMs_are_mutually_exclusive" };
  }
  if (params.runAt !== undefined && params.cron !== undefined) {
    return { error: "runAt_and_cron_are_mutually_exclusive" };
  }
  if (params.delayMs !== undefined && params.cron !== undefined) {
    return { error: "delayMs_and_cron_are_mutually_exclusive" };
  }
  if (params.runAt === undefined && params.delayMs === undefined && params.cron === undefined) {
    return { error: "missing_schedule_target" };
  }
  if (params.timeZone !== undefined && params.cron === undefined) {
    return { error: "timeZone_requires_cron" };
  }
  if (params.cron !== undefined) {
    const cron = normalizeOptionalString(params.cron);
    if (!cron) {
      return { error: "invalid_cron" };
    }
    const timeZone = normalizeOptionalString(params.timeZone);
    if (params.timeZone !== undefined && !timeZone) {
      return { error: "invalid_time_zone" };
    }
    return { cron, timeZone };
  }
  if (params.runAt !== undefined) {
    if (!Number.isFinite(params.runAt) || params.runAt <= 0) {
      return { error: "invalid_runAt" };
    }
    return { runAt: Math.floor(params.runAt) };
  }
  if (!Number.isFinite(params.delayMs) || (params.delayMs ?? 0) <= 0) {
    return { error: "invalid_delayMs" };
  }
  return { runAt: addMilliseconds(Date.now(), Math.floor(params.delayMs ?? 0)).getTime() };
}

function resolveSchedulePatch(params: {
  runAt?: number;
  delayMs?: number;
  cron?: string;
  timeZone?: string;
}): {
  runAt?: number;
  cron?: string;
  timeZone?: string;
  hasScheduleUpdate: boolean;
  error?: string;
} {
  if (params.runAt !== undefined && params.delayMs !== undefined) {
    return { hasScheduleUpdate: false, error: "runAt_and_delayMs_are_mutually_exclusive" };
  }
  if (params.runAt !== undefined && params.cron !== undefined) {
    return { hasScheduleUpdate: false, error: "runAt_and_cron_are_mutually_exclusive" };
  }
  if (params.delayMs !== undefined && params.cron !== undefined) {
    return { hasScheduleUpdate: false, error: "delayMs_and_cron_are_mutually_exclusive" };
  }
  if (
    (params.runAt !== undefined || params.delayMs !== undefined) &&
    params.timeZone !== undefined
  ) {
    return { hasScheduleUpdate: false, error: "timeZone_requires_cron" };
  }

  if (params.cron !== undefined) {
    const cron = normalizeOptionalString(params.cron);
    if (!cron) return { hasScheduleUpdate: false, error: "invalid_cron" };
    const timeZone = normalizeOptionalString(params.timeZone);
    if (params.timeZone !== undefined && !timeZone) {
      return { hasScheduleUpdate: false, error: "invalid_time_zone" };
    }
    return { hasScheduleUpdate: true, cron, timeZone };
  }

  if (params.runAt !== undefined) {
    if (!Number.isFinite(params.runAt) || params.runAt <= 0) {
      return { hasScheduleUpdate: false, error: "invalid_runAt" };
    }
    return { hasScheduleUpdate: true, runAt: Math.floor(params.runAt) };
  }
  if (params.delayMs !== undefined) {
    if (!Number.isFinite(params.delayMs) || (params.delayMs ?? 0) <= 0) {
      return { hasScheduleUpdate: false, error: "invalid_delayMs" };
    }
    return {
      hasScheduleUpdate: true,
      runAt: addMilliseconds(Date.now(), Math.floor(params.delayMs ?? 0)).getTime(),
    };
  }
  if (params.timeZone !== undefined) {
    const timeZone = normalizeOptionalString(params.timeZone);
    if (!timeZone) {
      return { hasScheduleUpdate: false, error: "invalid_time_zone" };
    }
    return { hasScheduleUpdate: true, timeZone };
  }
  return { hasScheduleUpdate: false };
}

export function createScheduleIntentTool(options: BrewvaToolOptions): ToolDefinition {
  return defineTool({
    name: "schedule_intent",
    label: "Schedule Intent",
    description:
      "Create, update, cancel, or list schedule intents. Supports one-shot runAt/delayMs and recurring cron.",
    parameters: Type.Object({
      action: ScheduleActionSchema,
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 800 })),
      intentId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      runAt: Type.Optional(Type.Number({ minimum: 1 })),
      delayMs: Type.Optional(Type.Integer({ minimum: 1 })),
      cron: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      maxRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
      continuityMode: Type.Optional(ContinuityModeSchema),
      goalRef: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      convergenceCondition: Type.Optional(ConvergencePredicateSchema),
      status: Type.Optional(ListStatusSchema),
      includeAllSessions: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      if (options.runtime.config?.schedule?.enabled === false) {
        return textResult("Schedule intent rejected (scheduler_disabled).", {
          ok: false,
          error: "scheduler_disabled",
        });
      }

      if (params.action === "create") {
        const reason = normalizeOptionalString(params.reason);
        if (!reason) {
          return textResult("Schedule intent rejected (missing_reason).", {
            ok: false,
            error: "missing_reason",
          });
        }

        const scheduleTarget = resolveScheduleTarget({
          runAt: params.runAt,
          delayMs: params.delayMs,
          cron: params.cron,
          timeZone: params.timeZone,
        });
        if (!scheduleTarget.runAt && !scheduleTarget.cron) {
          return textResult(
            `Schedule intent rejected (${scheduleTarget.error ?? "invalid_schedule"}).`,
            {
              ok: false,
              error: scheduleTarget.error ?? "invalid_schedule",
            },
          );
        }

        const created = await options.runtime.schedule.createIntent(sessionId, {
          reason,
          intentId: normalizeOptionalString(params.intentId),
          goalRef: normalizeOptionalString(params.goalRef),
          continuityMode: params.continuityMode,
          runAt: scheduleTarget.runAt,
          cron: scheduleTarget.cron,
          timeZone: scheduleTarget.timeZone,
          maxRuns: params.maxRuns,
          convergenceCondition: params.convergenceCondition,
        });

        if (!created.ok) {
          return textResult(`Schedule intent rejected (${created.error}).`, {
            ok: false,
            error: created.error,
          });
        }

        const intent = created.intent;
        const message = [
          "Schedule intent created.",
          `intentId: ${intent.intentId}`,
          `status: ${intent.status}`,
          `cron: ${intent.cron ?? "none"}`,
          `timeZone: ${intent.timeZone ?? "none"}`,
          `runAt: ${intent.runAt ? formatISO(intent.runAt) : "none"}`,
          `nextRunAt: ${intent.nextRunAt ? formatISO(intent.nextRunAt) : "none"}`,
          `runs: ${intent.runCount}/${intent.maxRuns}`,
        ].join("\n");
        return textResult(message, {
          ok: true,
          intent,
        });
      }

      if (params.action === "update") {
        const intentId = normalizeOptionalString(params.intentId);
        if (!intentId) {
          return textResult("Schedule intent update rejected (missing_intent_id).", {
            ok: false,
            error: "missing_intent_id",
          });
        }

        const schedulePatch = resolveSchedulePatch({
          runAt: params.runAt,
          delayMs: params.delayMs,
          cron: params.cron,
          timeZone: params.timeZone,
        });
        if (schedulePatch.error) {
          return textResult(`Schedule intent update rejected (${schedulePatch.error}).`, {
            ok: false,
            error: schedulePatch.error,
          });
        }

        const reason = normalizeOptionalString(params.reason);
        if (params.reason !== undefined && !reason) {
          return textResult("Schedule intent update rejected (invalid_reason).", {
            ok: false,
            error: "invalid_reason",
          });
        }
        const goalRef =
          params.goalRef !== undefined ? normalizeOptionalString(params.goalRef) : undefined;
        if (params.goalRef !== undefined && !goalRef) {
          return textResult("Schedule intent update rejected (invalid_goal_ref).", {
            ok: false,
            error: "invalid_goal_ref",
          });
        }
        const hasNonSchedulePatch =
          reason !== undefined ||
          goalRef !== undefined ||
          params.continuityMode !== undefined ||
          params.maxRuns !== undefined ||
          params.convergenceCondition !== undefined;
        if (!schedulePatch.hasScheduleUpdate && !hasNonSchedulePatch) {
          return textResult("Schedule intent update rejected (empty_update).", {
            ok: false,
            error: "empty_update",
          });
        }

        const updateInput: ScheduleIntentUpdateInput = {
          intentId,
          continuityMode: params.continuityMode,
          maxRuns: params.maxRuns,
          convergenceCondition: params.convergenceCondition,
        };
        if (reason !== undefined) updateInput.reason = reason;
        if (params.goalRef !== undefined) updateInput.goalRef = goalRef;
        if (schedulePatch.hasScheduleUpdate) {
          if (schedulePatch.runAt !== undefined) updateInput.runAt = schedulePatch.runAt;
          if (schedulePatch.cron !== undefined) updateInput.cron = schedulePatch.cron;
          if (schedulePatch.timeZone !== undefined) updateInput.timeZone = schedulePatch.timeZone;
        }

        const updated = await options.runtime.schedule.updateIntent(sessionId, updateInput);
        if (!updated.ok) {
          return textResult(`Schedule intent update rejected (${updated.error}).`, {
            ok: false,
            error: updated.error,
          });
        }

        const intent = updated.intent;
        const message = [
          "Schedule intent updated.",
          `intentId: ${intent.intentId}`,
          `status: ${intent.status}`,
          `cron: ${intent.cron ?? "none"}`,
          `timeZone: ${intent.timeZone ?? "none"}`,
          `runAt: ${intent.runAt ? formatISO(intent.runAt) : "none"}`,
          `nextRunAt: ${intent.nextRunAt ? formatISO(intent.nextRunAt) : "none"}`,
          `runs: ${intent.runCount}/${intent.maxRuns}`,
        ].join("\n");
        return textResult(message, {
          ok: true,
          intent,
        });
      }

      if (params.action === "cancel") {
        const intentId = normalizeOptionalString(params.intentId);
        if (!intentId) {
          return textResult("Schedule intent cancel rejected (missing_intent_id).", {
            ok: false,
            error: "missing_intent_id",
          });
        }

        const cancelled = await options.runtime.schedule.cancelIntent(sessionId, {
          intentId,
          reason: normalizeOptionalString(params.reason),
        });
        if (!cancelled.ok) {
          return textResult(
            `Schedule intent cancel rejected (${cancelled.error ?? "unknown_error"}).`,
            {
              ok: false,
              error: cancelled.error ?? "unknown_error",
            },
          );
        }
        return textResult(`Schedule intent cancelled (${intentId}).`, {
          ok: true,
          intentId,
        });
      }

      const listQuery = {
        parentSessionId: params.includeAllSessions ? undefined : sessionId,
        status: toStatusFilter(params.status),
      };
      const intents = await options.runtime.schedule.listIntents(listQuery);
      const snapshot = await options.runtime.schedule.getProjectionSnapshot();

      const header = [
        "[ScheduleIntents]",
        `count: ${intents.length}`,
        `scope: ${listQuery.parentSessionId ? "session" : "global"}`,
        `status: ${params.status ?? "all"}`,
        `watermarkOffset: ${snapshot.watermarkOffset}`,
      ];
      const lines =
        intents.length > 0 ? intents.map((intent) => formatIntentSummary(intent)) : ["- (none)"];
      return textResult([...header, ...lines].join("\n"), {
        ok: true,
        intents,
        watermarkOffset: snapshot.watermarkOffset,
      });
    },
  });
}
