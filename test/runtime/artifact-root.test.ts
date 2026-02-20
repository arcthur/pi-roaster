import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-artifact-root-${name}-`));
  mkdirSync(join(workspace, "packages", "demo"), { recursive: true });
  return workspace;
}

describe("runtime artifact root resolution", () => {
  test("uses nearest repository/config root for .orchestrator artifacts", () => {
    const workspace = createWorkspace("with-git");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    const nestedCwd = join(workspace, "packages", "demo");

    const runtime = new BrewvaRuntime({ cwd: nestedCwd });
    const sessionId = "artifact-root-1";

    runtime.recordEvent({ sessionId, type: "session_start" });
    runtime.recordToolResult({
      sessionId,
      toolName: "read",
      args: { file_path: "README.md" },
      outputText: "ok",
      success: true,
    });

    expect(runtime.workspaceRoot).toBe(workspace);
    expect(runtime.ledger.path).toBe(join(workspace, ".orchestrator", "ledger", "evidence.jsonl"));
    expect(existsSync(join(workspace, ".orchestrator", "events", `${sessionId}.jsonl`))).toBe(true);
    expect(existsSync(join(nestedCwd, ".orchestrator"))).toBe(false);
  });

  test("falls back to cwd when no root marker exists", () => {
    const workspace = createWorkspace("no-marker");
    const nestedCwd = join(workspace, "packages", "demo");

    const runtime = new BrewvaRuntime({ cwd: nestedCwd });
    expect(runtime.workspaceRoot).toBe(nestedCwd);
  });
});
