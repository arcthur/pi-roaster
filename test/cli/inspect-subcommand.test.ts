import { describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-inspect-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function runInspect(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  const repoRoot = resolve(import.meta.dirname, "../..");
  return spawnSync("bun", ["run", "packages/brewva-cli/src/index.ts", "inspect", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

describe("inspect subcommand", () => {
  test(
    "rebuilds a replay-first session report from persisted artifacts",
    () => {
      const workspace = createWorkspace("json-report");
      const xdgConfigHome = join(workspace, ".xdg");
      mkdirSync(join(xdgConfigHome, "brewva"), { recursive: true });
      writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
      const previousXdgConfigHome = process.env["XDG_CONFIG_HOME"];

      try {
        process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
        const runtime = new BrewvaRuntime({
          cwd: workspace,
          config: structuredClone(DEFAULT_BREWVA_CONFIG),
        });
        const sessionId = "inspect-session-1";

        runtime.events.record({
          sessionId,
          type: "session_bootstrap",
          payload: {
            extensionsEnabled: false,
            addonsEnabled: false,
            skillBroker: {
              enabled: false,
              proposalBoundary: null,
            },
            skillLoad: {
              routingEnabled: false,
              routingScopes: ["core", "domain"],
              routableSkills: [],
              hiddenSkills: [],
            },
          },
        });
        runtime.context.onTurnStart(sessionId, 1);
        runtime.task.setSpec(sessionId, {
          schema: "brewva.task.v1",
          goal: "Inspect persisted runtime state",
        });
        runtime.task.recordBlocker(sessionId, {
          message: "verification still failing",
          source: "test",
        });
        runtime.truth.upsertFact(sessionId, {
          id: "truth:inspect",
          kind: "diagnostic",
          severity: "warn",
          summary: "inspect truth fact",
        });
        runtime.events.record({
          sessionId,
          type: "verification_outcome_recorded",
          payload: {
            schema: "brewva.verification.outcome.v1",
            level: "standard",
            outcome: "fail",
            failedChecks: ["tests"],
            missingEvidence: [],
            reason: "tests_failed",
          },
        });
        runtime.tools.recordResult({
          sessionId,
          toolName: "exec",
          args: { command: "bun test" },
          outputText: "Error: test failure",
          channelSuccess: false,
        });

        const result = runInspect(
          ["--cwd", workspace, "--config", ".brewva/brewva.json", "--session", sessionId, "--json"],
          {
            ...process.env,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
        );
        expect(result.status).toBe(0);

        const payload = JSON.parse(result.stdout) as {
          sessionId: string;
          task: { goal: string | null; blockers: number };
          truth: { activeFacts: number };
          verification: { outcome: string | null; failedChecks: string[] };
          ledger: { chainValid: boolean; rows: number };
          consistency: { ledgerChain: string };
          bootstrap: { skillBrokerEnabled: boolean | null; routingEnabled: boolean | null };
        };

        expect(payload.sessionId).toBe(sessionId);
        expect(payload.task.goal).toBe("Inspect persisted runtime state");
        expect(payload.task.blockers).toBeGreaterThanOrEqual(1);
        expect(payload.truth.activeFacts).toBeGreaterThanOrEqual(1);
        expect(payload.verification.outcome).toBe("fail");
        expect(payload.verification.failedChecks).toEqual(["tests"]);
        expect(payload.ledger.rows).toBeGreaterThan(0);
        expect(payload.ledger.chainValid).toBe(true);
        expect(payload.consistency.ledgerChain).toBe("ok");
        expect(payload.bootstrap.skillBrokerEnabled).toBe(false);
        expect(payload.bootstrap.routingEnabled).toBe(false);
      } finally {
        if (previousXdgConfigHome === undefined) {
          delete process.env["XDG_CONFIG_HOME"];
        } else {
          process.env["XDG_CONFIG_HOME"] = previousXdgConfigHome;
        }
      }
    },
    { timeout: 20_000 },
  );
});
