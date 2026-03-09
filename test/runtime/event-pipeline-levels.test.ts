import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

function createAuditConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.events.level = "audit";
  return config;
}

function createOpsConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.events.level = "ops";
  return config;
}

describe("event pipeline level classification", () => {
  test("keeps assertion evidence visible at audit level but drops query telemetry", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-session";

    runtime.events.record({
      sessionId,
      type: "tool_output_observed",
      payload: {
        toolName: "exec",
        rawTokens: 3,
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_execution_end",
      payload: {
        toolName: "exec",
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_distilled",
      payload: {
        toolName: "exec",
        strategy: "exec_heuristic",
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef: ".orchestrator/tool-output-artifacts/sample.txt",
      },
    });
    runtime.events.record({
      sessionId,
      type: "observability_query_executed",
      payload: {
        toolName: "obs_query",
        queryCount: 1,
        matchCount: 3,
      },
    });
    runtime.events.record({
      sessionId,
      type: "observability_assertion_recorded",
      payload: {
        verdict: "pass",
        metric: "latencyMs",
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_search",
      payload: {
        queryCount: 1,
        resultCount: 2,
        throttleLevel: "normal",
      },
    });

    expect(runtime.events.query(sessionId, { type: "tool_output_observed" })).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "tool_output_distilled" })).toHaveLength(1);
    expect(
      runtime.events.query(sessionId, { type: "tool_output_artifact_persisted" }),
    ).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "observability_query_executed" })).toHaveLength(
      0,
    );
    expect(
      runtime.events.query(sessionId, { type: "observability_assertion_recorded" }),
    ).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "tool_output_search" })).toHaveLength(0);
    expect(runtime.events.query(sessionId, { type: "tool_execution_end" })).toHaveLength(0);
  });

  test("keeps governance events visible at ops level with governance category", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-")),
      config: createOpsConfig(),
    });
    const sessionId = "ops-level-governance-session";

    const governanceTypes = [
      "governance_verify_spec_failed",
      "governance_verify_spec_passed",
      "governance_verify_spec_error",
      "governance_cost_anomaly_detected",
      "governance_cost_anomaly_error",
      "governance_compaction_integrity_checked",
      "governance_compaction_integrity_failed",
      "governance_compaction_integrity_error",
    ] as const;

    for (const type of governanceTypes) {
      runtime.events.record({
        sessionId,
        type,
        payload: {
          reason: "unit-test",
        },
      });
    }

    for (const type of governanceTypes) {
      const events = runtime.events.query(sessionId, { type });
      expect(events).toHaveLength(1);
      const structured = runtime.events.queryStructured(sessionId, { type });
      expect(structured[0]?.category).toBe("governance");
    }
  });

  test("keeps observability query telemetry visible at ops level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-observability-")),
      config: createOpsConfig(),
    });
    const sessionId = "ops-level-observability-session";

    runtime.events.record({
      sessionId,
      type: "observability_query_executed",
      payload: {
        toolName: "obs_query",
        queryCount: 1,
        matchCount: 3,
      },
    });

    expect(runtime.events.query(sessionId, { type: "observability_query_executed" })).toHaveLength(
      1,
    );
  });

  test("drops governance events at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-governance-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-governance-session";

    runtime.events.record({
      sessionId,
      type: "governance_verify_spec_failed",
      payload: {
        reason: "spec_mismatch",
      },
    });

    expect(runtime.events.query(sessionId, { type: "governance_verify_spec_failed" })).toHaveLength(
      0,
    );
  });

  test("keeps task watchdog events at ops level and drops them at audit level", () => {
    const auditRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-watchdog-")),
      config: createAuditConfig(),
    });
    const opsRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-watchdog-")),
      config: createOpsConfig(),
    });
    const sessionId = "watchdog-events-session";

    auditRuntime.events.record({
      sessionId,
      type: "task_stuck_detected",
      payload: {
        schema: "brewva.task-watchdog.v1",
        phase: "investigate",
        thresholdMs: 300000,
        baselineProgressAt: 1000,
        detectedAt: 301000,
        idleMs: 300000,
        openItemCount: 0,
        blockerId: "watchdog:task-stuck:no-progress",
        blockerWritten: true,
        suppressedBy: null,
      },
    });
    opsRuntime.events.record({
      sessionId,
      type: "task_stuck_detected",
      payload: {
        schema: "brewva.task-watchdog.v1",
        phase: "investigate",
        thresholdMs: 300000,
        baselineProgressAt: 1000,
        detectedAt: 301000,
        idleMs: 300000,
        openItemCount: 0,
        blockerId: "watchdog:task-stuck:no-progress",
        blockerWritten: true,
        suppressedBy: null,
      },
    });

    expect(auditRuntime.events.query(sessionId, { type: "task_stuck_detected" })).toHaveLength(0);
    expect(opsRuntime.events.query(sessionId, { type: "task_stuck_detected" })).toHaveLength(1);
  });
});
