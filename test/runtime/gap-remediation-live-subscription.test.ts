import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: live event subscription", () => {
  test("streams structured events and stops after unsubscribe", async () => {
    const workspace = createWorkspace("event-subscribe");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "event-subscribe-1";

    const received: any[] = [];
    const unsubscribe = runtime.events.subscribe((event) => {
      received.push(event);
    });

    runtime.context.onTurnStart(sessionId, 1);
    runtime.events.record({ sessionId, type: "session_start", payload: { cwd: workspace } });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo ok" },
      outputText: "ok",
      success: true,
    });

    expect(received.some((event) => event.schema === "brewva.event.v1")).toBe(true);
    expect(
      received.some((event) => event.type === "session_start" && event.category === "session"),
    ).toBe(true);
    expect(
      received.some((event) => event.type === "tool_result_recorded" && event.category === "tool"),
    ).toBe(true);

    unsubscribe();
    const before = received.length;
    runtime.events.record({ sessionId, type: "turn_end", turn: 1 });
    expect(received).toHaveLength(before);
  });
});
