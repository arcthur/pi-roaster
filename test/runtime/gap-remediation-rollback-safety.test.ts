import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: rollback safety net", () => {
  test("tracks file mutations and restores the latest patch set", async () => {
    const workspace = createWorkspace("rollback");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-1";
    const filePath = join(workspace, "src/main.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "edit");
    runtime.tools.recordResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      success: true,
    });

    runtime.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      args: { file_path: "src/main.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      success: true,
    });

    const rollback = runtime.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    const verification = (runtime as any).verificationGate.stateStore.get(sessionId);
    expect(verification.evidence.length).toBe(0);
    expect(Object.keys(verification.checkRuns)).toHaveLength(0);
  });

  test("rolls back added files by deleting them", async () => {
    const workspace = createWorkspace("rollback-add");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-add-1";
    const createdPath = join(workspace, "src/new-file.ts");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.context.onTurnStart(sessionId, 1);

    runtime.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-add",
      toolName: "write",
      args: { file_path: "src/new-file.ts" },
    });
    writeFileSync(createdPath, "export const created = true;\n", "utf8");
    runtime.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-add",
      toolName: "write",
      success: true,
    });

    const rollback = runtime.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(existsSync(createdPath)).toBe(false);
  });

  test("returns restore_failed when rollback snapshot is missing", async () => {
    const workspace = createWorkspace("rollback-restore-failed");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-restore-failed-1";
    const filePath = join(workspace, "src/main.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    runtime.context.onTurnStart(sessionId, 1);

    runtime.tools.trackCallStart({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      args: { file_path: "src/main.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.tools.trackCallEnd({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      success: true,
    });

    const snapshotDir = join(workspace, ".orchestrator/snapshots", sessionId);
    for (const entry of readdirSync(snapshotDir)) {
      if (!entry.endsWith(".snap")) continue;
      rmSync(join(snapshotDir, entry), { force: true });
    }

    const rollback = runtime.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(false);
    expect(rollback.reason).toBe("restore_failed");
    expect(rollback.failedPaths).toContain("src/main.ts");
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");
    expect(runtime.fileChanges.hasHistory(sessionId)).toBe(true);
  });

  test("does not track file paths outside workspace during snapshot capture", async () => {
    const workspace = createWorkspace("rollback-path-traversal");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "rollback-path-traversal-1";

    const outside = runtime.fileChanges.captureBeforeToolCall({
      sessionId,
      toolCallId: "tc-outside",
      toolName: "edit",
      args: { file_path: "../outside.ts" },
    });
    expect(outside.trackedFiles).toEqual([]);

    const absoluteOutside = runtime.fileChanges.captureBeforeToolCall({
      sessionId,
      toolCallId: "tc-abs",
      toolName: "edit",
      args: { file_path: "/etc/passwd" },
    });
    expect(absoluteOutside.trackedFiles).toEqual([]);

    mkdirSync(join(workspace, "src"), { recursive: true });
    const inside = runtime.fileChanges.captureBeforeToolCall({
      sessionId,
      toolCallId: "tc-inside",
      toolName: "edit",
      args: { file_path: "src/inside.ts" },
    });
    expect(inside.trackedFiles).toEqual(["src/inside.ts"]);
  });

  test("supports cross-process undo via persisted patchset history", async () => {
    const workspace = createWorkspace("rollback-persisted");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-persisted-1";
    const filePath = join(workspace, "src/persisted.ts");
    writeFileSync(filePath, "export const persisted = 1;\n", "utf8");

    const runtimeA = new BrewvaRuntime({
      cwd: workspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    runtimeA.context.onTurnStart(sessionId, 1);
    runtimeA.tools.trackCallStart({
      sessionId,
      toolCallId: "persist-1",
      toolName: "edit",
      args: { file_path: "src/persisted.ts" },
    });
    writeFileSync(filePath, "export const persisted = 2;\n", "utf8");
    runtimeA.tools.trackCallEnd({
      sessionId,
      toolCallId: "persist-1",
      toolName: "edit",
      success: true,
    });

    const runtimeB = new BrewvaRuntime({
      cwd: workspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    const resolved = runtimeB.tools.resolveUndoSessionId();
    expect(resolved).toBe(sessionId);

    const rollback = runtimeB.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("export const persisted = 1;\n");
  });
});
