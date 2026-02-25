import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: event stream and context budget", () => {
  test("normalizes event payload to JSON-safe values", async () => {
    const workspace = createWorkspace("events-payload");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "events-payload-1";

    runtime.events.record({
      sessionId,
      type: "payload_test",
      payload: {
        ok: true,
        missing: undefined,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        nested: {
          drop: undefined,
          value: Number.NEGATIVE_INFINITY,
          arr: [1, Number.NaN, Number.POSITIVE_INFINITY, { x: undefined, y: 2 }],
        },
      },
    });

    const events = runtime.events.query(sessionId);
    expect(events).toHaveLength(1);
    const payload = (events[0]?.payload ?? {}) as any;

    expect(payload.ok).toBe(true);
    expect("missing" in payload).toBe(false);
    expect(payload.nan).toBe(0);
    expect(payload.inf).toBe(0);
    expect(payload.nested.value).toBe(0);
    expect(payload.nested.arr[0]).toBe(1);
    expect(payload.nested.arr[1]).toBe(0);
    expect(payload.nested.arr[2]).toBe(0);
    expect("x" in payload.nested.arr[3]).toBe(false);
    expect(payload.nested.arr[3].y).toBe(2);
  });

  test("tolerates invalid JSON lines in persisted event stream", async () => {
    const workspace = createWorkspace("events-bad-lines");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "events-bad-lines-1";
    runtime.events.record({ sessionId, type: "session_start", payload: { cwd: workspace } });

    const eventsPath = join(
      workspace,
      runtime.config.infrastructure.events.dir,
      `${sessionId}.jsonl`,
    );
    appendFileSync(eventsPath, "\n{ this is not json", "utf8");

    const events = runtime.events.query(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session_start");
  });

  test("secret values are redacted before event persistence", async () => {
    const workspace = createWorkspace("events-redact");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "events-redact-1";
    runtime.events.record({
      sessionId,
      type: "custom_event",
      payload: {
        token: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
        auth: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        nested: { key: "AKIA1234567890ABCDEF" },
      },
    });

    const eventsPath = join(
      workspace,
      runtime.config.infrastructure.events.dir,
      `${sessionId}.jsonl`,
    );
    const raw = readFileSync(eventsPath, "utf8");
    expect(raw.includes("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(raw.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(raw.includes("AKIA1234567890ABCDEF")).toBe(false);
  });

  test("drops context injection when usage exceeds hard limit", async () => {
    const workspace = createWorkspace("context-budget");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });

    const decision = await runtime.context.buildInjection("ctx-1", "fix broken test in runtime", {
      tokens: 195_000,
      contextWindow: 200_000,
      percent: 0.975,
    });
    expect(decision.accepted).toBe(false);
  });

  test("deduplicates per branch scope and allows reinjection after compaction", async () => {
    const workspace = createWorkspace("context-injection-dedup");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    const sessionId = "context-injection-dedup-1";
    runtime.truth.getLedgerDigest = () => "[Ledger Digest]\nrecords=0 pass=0 fail=0 inconclusive=0";

    runtime.context.onTurnStart(sessionId, 1);
    const first = await runtime.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 600,
        contextWindow: 4000,
        percent: 0.15,
      },
      "leaf-a",
    );
    expect(first.accepted).toBe(true);
    expect(first.text.length).toBeGreaterThan(0);

    runtime.context.onTurnStart(sessionId, 2);
    const second = await runtime.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 610,
        contextWindow: 4000,
        percent: 0.16,
      },
      "leaf-a",
    );
    expect(second.accepted).toBe(false);

    const dropped = runtime.events.query(sessionId, {
      type: "context_injection_dropped",
      last: 1,
    })[0];
    const payload = dropped?.payload as { reason?: string } | undefined;
    expect(payload?.reason).toBe("duplicate_content");

    runtime.context.onTurnStart(sessionId, 3);
    const third = await runtime.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 620,
        contextWindow: 4000,
        percent: 0.17,
      },
      "leaf-b",
    );
    expect(third.accepted).toBe(true);
    expect(third.text.length).toBeGreaterThan(0);

    runtime.context.markCompacted(sessionId, {
      fromTokens: 1500,
      toTokens: 500,
    });
    runtime.context.onTurnStart(sessionId, 4);

    const fourth = await runtime.context.buildInjection(
      sessionId,
      "fix duplicate injection",
      {
        tokens: 630,
        contextWindow: 4000,
        percent: 0.18,
      },
      "leaf-a",
    );
    expect(fourth.accepted).toBe(true);
    expect(fourth.text.length).toBeGreaterThan(0);
  });

  test("truncates context injection to maxInjectionTokens", async () => {
    const workspace = createWorkspace("context-injection-truncate");
    const config = createConfig({});
    config.infrastructure = {
      ...config.infrastructure,
      contextBudget: {
        ...config.infrastructure.contextBudget,
        maxInjectionTokens: 32,
      },
    };
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-injection-truncate-1";

    for (let i = 0; i < 12; i += 1) {
      runtime.tools.recordResult({
        sessionId,
        toolName: "exec",
        args: { command: `echo ${"x".repeat(240)} ${i}` },
        outputText: "ok",
        success: true,
      });
    }

    const injection = await runtime.context.buildInjection(sessionId, "fix bug", {
      tokens: 1000,
      contextWindow: 2000,
      percent: 0.5,
    });
    expect(injection.accepted).toBe(true);
    expect(injection.truncated).toBe(true);
    expect(injection.finalTokens).toBeLessThanOrEqual(32);
    expect(injection.text.length).toBeGreaterThan(0);
  });

  test("disables primary and supplemental token caps when contextBudget.enabled=false", async () => {
    const workspace = createWorkspace("context-budget-disabled");
    const config = createConfig({});
    config.infrastructure = {
      ...config.infrastructure,
      contextBudget: {
        ...config.infrastructure.contextBudget,
        enabled: false,
        maxInjectionTokens: 32,
      },
    };
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-budget-disabled-1";

    for (let i = 0; i < 12; i += 1) {
      runtime.tools.recordResult({
        sessionId,
        toolName: "exec",
        args: { command: `echo ${"x".repeat(240)} ${i}` },
        outputText: "ok",
        success: true,
      });
    }

    runtime.context.onTurnStart(sessionId, 1);
    const primary = await runtime.context.buildInjection(
      sessionId,
      "fix flaky test and keep complete context",
      {
        tokens: 900,
        contextWindow: 2000,
        percent: 0.45,
      },
      "leaf-a",
    );
    expect(primary.accepted).toBe(true);
    expect(primary.truncated).toBe(false);
    expect(primary.finalTokens).toBeGreaterThan(32);

    const supplemental = runtime.context.planSupplementalInjection(
      sessionId,
      "y".repeat(800),
      {
        tokens: 920,
        contextWindow: 2000,
        percent: 0.46,
      },
      "leaf-a",
    );
    expect(supplemental.accepted).toBe(true);
    expect(supplemental.droppedReason).toBeUndefined();
    expect(supplemental.finalTokens).toBeGreaterThan(32);
  });

  test("coordinates supplemental injection budget with primary context injection per scope", async () => {
    const workspace = createWorkspace("context-supplemental-budget");
    const config = createConfig({});
    config.infrastructure = {
      ...config.infrastructure,
      contextBudget: {
        ...config.infrastructure.contextBudget,
        maxInjectionTokens: 48,
      },
    };
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-supplemental-budget-1";
    const usage = {
      tokens: 800,
      contextWindow: 4000,
      percent: 0.2,
    };

    runtime.context.onTurnStart(sessionId, 1);
    const primary = await runtime.context.buildInjection(
      sessionId,
      "fix flaky tests",
      usage,
      "leaf-a",
    );
    const supplemental = runtime.context.planSupplementalInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    const primaryTokens = primary.accepted ? primary.finalTokens : 0;
    const supplementalTokens = supplemental.accepted ? supplemental.finalTokens : 0;
    expect(primaryTokens + supplementalTokens).toBeLessThanOrEqual(48);
    if (!supplemental.accepted) {
      expect(supplemental.droppedReason).toBe("budget_exhausted");
    }

    const otherScope = runtime.context.planSupplementalInjection(
      sessionId,
      "y".repeat(120),
      usage,
      "leaf-b",
    );
    expect(otherScope.accepted).toBe(true);

    runtime.context.onTurnStart(sessionId, 2);
    const afterTurnReset = runtime.context.planSupplementalInjection(
      sessionId,
      "z".repeat(120),
      usage,
      "leaf-a",
    );
    expect(afterTurnReset.accepted).toBe(true);
  });

  test("reserves supplemental budget only after explicit commit", async () => {
    const workspace = createWorkspace("context-supplemental-commit");
    const config = createConfig({});
    config.infrastructure = {
      ...config.infrastructure,
      contextBudget: {
        ...config.infrastructure.contextBudget,
        maxInjectionTokens: 24,
      },
    };
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-supplemental-commit-1";
    const usage = {
      tokens: 320,
      contextWindow: 4000,
      percent: 0.08,
    };

    runtime.context.onTurnStart(sessionId, 1);
    const first = runtime.context.planSupplementalInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(first.accepted).toBe(true);

    const second = runtime.context.planSupplementalInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(second.accepted).toBe(true);
    expect(second.finalTokens).toBe(first.finalTokens);

    runtime.context.commitSupplementalInjection(sessionId, first.finalTokens, "leaf-a");
    const exhausted = runtime.context.planSupplementalInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(exhausted.accepted).toBe(false);
    expect(exhausted.droppedReason).toBe("budget_exhausted");

    const otherScope = runtime.context.planSupplementalInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-b",
    );
    expect(otherScope.accepted).toBe(true);

    runtime.context.onTurnStart(sessionId, 2);
    const afterTurnReset = runtime.context.planSupplementalInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(afterTurnReset.accepted).toBe(true);
  });

  test("does not inject compaction summary blocks in default profile", async () => {
    const workspace = createWorkspace("context-compaction-summary");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-compaction-summary-1";

    runtime.context.markCompacted(sessionId, {
      fromTokens: 1600,
      toTokens: 500,
      entryId: "cmp-1",
      summary: "Keep failing tests, active objective, and latest diff only.",
    });

    const first = await runtime.context.buildInjection(sessionId, "fix flaky tests", {
      tokens: 800,
      contextWindow: 4000,
      percent: 0.2,
    });
    expect(first.accepted).toBe(true);
    expect(first.text.includes("[CompactionSummary]")).toBe(false);
    expect(first.text.includes("active objective")).toBe(false);

    const second = await runtime.context.buildInjection(sessionId, "continue fixing tests", {
      tokens: 820,
      contextWindow: 4000,
      percent: 0.21,
    });
    expect(second.accepted).toBe(false);
    expect(second.text.includes("[CompactionSummary]")).toBe(false);

    runtime.context.markCompacted(sessionId, {
      fromTokens: 1700,
      toTokens: 480,
      entryId: "cmp-2",
      summary: "Preserve unresolved assertion mismatch and the last failing command output.",
    });

    const third = await runtime.context.buildInjection(sessionId, "resume bugfix", {
      tokens: 790,
      contextWindow: 4000,
      percent: 0.19,
    });
    expect(third.accepted).toBe(true);
    expect(third.text.includes("[CompactionSummary]")).toBe(false);
    expect(third.text.includes("unresolved assertion mismatch")).toBe(false);
  });

  test("keeps compaction summary hidden after repeated compactions", async () => {
    const workspace = createWorkspace("context-compaction-summary-clear");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-compaction-summary-clear-1";

    runtime.context.markCompacted(sessionId, {
      fromTokens: 1400,
      toTokens: 460,
      entryId: "cmp-a",
      summary: "Keep active objective and last failing command output.",
    });

    const first = await runtime.context.buildInjection(sessionId, "continue", {
      tokens: 700,
      contextWindow: 4000,
      percent: 0.18,
    });
    expect(first.accepted).toBe(true);
    expect(first.text.includes("[CompactionSummary]")).toBe(false);

    runtime.context.markCompacted(sessionId, {
      fromTokens: 1500,
      toTokens: 500,
      entryId: "cmp-b",
    });

    const second = await runtime.context.buildInjection(sessionId, "continue", {
      tokens: 710,
      contextWindow: 4000,
      percent: 0.19,
    });
    expect(second.accepted).toBe(true);
    expect(second.text.includes("[CompactionSummary]")).toBe(false);
    expect(second.text.includes("last failing command output")).toBe(false);
  });

  test("keeps pending context behavior without exposing compaction summary blocks", async () => {
    const workspace = createWorkspace("context-hard-limit-retain");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-hard-limit-retain-1";

    runtime.context.markCompacted(sessionId, {
      fromTokens: 1800,
      toTokens: 520,
      entryId: "cmp-retain-1",
      summary: "Keep unresolved failures and active objective only.",
    });

    const dropped = await runtime.context.buildInjection(sessionId, "resume task", {
      tokens: 195_000,
      contextWindow: 200_000,
      percent: 0.975,
    });
    expect(dropped.accepted).toBe(false);
    runtime.context.onTurnStart(sessionId, 1);

    const recovered = await runtime.context.buildInjection(sessionId, "resume task", {
      tokens: 600,
      contextWindow: 200_000,
      percent: 0.3,
    });
    expect(recovered.accepted).toBe(true);
    expect(recovered.text.includes("[CompactionSummary]")).toBe(false);
    expect(recovered.text.includes("active objective")).toBe(false);
  });

  test("respects minTurnsBetweenCompaction when usage stays high", async () => {
    const workspace = createWorkspace("context-compaction-interval");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-compaction-interval-1";

    runtime.context.onTurnStart(sessionId, 1);
    expect(
      runtime.context.shouldRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(true);
    runtime.context.markCompacted(sessionId, { fromTokens: 820, toTokens: 120 });

    runtime.context.onTurnStart(sessionId, 2);
    expect(
      runtime.context.shouldRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(false);

    runtime.context.onTurnStart(sessionId, 3);
    expect(
      runtime.context.shouldRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(false);
  });

  test("keeps ledger turn aligned with turn_start instead of tool-result sequence", async () => {
    const workspace = createWorkspace("turn-alignment");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "turn-alignment-1";

    runtime.context.onTurnStart(sessionId, 7);
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo one" },
      outputText: "one",
      success: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo two" },
      outputText: "two",
      success: true,
    });
    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      costUsd: 0.001,
    });

    const rows = runtime.ledger.list(sessionId).filter((row) => row.tool !== "ledger_checkpoint");
    expect(rows.length).toBe(3);
    expect(rows.every((row) => row.turn === 7)).toBe(true);
  });

  test("writes context_compacted evidence into ledger", async () => {
    const workspace = createWorkspace("context-compaction-ledger");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "context-compaction-ledger-1";

    runtime.context.onTurnStart(sessionId, 3);
    runtime.context.markCompacted(sessionId, {
      fromTokens: 8000,
      toTokens: 1200,
    });

    const rows = runtime.ledger.list(sessionId);
    expect(rows.some((row) => row.tool === "brewva_context_compaction")).toBe(true);
  });
});
