import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCliSuccess,
  cleanupWorkspace,
  createWorkspace,
  findFinalBundle,
  isRecord,
  parseJsonLines,
  runCliSync,
  runLive,
  skipLiveForProviderRateLimitResult,
  writeMinimalConfig,
} from "./helpers.js";

describe("e2e: tool call proof", () => {
  runLive("agent can read secret token from workspace file", () => {
    const workspace = createWorkspace("tool-proof");
    writeMinimalConfig(workspace);

    const token = `SECRET-${randomUUID()}`;
    writeFileSync(join(workspace, "token.txt"), token, "utf8");

    try {
      const run = runCliSync(workspace, [
        "--print",
        "Read the file ./token.txt and output its exact contents. Do not guess.",
      ]);

      if (skipLiveForProviderRateLimitResult("tool-proof", run)) {
        return;
      }
      assertCliSuccess(run, "tool-proof");
      expect(run.stdout.includes(token)).toBe(true);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("--no-addons mode still emits valid final bundle", () => {
    const workspace = createWorkspace("no-addons");
    writeMinimalConfig(workspace);

    try {
      const run = runCliSync(workspace, [
        "--no-addons",
        "--mode",
        "json",
        "Do not call any tool. Reply exactly: NO-EXT-OK",
      ]);

      if (skipLiveForProviderRateLimitResult("no-addons", run)) {
        return;
      }
      assertCliSuccess(run, "no-addons");

      const lines = parseJsonLines(run.stdout, { strict: true });
      const bundle = findFinalBundle(lines);
      expect(bundle).toBeDefined();
      expect(bundle?.schema).toBe("brewva.stream.v1");
      expect(bundle?.type).toBe("brewva_event_bundle");
      expect(bundle?.events.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(run.stdout.includes("NO-EXT-OK")).toBe(true);

      const nonBundleLines = lines.filter((line) => {
        if (!isRecord(line)) return false;
        return !(line.schema === "brewva.stream.v1" && line.type === "brewva_event_bundle");
      });
      expect(nonBundleLines.length).toBeGreaterThan(0);
      expect(
        nonBundleLines.some(
          (line) => isRecord(line) && typeof line.type === "string" && line.type === "turn_end",
        ),
      ).toBe(true);
      expect(
        nonBundleLines.some(
          (line) => isRecord(line) && typeof line.type === "string" && line.type === "agent_end",
        ),
      ).toBe(true);

      const eventTypes = new Set((bundle?.events ?? []).map((event) => event.type));
      expect(eventTypes.has("session_start")).toBe(true);
      expect(eventTypes.has("agent_end")).toBe(true);
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
