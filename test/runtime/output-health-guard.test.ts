import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("Output health guard", () => {
  test("injects guard when drunk output detected", () => {
    const workspace = createWorkspace("output-health-guard");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "output-health-guard-1";

    runtime.recordEvent({
      sessionId,
      type: "message_update",
      payload: {
        deltaType: "text_delta",
        deltaChars: 10,
        health: {
          score: 0.2,
          drunk: true,
          flags: ["repetition_high"],
          windowChars: 1000,
        },
      },
    });

    const injection = runtime.buildContextInjection(sessionId, "next");
    expect(injection.text.includes("[OutputHealthGuard]")).toBe(true);
  });

  test("skips guard for healthy output", () => {
    const workspace = createWorkspace("output-health-ok");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "output-health-guard-ok-1";

    runtime.recordEvent({
      sessionId,
      type: "message_update",
      payload: {
        deltaType: "text_delta",
        deltaChars: 10,
        health: {
          score: 0.95,
          drunk: false,
          flags: [],
          windowChars: 1000,
        },
      },
    });

    const injection = runtime.buildContextInjection(sessionId, "next");
    expect(injection.text.includes("[OutputHealthGuard]")).toBe(false);
  });
});
