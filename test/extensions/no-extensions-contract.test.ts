import { describe, expect, test } from "bun:test";
import { createBrewvaExtension, createRuntimeCoreBridgeExtension } from "@brewva/brewva-extensions";
import { createMockExtensionAPI } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function handlerNames(handlers: Map<string, unknown[]>): string[] {
  return [...handlers.keys()].toSorted((left, right) => left.localeCompare(right));
}

describe("no-extensions contract", () => {
  test("full extension and runtime-core bridge register different handler surfaces", async () => {
    const fullRuntime = createRuntimeFixture();
    const full = createMockExtensionAPI();
    const fullExtension = createBrewvaExtension({
      runtime: fullRuntime,
      registerTools: false,
    });
    await fullExtension(full.api);

    const coreRuntime = createRuntimeFixture();
    const core = createMockExtensionAPI();
    const coreExtension = createRuntimeCoreBridgeExtension({
      runtime: coreRuntime,
    });
    await coreExtension(core.api);

    const fullHandlers = handlerNames(full.handlers);
    const coreHandlers = handlerNames(core.handlers);

    expect(fullHandlers).toContain("before_agent_start");
    expect(fullHandlers).toContain("context");
    expect(fullHandlers).toContain("session_start");
    expect(fullHandlers).toContain("turn_start");
    expect(fullHandlers).toContain("session_compact");
    expect(fullHandlers).toContain("session_shutdown");
    expect(fullHandlers).toContain("tool_call");
    expect(fullHandlers).toContain("tool_result");
    expect(fullHandlers).toContain("tool_execution_end");
    expect(fullHandlers).toContain("agent_end");

    expect(coreHandlers).toContain("before_agent_start");
    expect(coreHandlers).toContain("session_start");
    expect(coreHandlers).toContain("session_compact");
    expect(coreHandlers).toContain("session_shutdown");
    expect(coreHandlers).toContain("tool_call");
    expect(coreHandlers).toContain("tool_result");
    expect(coreHandlers).toContain("tool_execution_end");
    expect(coreHandlers).toContain("turn_start");

    expect(coreHandlers).not.toContain("context");
    expect(coreHandlers).not.toContain("agent_end");
  });
});
