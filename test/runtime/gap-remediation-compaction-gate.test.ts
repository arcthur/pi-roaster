import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: runtime core compaction gate", () => {
  test("blocks non-session_compact tools at critical pressure and unblocks after compaction", async () => {
    const workspace = createWorkspace("core-compaction-gate");
    writeConfig(workspace, createConfig({
      infrastructure: {
        contextBudget: {
          enabled: true,
          compactionThresholdPercent: 0.8,
          hardLimitPercent: 0.9,
        },
      },
    }));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "core-compaction-gate-1";
    runtime.context.onTurnStart(sessionId, 3);

    const usage = {
      tokens: 95,
      contextWindow: 100,
      percent: 0.95,
    };
    runtime.context.observeUsage(sessionId, usage);

    const blocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-blocked",
      toolName: "exec",
      args: { command: "echo blocked" },
      usage,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("session_compact")).toBe(true);
    expect(
      runtime.events.query(sessionId, { type: "context_compaction_gate_blocked_tool" }),
    ).toHaveLength(1);

    const compactAllowed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-compact",
      toolName: "session_compact",
      args: { reason: "critical" },
      usage,
    });
    expect(compactAllowed.allowed).toBe(true);

    runtime.context.markCompacted(sessionId, {
      fromTokens: usage.tokens,
      toTokens: 40,
    });

    const unblocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-after-compact",
      toolName: "exec",
      args: { command: "echo ok" },
      usage,
    });
    expect(unblocked.allowed).toBe(true);
  });
});
