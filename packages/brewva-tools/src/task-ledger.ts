import { formatTaskStateBlock } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineTool } from "./utils/tool.js";

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

const EvolvesDecisionSchema = Type.Union([Type.Literal("accept"), Type.Literal("reject")]);

export function createTaskLedgerTools(options: BrewvaToolOptions): ToolDefinition[] {
  const taskSetSpec = defineTool({
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
        schema: "brewva.task.v1",
        goal: params.goal,
        targets: params.targets,
        expectedBehavior: params.expectedBehavior,
        constraints: params.constraints,
        verification: params.verification,
      });
      return textResult("TaskSpec recorded.", { ok: true });
    },
  });

  const taskAddItem = defineTool({
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
  });

  const taskUpdateItem = defineTool({
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
        return textResult(
          `Task item update rejected (${result.error ?? "unknown_error"}).`,
          result,
        );
      }
      return textResult("Task item updated.", result);
    },
  });

  const taskRecordBlocker = defineTool({
    name: "task_record_blocker",
    label: "Task Record Blocker",
    description: "Record a blocker in the Task Ledger.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      message: Type.String(),
      source: Type.Optional(Type.String()),
      truthFactId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.recordTaskBlocker(sessionId, {
        id: params.id,
        message: params.message,
        source: params.source,
        truthFactId: params.truthFactId,
      });
      if (!result.ok) {
        return textResult(`Blocker rejected (${result.error ?? "unknown_error"}).`, result);
      }
      return textResult(`Blocker recorded (${result.blockerId}).`, result);
    },
  });

  const taskResolveBlocker = defineTool({
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
  });

  const taskViewState = defineTool({
    name: "task_view_state",
    label: "Task View State",
    description: "Show the current folded Task Ledger state.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const state = options.runtime.getTaskState(sessionId);
      const block = formatTaskStateBlock(state);
      return textResult(block || "[TaskLedger]\n(empty)", { ok: true });
    },
  });

  const memoryDismissInsight = defineTool({
    name: "memory_dismiss_insight",
    label: "Memory Dismiss Insight",
    description: "Dismiss an open memory insight so it no longer appears in working memory.",
    parameters: Type.Object({
      insightId: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.dismissMemoryInsight(sessionId, params.insightId);
      if (!result.ok) {
        return textResult(`Insight dismiss rejected (${result.error ?? "unknown_error"}).`, result);
      }
      return textResult("Insight dismissed.", result);
    },
  });

  const memoryReviewEvolvesEdge = defineTool({
    name: "memory_review_evolves_edge",
    label: "Memory Review Evolves Edge",
    description: "Accept or reject a proposed evolves edge (shadow mode).",
    parameters: Type.Object({
      edgeId: Type.String(),
      decision: EvolvesDecisionSchema,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.reviewMemoryEvolvesEdge(sessionId, {
        edgeId: params.edgeId,
        decision: params.decision,
      });
      if (!result.ok) {
        return textResult(
          `Evolves edge review rejected (${result.error ?? "unknown_error"}).`,
          result,
        );
      }
      return textResult("Evolves edge reviewed.", result);
    },
  });

  return [
    taskSetSpec,
    taskAddItem,
    taskUpdateItem,
    taskRecordBlocker,
    taskResolveBlocker,
    taskViewState,
    memoryDismissInsight,
    memoryReviewEvolvesEdge,
  ];
}
