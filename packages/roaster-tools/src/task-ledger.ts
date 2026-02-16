import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { RoasterToolOptions } from "./types.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";

const VerificationLevelSchema = Type.Union([
  Type.Literal("quick"),
  Type.Literal("standard"),
  Type.Literal("strict"),
]);

const TaskItemStatusSchema = Type.Union([
  Type.Literal("todo"),
  Type.Literal("doing"),
  Type.Literal("done"),
  Type.Literal("blocked"),
]);

export function createTaskLedgerTools(options: RoasterToolOptions): ToolDefinition<any>[] {
  const taskSetSpec: ToolDefinition<any> = {
    name: "task_set_spec",
    label: "Task Set Spec",
    description: "Set or update the TaskSpec (event-sourced Task Ledger).",
    parameters: Type.Object({
      goal: Type.String(),
      targets: Type.Optional(
        Type.Object({
          files: Type.Optional(Type.Array(Type.String())),
          symbols: Type.Optional(Type.Array(Type.String())),
        }),
      ),
      expectedBehavior: Type.Optional(Type.String()),
      constraints: Type.Optional(Type.Array(Type.String())),
      verification: Type.Optional(
        Type.Object({
          level: Type.Optional(VerificationLevelSchema),
          commands: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      options.runtime.setTaskSpec(sessionId, {
        schema: "roaster.task.v1",
        goal: params.goal,
        targets: params.targets,
        expectedBehavior: params.expectedBehavior,
        constraints: params.constraints,
        verification: params.verification,
      });
      return textResult("TaskSpec recorded.", { ok: true });
    },
  };

  const taskAddItem: ToolDefinition<any> = {
    name: "task_add_item",
    label: "Task Add Item",
    description: "Add a task item to the Task Ledger.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      text: Type.String(),
      status: Type.Optional(TaskItemStatusSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.addTaskItem(sessionId, {
        id: params.id,
        text: params.text,
        status: params.status,
      });
      if (!result.ok) {
        return textResult(`Task item rejected (${result.error ?? "unknown_error"}).`, result);
      }
      return textResult(`Task item added (${result.itemId}).`, result);
    },
  };

  const taskUpdateItem: ToolDefinition<any> = {
    name: "task_update_item",
    label: "Task Update Item",
    description: "Update a task item in the Task Ledger.",
    parameters: Type.Object({
      id: Type.String(),
      text: Type.Optional(Type.String()),
      status: Type.Optional(TaskItemStatusSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.updateTaskItem(sessionId, {
        id: params.id,
        text: params.text,
        status: params.status,
      });
      if (!result.ok) {
        return textResult(`Task item update rejected (${result.error ?? "unknown_error"}).`, result);
      }
      return textResult("Task item updated.", result);
    },
  };

  const taskRecordBlocker: ToolDefinition<any> = {
    name: "task_record_blocker",
    label: "Task Record Blocker",
    description: "Record a blocker in the Task Ledger.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      message: Type.String(),
      source: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.recordTaskBlocker(sessionId, {
        id: params.id,
        message: params.message,
        source: params.source,
      });
      if (!result.ok) {
        return textResult(`Blocker rejected (${result.error ?? "unknown_error"}).`, result);
      }
      return textResult(`Blocker recorded (${result.blockerId}).`, result);
    },
  };

  const taskResolveBlocker: ToolDefinition<any> = {
    name: "task_resolve_blocker",
    label: "Task Resolve Blocker",
    description: "Resolve (remove) a blocker from the Task Ledger.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.resolveTaskBlocker(sessionId, params.id);
      if (!result.ok) {
        return textResult(`Blocker resolve rejected (${result.error ?? "unknown_error"}).`, result);
      }
      return textResult("Blocker resolved.", result);
    },
  };

  const taskViewState: ToolDefinition<any> = {
    name: "task_view_state",
    label: "Task View State",
    description: "Show the current folded Task Ledger state.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const state = options.runtime.getTaskState(sessionId);

      const lines: string[] = ["[TaskLedgerState]"];
      const spec = state.spec;
      if (spec) {
        lines.push(`goal=${spec.goal}`);
        if (spec.expectedBehavior) lines.push(`expectedBehavior=${spec.expectedBehavior}`);
        const files = spec.targets?.files ?? [];
        const symbols = spec.targets?.symbols ?? [];
        if (files.length > 0) {
          lines.push("targets.files:");
          for (const file of files.slice(0, 8)) lines.push(`- ${file}`);
        }
        if (symbols.length > 0) {
          lines.push("targets.symbols:");
          for (const symbol of symbols.slice(0, 8)) lines.push(`- ${symbol}`);
        }
        const constraints = spec.constraints ?? [];
        if (constraints.length > 0) {
          lines.push("constraints:");
          for (const constraint of constraints.slice(0, 8)) lines.push(`- ${constraint}`);
        }
      } else {
        lines.push("spec=(none)");
      }

      const blockers = state.blockers ?? [];
      lines.push("blockers:");
      if (blockers.length === 0) {
        lines.push("- (none)");
      } else {
        for (const blocker of blockers.slice(0, 8)) {
          const source = blocker.source ? ` source=${blocker.source}` : "";
          lines.push(`- ${blocker.id}: ${blocker.message}${source}`);
        }
      }

      const items = state.items ?? [];
      lines.push("items:");
      if (items.length === 0) {
        lines.push("- (none)");
      } else {
        for (const item of items.slice(0, 12)) {
          lines.push(`- ${item.id} [${item.status}] ${item.text}`);
        }
      }

      return textResult(lines.join("\n"), { ok: true });
    },
  };

  return [taskSetSpec, taskAddItem, taskUpdateItem, taskRecordBlocker, taskResolveBlocker, taskViewState];
}

