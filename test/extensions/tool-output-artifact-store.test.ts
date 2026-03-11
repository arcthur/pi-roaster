import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistToolOutputArtifact } from "../../packages/brewva-gateway/src/runtime-plugins/tool-output-artifact-store.js";

describe("tool output artifact store", () => {
  test("persists raw output and returns artifact metadata", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-output-artifact-"));
    const result = persistToolOutputArtifact({
      workspaceRoot: workspace,
      sessionId: "session-1",
      toolCallId: "tc-1",
      toolName: "exec",
      outputText: "line one\nline two",
      timestamp: 1_700_000_000_000,
    });

    expect(result).not.toBeNull();
    expect(result?.artifactRef.startsWith(".orchestrator/tool-output-artifacts/")).toBe(true);
    expect(result?.rawChars).toBe(17);
    expect(result?.rawBytes).toBeGreaterThan(0);
    expect(result?.sha256.length).toBe(64);
    expect(result?.absolutePath).toContain(workspace);
    expect(existsSync(result?.absolutePath ?? "")).toBe(true);
    expect(readFileSync(result?.absolutePath ?? "", "utf8")).toBe("line one\nline two");
  });

  test("returns null when output text is empty", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-output-artifact-empty-"));
    const result = persistToolOutputArtifact({
      workspaceRoot: workspace,
      sessionId: "session-2",
      toolCallId: "tc-empty",
      toolName: "read",
      outputText: "",
    });

    expect(result).toBeNull();
  });
});
