import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, type TaskSpec } from "@brewva/brewva-runtime";

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "brewva-reversible-mutation-"));
}

describe("reversible mutation posture", () => {
  test("task mutations emit a task-state journal receipt", () => {
    const workspace = createWorkspace();
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `reversible-task-${crypto.randomUUID()}`;
    runtime.context.onTurnStart(sessionId, 1);

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-task-set-spec",
      toolName: "task_set_spec",
      args: {
        goal: "Implement the new runtime posture model",
      },
    });

    expect(started.allowed).toBe(true);
    expect(started.posture).toBe("reversible_mutate");
    expect(started.mutationReceipt?.strategy).toBe("task_state_journal");
    expect(started.mutationReceipt?.rollbackKind).toBe("task_state_replay");

    const nextSpec: TaskSpec = {
      schema: "brewva.task.v1",
      goal: "Implement the new runtime posture model",
    };
    runtime.task.setSpec(sessionId, nextSpec);
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-task-set-spec",
      toolName: "task_set_spec",
      args: {
        goal: nextSpec.goal,
      },
      outputText: "TaskSpec recorded.",
      channelSuccess: true,
      verdict: "pass",
    });

    const receiptEvent = runtime.events.query(sessionId, {
      type: "reversible_mutation_recorded",
      last: 1,
    })[0];
    expect(receiptEvent?.payload?.receipt).toBeDefined();
    expect(receiptEvent?.payload?.changed).toBe(true);
    expect(receiptEvent?.payload?.rollbackRef).toBe(
      `event-journal://${started.mutationReceipt?.id ?? ""}`,
    );
    expect(receiptEvent?.payload?.beforeTaskState).toEqual({
      items: [],
      blockers: [],
      updatedAt: null,
    });
    expect(
      (receiptEvent?.payload?.afterTaskState as { spec?: { goal?: string } })?.spec?.goal,
    ).toBe(nextSpec.goal);
  });

  test("workspace mutations emit patchset-backed reversible receipts", () => {
    const workspace = createWorkspace();
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "example.ts"), "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `reversible-workspace-${crypto.randomUUID()}`;
    runtime.context.onTurnStart(sessionId, 1);

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-edit-example",
      toolName: "edit",
      args: {
        file_path: "src/example.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
    });

    expect(started.allowed).toBe(true);
    expect(started.posture).toBe("reversible_mutate");
    expect(started.mutationReceipt?.strategy).toBe("workspace_patchset");
    expect(started.mutationReceipt?.rollbackKind).toBe("patchset");

    writeFileSync(join(workspace, "src", "example.ts"), "export const value = 2;\n", "utf8");
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-edit-example",
      toolName: "edit",
      args: {
        file_path: "src/example.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
      outputText: "Applied edit.",
      channelSuccess: true,
      verdict: "pass",
    });

    const receiptEvent = runtime.events.query(sessionId, {
      type: "reversible_mutation_recorded",
      last: 1,
    })[0];
    expect(receiptEvent?.payload?.receipt).toBeDefined();
    expect(receiptEvent?.payload?.changed).toBe(true);
    expect(typeof receiptEvent?.payload?.patchSetId).toBe("string");
    expect(
      (receiptEvent?.payload?.rollbackRef as string | undefined)?.startsWith("patchset://"),
    ).toBe(true);
  });

  test("task-state journal mutations can be rolled back through runtime.tools.rollbackLastMutation", () => {
    const workspace = createWorkspace();
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `reversible-task-rollback-${crypto.randomUUID()}`;
    runtime.context.onTurnStart(sessionId, 1);

    runtime.tools.start({
      sessionId,
      toolCallId: "tc-task-set-spec-rollback",
      toolName: "task_set_spec",
      args: {
        goal: "Apply and rollback task state",
      },
    });

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Apply and rollback task state",
    });
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-task-set-spec-rollback",
      toolName: "task_set_spec",
      args: {
        goal: "Apply and rollback task state",
      },
      outputText: "TaskSpec recorded.",
      channelSuccess: true,
      verdict: "pass",
    });

    const rollback = runtime.tools.rollbackLastMutation(sessionId);
    expect(rollback.ok).toBe(true);
    expect(rollback.strategy).toBe("task_state_journal");
    expect(runtime.task.getState(sessionId).spec).toBeUndefined();

    const rollbackEvent = runtime.events.query(sessionId, {
      type: "reversible_mutation_rolled_back",
      last: 1,
    })[0];
    expect(rollbackEvent?.payload?.strategy).toBe("task_state_journal");
    expect(rollbackEvent?.payload?.ok).toBe(true);
  });

  test("workspace patchset mutations can be rolled back through runtime.tools.rollbackLastMutation", () => {
    const workspace = createWorkspace();
    mkdirSync(join(workspace, "src"), { recursive: true });
    const filePath = join(workspace, "src", "rollback.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `reversible-workspace-rollback-${crypto.randomUUID()}`;
    runtime.context.onTurnStart(sessionId, 1);

    runtime.tools.start({
      sessionId,
      toolCallId: "tc-edit-rollback",
      toolName: "edit",
      args: {
        file_path: "src/rollback.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
    });

    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-edit-rollback",
      toolName: "edit",
      args: {
        file_path: "src/rollback.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
      outputText: "Applied edit.",
      channelSuccess: true,
      verdict: "pass",
    });

    const rollback = runtime.tools.rollbackLastMutation(sessionId);
    expect(rollback.ok).toBe(true);
    expect(rollback.strategy).toBe("workspace_patchset");
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");
  });

  test("direct patchset rollback also retires the matching reversible mutation receipt", () => {
    const workspace = createWorkspace();
    mkdirSync(join(workspace, "src"), { recursive: true });
    const filePath = join(workspace, "src", "direct-rollback.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `reversible-workspace-direct-${crypto.randomUUID()}`;
    runtime.context.onTurnStart(sessionId, 1);

    runtime.tools.start({
      sessionId,
      toolCallId: "tc-edit-direct-rollback",
      toolName: "edit",
      args: {
        file_path: "src/direct-rollback.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
    });

    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-edit-direct-rollback",
      toolName: "edit",
      args: {
        file_path: "src/direct-rollback.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
      outputText: "Applied edit.",
      channelSuccess: true,
      verdict: "pass",
    });

    const directRollback = runtime.tools.rollbackLastPatchSet(sessionId);
    expect(directRollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    const mutationRollback = runtime.tools.rollbackLastMutation(sessionId);
    expect(mutationRollback.ok).toBe(false);
    expect(mutationRollback.reason).toBe("no_mutation_receipt");
  });
});
