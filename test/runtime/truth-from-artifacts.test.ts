import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("Truth extraction from evidence artifacts", () => {
  test("records command_failure truth facts and clears on success", async () => {
    const workspace = createWorkspace("truth-from-artifacts");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-1";

    const failureOutput = [
      "FAIL src/foo.test.ts",
      "AssertionError: expected 1 to be 2",
      "    at Object.<anonymous> (/repo/src/foo.test.ts:12:7)",
    ].join("\n");

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: failureOutput,
      channelSuccess: false,
      metadata: {
        details: { result: { exitCode: 1 } },
      },
    });

    const truth1 = runtime.truth.getState(sessionId);
    const fact1 = truth1.facts.find((fact) => fact.kind === "command_failure");
    expect(fact1).not.toBeUndefined();
    expect(fact1?.status).toBe("active");
    expect(fact1?.summary.includes("command failed: bun test")).toBe(true);

    const task1 = runtime.task.getState(sessionId);
    const blocker1 = task1.blockers.find((blocker) => blocker.id === fact1?.id);
    expect(blocker1).not.toBeUndefined();
    expect(blocker1?.truthFactId).toBe(fact1?.id);
    expect(blocker1?.message).toBe(fact1?.summary);

    const recorded1 = runtime.events.query(sessionId, {
      type: "tool_result_recorded",
      last: 1,
    })[0];
    const recordedPayload1 = recorded1?.payload as
      | {
          failureClass?: string | null;
          failureContext?: {
            failureClass?: string | null;
          } | null;
        }
      | undefined;
    expect(recordedPayload1?.failureClass).toBe("execution");
    expect(recordedPayload1?.failureContext?.failureClass).toBe("execution");

    const injection1 = await runtime.context.buildInjection(sessionId, "next");
    expect(injection1.text.includes("[TruthFacts]")).toBe(true);
    expect(injection1.text.includes(fact1?.id ?? "")).toBe(true);

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "",
      channelSuccess: true,
      metadata: {
        details: { result: { exitCode: 0 } },
      },
    });

    const truth2 = runtime.truth.getState(sessionId);
    const fact2 = truth2.facts.find((fact) => fact.id === fact1?.id);
    expect(fact2).not.toBeUndefined();
    expect(fact2?.status).toBe("resolved");

    const task2 = runtime.task.getState(sessionId);
    expect(task2.blockers.some((blocker) => blocker.id === fact1?.id)).toBe(false);
  });

  test("suppresses blockers for invocation validation failures and resolves stale command blockers", () => {
    const workspace = createWorkspace("truth-from-artifacts-validation");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-validation-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Process exited with code 2.",
      channelSuccess: false,
      metadata: {
        details: { result: { exitCode: 2 } },
      },
    });

    const failureFact = runtime.truth
      .getState(sessionId)
      .facts.find((fact) => fact.kind === "command_failure" && fact.status === "active");
    expect(failureFact).toBeDefined();
    expect(
      runtime.task.getState(sessionId).blockers.some((blocker) => blocker.id === failureFact?.id),
    ).toBe(true);

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test", timeout: 120_000 },
      outputText: "Invalid arguments: timeout must be <= 7200",
      channelSuccess: false,
      metadata: {
        details: {
          message: "Schema validation failed",
        },
      },
    });

    const truth = runtime.truth.getState(sessionId);
    const sameFact = truth.facts.find((fact) => fact.id === failureFact?.id);
    expect(sameFact?.status).toBe("resolved");

    const recorded = runtime.events.query(sessionId, {
      type: "tool_result_recorded",
      last: 1,
    })[0];
    const recordedPayload = recorded?.payload as
      | {
          failureClass?: string | null;
          failureContext?: {
            failureClass?: string | null;
          } | null;
        }
      | undefined;
    expect(recordedPayload?.failureClass).toBe("invocation_validation");
    expect(recordedPayload?.failureContext?.failureClass).toBe("invocation_validation");

    const task = runtime.task.getState(sessionId);
    expect(task.blockers.some((blocker) => blocker.id === failureFact?.id)).toBe(false);
    expect(
      truth.facts.some((fact) => fact.kind === "command_failure" && fact.status === "active"),
    ).toBe(false);
  });

  test("does not create blockers for search no-match exit code", () => {
    const workspace = createWorkspace("truth-from-artifacts-nomatch");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-2";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: 'rg "needle" src' },
      outputText: "(no output)\n\nProcess exited with code 1.",
      channelSuccess: false,
      metadata: {
        details: { result: { exitCode: 1 } },
      },
    });

    const truth = runtime.truth.getState(sessionId);
    expect(
      truth.facts.some((fact) => fact.kind === "command_failure" && fact.status === "active"),
    ).toBe(false);

    const task = runtime.task.getState(sessionId);
    expect(task.blockers.length).toBe(0);
  });

  test("does not create blockers for grep -c no-match exit code", () => {
    const workspace = createWorkspace("truth-from-artifacts-grep-count");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-3";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: 'grep -c "needle" src/file.ts' },
      outputText: "0\n\nProcess exited with code 1.",
      channelSuccess: false,
      metadata: {
        details: { result: { exitCode: 1 } },
      },
    });

    const truth = runtime.truth.getState(sessionId);
    expect(
      truth.facts.some((fact) => fact.kind === "command_failure" && fact.status === "active"),
    ).toBe(false);

    const task = runtime.task.getState(sessionId);
    expect(task.blockers.length).toBe(0);
  });

  test("does not create blockers for git -C grep no-match exit code", () => {
    const workspace = createWorkspace("truth-from-artifacts-git-c-grep");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-4";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: 'git -C repo grep "needle" src' },
      outputText: "(no output)\n\nProcess exited with code 1.",
      channelSuccess: false,
      metadata: {
        details: { result: { exitCode: 1 } },
      },
    });

    const truth = runtime.truth.getState(sessionId);
    expect(
      truth.facts.some((fact) => fact.kind === "command_failure" && fact.status === "active"),
    ).toBe(false);

    const task = runtime.task.getState(sessionId);
    expect(task.blockers.length).toBe(0);
  });

  test("does not create blockers when exitCode is parsed from output (CRLF)", () => {
    const workspace = createWorkspace("truth-from-artifacts-exitcode-output");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-5";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: 'rg "needle" src' },
      outputText: "(no output)\r\n\r\nProcess exited with code 1.",
      channelSuccess: false,
      metadata: {
        details: {},
      },
    });

    const truth = runtime.truth.getState(sessionId);
    expect(
      truth.facts.some((fact) => fact.kind === "command_failure" && fact.status === "active"),
    ).toBe(false);

    const task = runtime.task.getState(sessionId);
    expect(task.blockers.length).toBe(0);
  });

  test("records and resolves observability SLO violations from obs_slo_assert evidence", () => {
    const workspace = createWorkspace("truth-from-artifacts-observability");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-observability-1";

    const assertionSpec = {
      types: ["startup_sample"],
      where: { service: "api" },
      metric: "startupMs",
      aggregation: "p95",
      operator: "<=",
      threshold: 800,
      windowMinutes: 15,
      minSamples: 2,
    };

    runtime.tools.recordResult({
      sessionId,
      toolName: "obs_slo_assert",
      args: assertionSpec,
      outputText: "verdict: fail",
      channelSuccess: true,
      metadata: {
        details: {
          verdict: "fail",
          observabilityAssertion: {
            kind: "slo_assert",
            spec: assertionSpec,
            observedValue: 930,
            sampleSize: 2,
            queryRef: ".orchestrator/tool-output-artifacts/sample-1.json",
            severity: "warn",
          },
        },
      },
    });

    const failFact = runtime.truth
      .getState(sessionId)
      .facts.find(
        (fact) => fact.kind === "observability_slo_violation" && fact.status === "active",
      );
    expect(failFact).toBeDefined();
    expect(failFact?.details?.queryRef).toBe(".orchestrator/tool-output-artifacts/sample-1.json");
    expect(
      runtime.task.getState(sessionId).blockers.some((blocker) => blocker.id === failFact?.id),
    ).toBe(true);

    runtime.tools.recordResult({
      sessionId,
      toolName: "obs_slo_assert",
      args: assertionSpec,
      outputText: "verdict: inconclusive",
      channelSuccess: true,
      metadata: {
        details: {
          verdict: "inconclusive",
          observabilityAssertion: {
            kind: "slo_assert",
            spec: assertionSpec,
            observedValue: null,
            sampleSize: 1,
            queryRef: ".orchestrator/tool-output-artifacts/sample-2.json",
            severity: "warn",
          },
        },
      },
    });

    expect(
      runtime.truth.getState(sessionId).facts.find((fact) => fact.id === failFact?.id)?.status,
    ).toBe("active");

    runtime.tools.recordResult({
      sessionId,
      toolName: "obs_slo_assert",
      args: assertionSpec,
      outputText: "verdict: pass",
      channelSuccess: true,
      metadata: {
        details: {
          verdict: "pass",
          observabilityAssertion: {
            kind: "slo_assert",
            spec: assertionSpec,
            observedValue: 780,
            sampleSize: 2,
            queryRef: ".orchestrator/tool-output-artifacts/sample-3.json",
            severity: "warn",
          },
        },
      },
    });

    expect(
      runtime.truth.getState(sessionId).facts.find((fact) => fact.id === failFact?.id)?.status,
    ).toBe("resolved");
    expect(
      runtime.task.getState(sessionId).blockers.some((blocker) => blocker.id === failFact?.id),
    ).toBe(false);
  });

  test("uses explicit verdicts for exec truth sync even when the tool channel succeeds", () => {
    const workspace = createWorkspace("truth-from-artifacts-explicit-verdict");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-explicit-verdict-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "FAIL src/foo.test.ts\nProcess exited with code 1.",
      channelSuccess: true,
      verdict: "fail",
      metadata: {
        details: { result: { exitCode: 1 } },
      },
    });

    const activeFailure = runtime.truth
      .getState(sessionId)
      .facts.find((fact) => fact.kind === "command_failure" && fact.status === "active");
    expect(activeFailure).toBeDefined();
    expect(
      runtime.task.getState(sessionId).blockers.some((blocker) => blocker.id === activeFailure?.id),
    ).toBe(true);

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Process still running.",
      channelSuccess: true,
      verdict: "inconclusive",
      metadata: {
        details: { status: "running" },
      },
    });

    expect(
      runtime.truth.getState(sessionId).facts.find((fact) => fact.id === activeFailure?.id)?.status,
    ).toBe("active");

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "All tests passed",
      channelSuccess: true,
      verdict: "pass",
      metadata: {
        details: { result: { exitCode: 0 } },
      },
    });

    expect(
      runtime.truth.getState(sessionId).facts.find((fact) => fact.id === activeFailure?.id)?.status,
    ).toBe("resolved");
    expect(
      runtime.task.getState(sessionId).blockers.some((blocker) => blocker.id === activeFailure?.id),
    ).toBe(false);
  });
});
