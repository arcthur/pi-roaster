import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCliSuccess,
  cleanupWorkspace,
  createWorkspace,
  findFinalBundle,
  type BrewvaEventBundle,
  parseJsonLines,
  runCliSync,
  runLive,
  sanitizeSessionId,
  writeMinimalConfig,
} from "./helpers.js";

describe("e2e: undo", () => {
  runLive("undo restores file after llm-driven edit", () => {
    const workspace = createWorkspace("undo");
    writeMinimalConfig(workspace);

    const runId = randomUUID();
    const fixturePath = join(workspace, "undo_fixture.txt");
    const baseline = `BASELINE-${runId}\n`;
    const changed = `CHANGED-${runId}\n`;
    writeFileSync(fixturePath, baseline, "utf8");

    try {
      const prompts = [
        `Open the file ./undo_fixture.txt and replace its entire contents with exactly '${changed.trim()}' followed by a newline. Use the file editing tool. Do not describe the change, just apply it.`,
        `Use a file editing tool now. Rewrite ./undo_fixture.txt so the full file content is exactly '${changed.trim()}' with a trailing newline.`,
      ];

      let bundle: BrewvaEventBundle | undefined;
      let sessionId = "";
      let afterEdit = readFileSync(fixturePath, "utf8");

      for (const prompt of prompts) {
        writeFileSync(fixturePath, baseline, "utf8");
        const run = runCliSync(workspace, ["--mode", "json", prompt], {
          timeoutMs: 10 * 60 * 1000,
        });

        assertCliSuccess(run, "undo-edit-run");

        bundle = findFinalBundle(parseJsonLines(run.stdout, { strict: true }));
        expect(bundle).toBeDefined();
        sessionId = bundle?.sessionId ?? "";
        expect(sessionId.length).toBeGreaterThan(0);

        afterEdit = readFileSync(fixturePath, "utf8");
        if (afterEdit === changed) {
          break;
        }
      }

      if (afterEdit !== changed) {
        throw new Error(
          [
            "[undo.live] model did not apply expected file edit after retries.",
            `[undo.live] expected: ${JSON.stringify(changed)}`,
            `[undo.live] actual: ${JSON.stringify(afterEdit)}`,
          ].join("\n"),
        );
      }

      expect(bundle).toBeDefined();
      const eventTypes = new Set((bundle?.events ?? []).map((event) => event.type));
      expect(eventTypes.has("patch_recorded")).toBe(true);

      const historyFile = join(
        workspace,
        ".orchestrator",
        "snapshots",
        sanitizeSessionId(sessionId),
        "patchsets.json",
      );
      expect(existsSync(historyFile)).toBe(true);

      const undo = runCliSync(workspace, ["--undo", "--session", sessionId]);
      assertCliSuccess(undo, "undo-cmd");
      expect(undo.stdout.includes("Rolled back")).toBe(true);
      expect(readFileSync(fixturePath, "utf8")).toBe(baseline);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("undo on empty workspace reports no_patchset", () => {
    const workspace = createWorkspace("undo-empty");
    writeMinimalConfig(workspace);

    try {
      const undo = runCliSync(workspace, ["--undo"]);
      assertCliSuccess(undo, "undo-empty");
      expect(undo.stdout.includes("No rollback applied (no_patchset).")).toBe(
        true,
      );
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
