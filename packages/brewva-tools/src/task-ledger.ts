import { formatTaskStateBlock } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

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

export function createTaskLedgerTools(options: BrewvaToolOptions): ToolDefinition[] {
  const taskSetSpec = defineBrewvaTool({
    name: "task_set_spec",
    label: "Task Set Spec",
    description: "Set or update the TaskSpec (event-sourced Task Ledger).",
    promptSnippet: "Record or refine the task goal, constraints, targets, and verification plan.",
    promptGuidelines: [
      "Use this early when the objective, constraints, or verification plan need to be made explicit.",
    ],
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
      options.runtime.task.setSpec(sessionId, {
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

  const taskAddItem = defineBrewvaTool({
    name: "task_add_item",
    label: "Task Add Item",
    description: "Add a task item to the Task Ledger.",
    promptSnippet:
      "Add a concrete task item to the Task Ledger instead of tracking it only in prose.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      text: Type.String(),
      status: Type.Optional(TaskItemStatusSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.task.addItem(sessionId, {
        id: params.id,
        text: params.text,
        status: params.status,
      });
      if (!result.ok) {
        return failTextResult(`Task item rejected (${result.error ?? "unknown_error"}).`, result);
      }
      return textResult(`Task item added (${result.itemId}).`, result);
    },
  });

  const taskUpdateItem = defineBrewvaTool({
    name: "task_update_item",
    label: "Task Update Item",
    description: "Update a task item in the Task Ledger.",
    promptSnippet: "Update task item text or status as work progresses.",
    parameters: Type.Object({
      id: Type.String(),
      text: Type.Optional(Type.String()),
      status: Type.Optional(TaskItemStatusSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.task.updateItem(sessionId, {
        id: params.id,
        text: params.text,
        status: params.status,
      });
      if (!result.ok) {
        return failTextResult(
          `Task item update rejected (${result.error ?? "unknown_error"}).`,
          result,
        );
      }
      return textResult("Task item updated.", result);
    },
  });

  const taskRecordBlocker = defineBrewvaTool({
    name: "task_record_blocker",
    label: "Task Record Blocker",
    description: "Record a blocker in the Task Ledger.",
    promptSnippet: "Record a concrete blocker so task state and risk stay explicit.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      message: Type.String(),
      source: Type.Optional(Type.String()),
      truthFactId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.task.recordBlocker(sessionId, {
        id: params.id,
        message: params.message,
        source: params.source,
        truthFactId: params.truthFactId,
      });
      if (!result.ok) {
        return failTextResult(`Blocker rejected (${result.error ?? "unknown_error"}).`, result);
      }
      return textResult(`Blocker recorded (${result.blockerId}).`, result);
    },
  });

  const taskResolveBlocker = defineBrewvaTool({
    name: "task_resolve_blocker",
    label: "Task Resolve Blocker",
    description: "Resolve (remove) a blocker from the Task Ledger.",
    promptSnippet: "Clear a blocker once the blocking condition is resolved.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.task.resolveBlocker(sessionId, params.id);
      if (!result.ok) {
        return failTextResult(
          `Blocker resolve rejected (${result.error ?? "unknown_error"}).`,
          result,
        );
      }
      return textResult("Blocker resolved.", result);
    },
  });

  const taskViewState = defineBrewvaTool({
    name: "task_view_state",
    label: "Task View State",
    description: "Show the current folded Task Ledger state.",
    promptSnippet: "Show the current folded task state before planning or resuming work.",
    promptGuidelines: [
      "Use this to resync with the recorded plan before adding or changing task items.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const state = options.runtime.task.getState(sessionId);
      const block = formatTaskStateBlock(state);
      return textResult(block || "[TaskLedger]\n(empty)", { ok: true });
    },
  });

  return [
    taskSetSpec,
    taskAddItem,
    taskUpdateItem,
    taskRecordBlocker,
    taskResolveBlocker,
    taskViewState,
  ];
}
