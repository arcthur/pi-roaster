import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: verification gate", () => {
  test("standard level executes configured commands", async () => {
    const workspace = createWorkspace("verify");
    writeConfig(
      workspace,
      createConfig({
        verification: {
          defaultLevel: "standard",
          checks: {
            quick: ["type-check"],
            standard: ["type-check", "tests"],
            strict: ["type-check", "tests", "diff-review"],
          },
          commands: {
            "type-check": "true",
            tests: "false",
            "diff-review": "true",
          },
        },
      }),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "verify-1";
    runtime.tools.markCall(sessionId, "edit");

    const report = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report.passed).toBe(false);
    expect(report.missingEvidence).toContain("tests");

    const ledgerText = runtime.truth.queryLedger(sessionId, { tool: "brewva_verify" });
    expect(ledgerText.includes("type-check")).toBe(true);
    expect(ledgerText.includes("tests")).toBe(true);
  });
});
