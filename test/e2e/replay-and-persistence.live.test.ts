import { describe, expect } from "bun:test";
import {
  assertCliSuccess,
  cleanupWorkspace,
  createWorkspace,
  findFinalBundle,
  isRecord,
  latestStateSnapshot,
  parseJsonLines,
  runCliSync,
  runLive,
  writeMinimalConfig,
} from "./helpers.js";

type ReplayStructuredEvent = {
  schema: "brewva.event.v1";
  sessionId: string;
  type: string;
  timestamp: number;
  [key: string]: unknown;
};

function toReplayStructuredEvents(lines: unknown[]): ReplayStructuredEvent[] {
  const events: ReplayStructuredEvent[] = [];
  for (const line of lines) {
    if (!isRecord(line)) continue;
    if (line.schema !== "brewva.event.v1") continue;
    if (typeof line.sessionId !== "string") continue;
    if (typeof line.type !== "string") continue;
    if (typeof line.timestamp !== "number") continue;
    events.push(line as ReplayStructuredEvent);
  }
  return events;
}

describe("e2e: replay and persistence", () => {
  runLive("replay returns structured persisted events for json-mode session", () => {
    const workspace = createWorkspace("replay");
    writeMinimalConfig(workspace);

    try {
      const run = runCliSync(workspace, [
        "--mode",
        "json",
        "Do not call any tool. Reply exactly: REPLAY-OK",
      ]);

      assertCliSuccess(run, "replay-run");

      const bundle = findFinalBundle(parseJsonLines(run.stdout, { strict: true }));
      expect(bundle).toBeDefined();
      const sessionId = bundle?.sessionId ?? "";
      expect(sessionId.length).toBeGreaterThan(0);

      const replay = runCliSync(workspace, [
        "--replay",
        "--mode",
        "json",
        "--session",
        sessionId,
      ]);

      assertCliSuccess(replay, "replay-cmd");

      const replayEvents = toReplayStructuredEvents(
        parseJsonLines(replay.stdout, { strict: true }),
      );
      expect(replayEvents.length).toBeGreaterThan(0);

      for (const event of replayEvents) {
        expect(event.schema).toBe("brewva.event.v1");
        expect(event.sessionId).toBe(sessionId);
        expect(typeof event.type).toBe("string");
        expect(typeof event.timestamp).toBe("number");
      }

      const replayTypes = new Set(replayEvents.map((event) => event.type));
      expect(replayTypes.has("session_start")).toBe(true);
      expect(replayTypes.has("turn_start")).toBe(true);
      expect(replayTypes.has("turn_end")).toBe(true);
      expect(replayTypes.has("agent_end")).toBe(true);
      const bundleEventCount = bundle?.events.length ?? 0;
      expect(replayEvents.length).toBeGreaterThanOrEqual(bundleEventCount);
      expect(replayEvents.length).toBeLessThanOrEqual(bundleEventCount + 5);
      expect(replayTypes.has("session_shutdown")).toBe(true);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("normal shutdown does not write legacy runtime snapshot file", () => {
    const workspace = createWorkspace("persistence");
    writeMinimalConfig(workspace);

    try {
      const run = runCliSync(workspace, [
        "--mode",
        "json",
        "Do not call any tool. Reply exactly: SNAPSHOT-OK",
      ]);

      assertCliSuccess(run, "persistence-run");

      const bundle = findFinalBundle(parseJsonLines(run.stdout, { strict: true }));
      expect(bundle).toBeDefined();
      const sessionId = bundle?.sessionId ?? "";
      expect(sessionId.length).toBeGreaterThan(0);

      const snapshotFile = latestStateSnapshot(workspace);
      expect(snapshotFile).toBeUndefined();
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("replay on empty workspace reports no replayable session", () => {
    const workspace = createWorkspace("replay-empty");
    writeMinimalConfig(workspace);

    try {
      const replay = runCliSync(workspace, ["--replay", "--mode", "json"]);
      assertCliSuccess(replay, "replay-empty");
      expect(replay.stdout.trim()).toBe("");
      expect(replay.stderr.includes("Error: no replayable session found.")).toBe(
        true,
      );
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
