import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: ledger compaction and redaction", () => {
  test("checkpointEveryTurns compacts session ledger and preserves hash chain", async () => {
    const workspace = createWorkspace("ledger");
    writeConfig(
      workspace,
      createConfig({
        ledger: {
          path: ".orchestrator/ledger/evidence.jsonl",
          checkpointEveryTurns: 3,
        },
      }),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "ledger-1";
    for (let i = 0; i < 5; i += 1) {
      runtime.context.onTurnStart(sessionId, i + 1);
      runtime.tools.recordResult({
        sessionId,
        toolName: "exec",
        args: { command: `echo ${i}` },
        outputText: `ok-${i}`,
        success: true,
      });
    }

    const rows = runtime.ledger.list(sessionId);
    expect(rows.some((row) => row.tool === "ledger_checkpoint")).toBe(true);
    expect(rows.length).toBeLessThan(6);

    const chain = runtime.ledger.verifyChain(sessionId);
    expect(chain.valid).toBe(true);
  });

  test("secret values are redacted before ledger persistence", async () => {
    const workspace = createWorkspace("redact");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "redact-1";
    runtime.tools.recordResult({
      sessionId,
      toolName: "read",
      args: { token: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" },
      outputText: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      success: true,
      metadata: {
        nested: {
          key: "AKIA1234567890ABCDEF",
        },
      },
    });

    const ledgerText = readFileSync(runtime.ledger.path, "utf8");
    expect(ledgerText.includes("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(ledgerText.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(ledgerText.includes("AKIA1234567890ABCDEF")).toBe(false);
  });

  test("tolerates invalid JSON lines in persisted ledger file", async () => {
    const workspace = createWorkspace("ledger-bad-lines");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "ledger-bad-lines-1";
    runtime.tools.recordResult({
      sessionId,
      toolName: "read",
      args: { path: "src/a.ts" },
      outputText: "ok-a",
      success: true,
    });

    appendFileSync(runtime.ledger.path, "\nnot-json", "utf8");

    const rows = runtime.ledger.list(sessionId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.tool).toBe("read");

    const chain = runtime.ledger.verifyChain(sessionId);
    expect(chain.valid).toBe(true);
  });
});
