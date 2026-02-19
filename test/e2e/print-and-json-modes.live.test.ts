import { describe, expect } from "bun:test";
import {
  assertCliSuccess,
  cleanupWorkspace,
  countEventType,
  createWorkspace,
  findFinalBundle,
  firstIndexOf,
  latestEventFile,
  parseEventFile,
  parseJsonLines,
  runCliSync,
  runLive,
  writeMinimalConfig,
} from "./helpers.js";

describe("e2e: print and json modes", () => {
  runLive("print mode produces output and persists core events", () => {
    const workspace = createWorkspace("print-mode");
    writeMinimalConfig(workspace);

    try {
      const result = runCliSync(workspace, [
        "--print",
        "Do not call any tool. Reply exactly: E2E-PRINT-OK",
      ]);

      assertCliSuccess(result, "print-mode");
      expect(result.stdout).toContain("E2E-PRINT-OK");

      const eventFile = latestEventFile(workspace);
      expect(eventFile).toBeDefined();
      const events = parseEventFile(eventFile!, { strict: true });

      expect(countEventType(events, "session_start")).toBeGreaterThanOrEqual(1);
      expect(countEventType(events, "turn_start")).toBeGreaterThanOrEqual(1);
      expect(countEventType(events, "turn_end")).toBeGreaterThanOrEqual(1);
      expect(countEventType(events, "agent_end")).toBeGreaterThanOrEqual(1);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("json mode emits final event bundle with structural invariants", () => {
    const workspace = createWorkspace("json-mode");
    writeMinimalConfig(workspace);

    try {
      const result = runCliSync(workspace, [
        "--mode",
        "json",
        "Do not call any tool. Reply exactly: E2E-JSON-OK",
      ]);

      assertCliSuccess(result, "json-mode");

      const lines = parseJsonLines(result.stdout, { strict: true });
      const bundle = findFinalBundle(lines);
      expect(bundle).toBeDefined();
      expect(bundle?.schema).toBe("brewva.stream.v1");
      expect(bundle?.type).toBe("brewva_event_bundle");
      expect(typeof bundle?.sessionId).toBe("string");
      expect(bundle?.sessionId.length ?? 0).toBeGreaterThan(0);
      expect(Array.isArray(bundle?.events)).toBe(true);
      expect(bundle?.events.length ?? 0).toBeGreaterThanOrEqual(4);

      expect(typeof bundle?.costSummary?.totalTokens).toBe("number");
      expect(typeof bundle?.costSummary?.totalCostUsd).toBe("number");

      const events = bundle!.events;
      const sessionStart = firstIndexOf(events, "session_start");
      const turnStart = firstIndexOf(events, "turn_start");
      const turnEnd = firstIndexOf(events, "turn_end");
      const agentEnd = firstIndexOf(events, "agent_end");

      expect(sessionStart).toBeGreaterThanOrEqual(0);
      expect(turnStart).toBeGreaterThanOrEqual(0);
      expect(turnEnd).toBeGreaterThanOrEqual(0);
      expect(agentEnd).toBeGreaterThanOrEqual(0);
      expect(sessionStart).toBeLessThan(turnStart);
      expect(turnStart).toBeLessThan(turnEnd);
      expect(turnEnd).toBeLessThan(agentEnd);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("piped stdin falls back to print-text mode", () => {
    const workspace = createWorkspace("piped-stdin");
    writeMinimalConfig(workspace);

    try {
      const result = runCliSync(
        workspace,
        [],
        {
          input: "Do not call any tool. Reply exactly: PIPED-OK\n",
        },
      );

      assertCliSuccess(result, "piped-stdin");
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      expect(latestEventFile(workspace)).toBeDefined();
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
