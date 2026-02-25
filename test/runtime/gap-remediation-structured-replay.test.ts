import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: structured replay events", () => {
  test("converts recorded events into structured replay stream", async () => {
    const workspace = createWorkspace("replay");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "replay-1";
    runtime.events.record({ sessionId, type: "session_start", payload: { cwd: workspace } });
    runtime.events.record({
      sessionId,
      type: "channel_session_bound",
      payload: { channel: "telegram", conversationId: "12345" },
    });
    runtime.events.record({ sessionId, type: "tool_call", turn: 1, payload: { toolName: "read" } });

    const structured = runtime.events.queryStructured(sessionId);
    expect(structured.length).toBe(3);
    expect(structured[0]?.schema).toBe("brewva.event.v1");
    expect(
      structured.some((event) => event.type === "session_start" && event.category === "session"),
    ).toBe(true);
    expect(
      structured.some(
        (event) => event.type === "channel_session_bound" && event.category === "session",
      ),
    ).toBe(true);
    expect(
      structured.some((event) => event.type === "tool_call" && event.category === "tool"),
    ).toBe(true);

    const sessions = runtime.events.listReplaySessions();
    expect(sessions.some((entry) => entry.sessionId === sessionId)).toBe(true);
  });
});
