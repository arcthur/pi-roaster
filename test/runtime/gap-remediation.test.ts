import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".config", "brewva"), { recursive: true });
  return workspace;
}

function writeConfig(workspace: string, config: BrewvaConfig): void {
  writeFileSync(
    join(workspace, ".config/brewva/brewva.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
}

function createConfig(overrides: Partial<BrewvaConfig>): BrewvaConfig {
  return {
    ...DEFAULT_BREWVA_CONFIG,
    ...overrides,
    skills: {
      ...DEFAULT_BREWVA_CONFIG.skills,
      ...overrides.skills,
      selector: {
        ...DEFAULT_BREWVA_CONFIG.skills.selector,
        ...overrides.skills?.selector,
      },
    },
    verification: {
      ...DEFAULT_BREWVA_CONFIG.verification,
      ...overrides.verification,
      checks: {
        ...DEFAULT_BREWVA_CONFIG.verification.checks,
        ...overrides.verification?.checks,
      },
      commands: {
        ...DEFAULT_BREWVA_CONFIG.verification.commands,
        ...overrides.verification?.commands,
      },
    },
    ledger: {
      ...DEFAULT_BREWVA_CONFIG.ledger,
      ...overrides.ledger,
    },
    security: {
      ...DEFAULT_BREWVA_CONFIG.security,
      ...overrides.security,
    },
    parallel: {
      ...DEFAULT_BREWVA_CONFIG.parallel,
      ...overrides.parallel,
    },
  };
}

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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "verify-1";
    runtime.markToolCall(sessionId, "edit");

    const report = await runtime.verifyCompletion(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report.passed).toBe(false);
    expect(report.missingEvidence).toContain("tests");

    const ledgerText = runtime.queryLedger(sessionId, { tool: "brewva_verify" });
    expect(ledgerText.includes("type-check")).toBe(true);
    expect(ledgerText.includes("tests")).toBe(true);
  });
});

describe("Gap remediation: ledger compaction and redaction", () => {
  test("checkpointEveryTurns compacts session ledger and preserves hash chain", () => {
    const workspace = createWorkspace("ledger");
    writeConfig(
      workspace,
      createConfig({
        ledger: {
          path: ".orchestrator/ledger/evidence.jsonl",
          digestWindow: 2,
          checkpointEveryTurns: 3,
        },
      }),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "ledger-1";
    for (let i = 0; i < 5; i += 1) {
      runtime.onTurnStart(sessionId, i + 1);
      runtime.recordToolResult({
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

  test("secret values are redacted before ledger persistence", () => {
    const workspace = createWorkspace("redact");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "redact-1";
    runtime.recordToolResult({
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

  test("tolerates invalid JSON lines in persisted ledger file", () => {
    const workspace = createWorkspace("ledger-bad-lines");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "ledger-bad-lines-1";
    runtime.recordToolResult({
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

describe("Gap remediation: parallel result lifecycle", () => {
  test("detects patch conflicts and supports merged patchset", () => {
    const runtime = new BrewvaRuntime({ cwd: process.cwd() });
    const sessionId = "parallel-1";

    runtime.recordWorkerResult(sessionId, {
      workerId: "w1",
      status: "ok",
      summary: "worker-1",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "a" }],
      },
    });
    runtime.recordWorkerResult(sessionId, {
      workerId: "w2",
      status: "ok",
      summary: "worker-2",
      patches: {
        id: "ps-2",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "b" }],
      },
    });

    const conflictReport = runtime.mergeWorkerResults(sessionId);
    expect(conflictReport.status).toBe("conflicts");
    expect(conflictReport.conflicts.length).toBe(1);

    runtime.clearWorkerResults(sessionId);
    runtime.recordWorkerResult(sessionId, {
      workerId: "w1",
      status: "ok",
      summary: "worker-1",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "a" }],
      },
    });
    runtime.recordWorkerResult(sessionId, {
      workerId: "w2",
      status: "ok",
      summary: "worker-2",
      patches: {
        id: "ps-2",
        createdAt: Date.now(),
        changes: [{ path: "src/b.ts", action: "modify", diffText: "b" }],
      },
    });

    const mergedReport = runtime.mergeWorkerResults(sessionId);
    expect(mergedReport.status).toBe("merged");
    expect(mergedReport.mergedPatchSet?.changes.length).toBe(2);
  });
});

describe("Gap remediation: event stream and context budget", () => {
  test("normalizes event payload to JSON-safe values", () => {
    const workspace = createWorkspace("events-payload");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "events-payload-1";

    runtime.recordEvent({
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

    const events = runtime.queryEvents(sessionId);
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

  test("tolerates invalid JSON lines in persisted event stream", () => {
    const workspace = createWorkspace("events-bad-lines");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "events-bad-lines-1";
    runtime.recordEvent({ sessionId, type: "session_start", payload: { cwd: workspace } });

    const eventsPath = join(
      workspace,
      runtime.config.infrastructure.events.dir,
      `${sessionId}.jsonl`,
    );
    appendFileSync(eventsPath, "\n{ this is not json", "utf8");

    const events = runtime.queryEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session_start");
  });

  test("secret values are redacted before event persistence", () => {
    const workspace = createWorkspace("events-redact");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "events-redact-1";
    runtime.recordEvent({
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

  test("drops context injection when usage exceeds hard limit", () => {
    const workspace = createWorkspace("context-budget");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });

    const decision = runtime.buildContextInjection("ctx-1", "fix broken test in runtime", {
      tokens: 195_000,
      contextWindow: 200_000,
      percent: 0.975,
    });
    expect(decision.accepted).toBe(false);
  });

  test("deduplicates per branch scope and allows reinjection after compaction", () => {
    const workspace = createWorkspace("context-injection-dedup");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".config/brewva/brewva.json",
    }) as BrewvaRuntime & {
      getLedgerDigest: (sessionId: string) => string;
    };
    const sessionId = "context-injection-dedup-1";
    runtime.getLedgerDigest = () => "[Ledger Digest]\nrecords=0 pass=0 fail=0 inconclusive=0";

    runtime.onTurnStart(sessionId, 1);
    const first = runtime.buildContextInjection(
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

    runtime.onTurnStart(sessionId, 2);
    const second = runtime.buildContextInjection(
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

    const dropped = runtime.queryEvents(sessionId, {
      type: "context_injection_dropped",
      last: 1,
    })[0];
    const payload = dropped?.payload as { reason?: string } | undefined;
    expect(payload?.reason).toBe("duplicate_content");

    runtime.onTurnStart(sessionId, 3);
    const third = runtime.buildContextInjection(
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

    runtime.markContextCompacted(sessionId, {
      fromTokens: 1500,
      toTokens: 500,
    });
    runtime.onTurnStart(sessionId, 4);

    const fourth = runtime.buildContextInjection(
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

  test("truncates context injection to maxInjectionTokens", () => {
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "context-injection-truncate-1";

    for (let i = 0; i < 12; i += 1) {
      runtime.recordToolResult({
        sessionId,
        toolName: "exec",
        args: { command: `echo ${"x".repeat(240)} ${i}` },
        outputText: "ok",
        success: true,
      });
    }

    const injection = runtime.buildContextInjection(sessionId, "fix bug", {
      tokens: 1000,
      contextWindow: 2000,
      percent: 0.5,
    });
    expect(injection.accepted).toBe(true);
    expect(injection.truncated).toBe(true);
    expect(injection.finalTokens).toBeLessThanOrEqual(32);
    expect(injection.text.length).toBeGreaterThan(0);
  });

  test("disables primary and supplemental token caps when contextBudget.enabled=false", () => {
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "context-budget-disabled-1";

    for (let i = 0; i < 12; i += 1) {
      runtime.recordToolResult({
        sessionId,
        toolName: "exec",
        args: { command: `echo ${"x".repeat(240)} ${i}` },
        outputText: "ok",
        success: true,
      });
    }

    runtime.onTurnStart(sessionId, 1);
    const primary = runtime.buildContextInjection(
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

    const supplemental = runtime.planSupplementalContextInjection(
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

  test("coordinates supplemental injection budget with primary context injection per scope", () => {
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "context-supplemental-budget-1";
    const usage = {
      tokens: 800,
      contextWindow: 4000,
      percent: 0.2,
    };

    runtime.onTurnStart(sessionId, 1);
    const primary = runtime.buildContextInjection(sessionId, "fix flaky tests", usage, "leaf-a");
    const supplemental = runtime.planSupplementalContextInjection(
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

    const otherScope = runtime.planSupplementalContextInjection(
      sessionId,
      "y".repeat(120),
      usage,
      "leaf-b",
    );
    expect(otherScope.accepted).toBe(true);

    runtime.onTurnStart(sessionId, 2);
    const afterTurnReset = runtime.planSupplementalContextInjection(
      sessionId,
      "z".repeat(120),
      usage,
      "leaf-a",
    );
    expect(afterTurnReset.accepted).toBe(true);
  });

  test("reserves supplemental budget only after explicit commit", () => {
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "context-supplemental-commit-1";
    const usage = {
      tokens: 320,
      contextWindow: 4000,
      percent: 0.08,
    };

    runtime.onTurnStart(sessionId, 1);
    const first = runtime.planSupplementalContextInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(first.accepted).toBe(true);

    const second = runtime.planSupplementalContextInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(second.accepted).toBe(true);
    expect(second.finalTokens).toBe(first.finalTokens);

    runtime.commitSupplementalContextInjection(sessionId, first.finalTokens, "leaf-a");
    const exhausted = runtime.planSupplementalContextInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(exhausted.accepted).toBe(false);
    expect(exhausted.droppedReason).toBe("budget_exhausted");

    const otherScope = runtime.planSupplementalContextInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-b",
    );
    expect(otherScope.accepted).toBe(true);

    runtime.onTurnStart(sessionId, 2);
    const afterTurnReset = runtime.planSupplementalContextInjection(
      sessionId,
      "x".repeat(2000),
      usage,
      "leaf-a",
    );
    expect(afterTurnReset.accepted).toBe(true);
  });

  test("injects latest compaction summary once per compaction cycle", () => {
    const workspace = createWorkspace("context-compaction-summary");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "context-compaction-summary-1";

    runtime.markContextCompacted(sessionId, {
      fromTokens: 1600,
      toTokens: 500,
      entryId: "cmp-1",
      summary: "Keep failing tests, active objective, and latest diff only.",
    });

    const first = runtime.buildContextInjection(sessionId, "fix flaky tests", {
      tokens: 800,
      contextWindow: 4000,
      percent: 0.2,
    });
    expect(first.accepted).toBe(true);
    expect(first.text.includes("[CompactionSummary]")).toBe(true);
    expect(first.text.includes("active objective")).toBe(true);

    const second = runtime.buildContextInjection(sessionId, "continue fixing tests", {
      tokens: 820,
      contextWindow: 4000,
      percent: 0.21,
    });
    expect(second.accepted).toBe(true);
    expect(second.text.includes("[CompactionSummary]")).toBe(false);

    runtime.markContextCompacted(sessionId, {
      fromTokens: 1700,
      toTokens: 480,
      entryId: "cmp-2",
      summary: "Preserve unresolved assertion mismatch and the last failing command output.",
    });

    const third = runtime.buildContextInjection(sessionId, "resume bugfix", {
      tokens: 790,
      contextWindow: 4000,
      percent: 0.19,
    });
    expect(third.accepted).toBe(true);
    expect(third.text.includes("[CompactionSummary]")).toBe(true);
    expect(third.text.includes("unresolved assertion mismatch")).toBe(true);
  });

  test("clears stale compaction summary when next compaction has no summary", () => {
    const workspace = createWorkspace("context-compaction-summary-clear");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "context-compaction-summary-clear-1";

    runtime.markContextCompacted(sessionId, {
      fromTokens: 1400,
      toTokens: 460,
      entryId: "cmp-a",
      summary: "Keep active objective and last failing command output.",
    });

    const first = runtime.buildContextInjection(sessionId, "continue", {
      tokens: 700,
      contextWindow: 4000,
      percent: 0.18,
    });
    expect(first.accepted).toBe(true);
    expect(first.text.includes("[CompactionSummary]")).toBe(true);

    runtime.markContextCompacted(sessionId, {
      fromTokens: 1500,
      toTokens: 500,
      entryId: "cmp-b",
    });

    const second = runtime.buildContextInjection(sessionId, "continue", {
      tokens: 710,
      contextWindow: 4000,
      percent: 0.19,
    });
    expect(second.accepted).toBe(true);
    expect(second.text.includes("[CompactionSummary]")).toBe(false);
    expect(second.text.includes("last failing command output")).toBe(false);
  });

  test("keeps pending critical context when injection is dropped by hard limit", () => {
    const workspace = createWorkspace("context-hard-limit-retain");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "context-hard-limit-retain-1";

    runtime.markContextCompacted(sessionId, {
      fromTokens: 1800,
      toTokens: 520,
      entryId: "cmp-retain-1",
      summary: "Keep unresolved failures and active objective only.",
    });

    const dropped = runtime.buildContextInjection(sessionId, "resume task", {
      tokens: 195_000,
      contextWindow: 200_000,
      percent: 0.975,
    });
    expect(dropped.accepted).toBe(false);
    runtime.onTurnStart(sessionId, 1);

    const recovered = runtime.buildContextInjection(sessionId, "resume task", {
      tokens: 600,
      contextWindow: 200_000,
      percent: 0.3,
    });
    expect(recovered.accepted).toBe(true);
    expect(recovered.text.includes("[CompactionSummary]")).toBe(true);
    expect(recovered.text.includes("active objective")).toBe(true);
  });

  test("respects minTurnsBetweenCompaction when usage stays high", () => {
    const workspace = createWorkspace("context-compaction-interval");
    const config = createConfig({});
    config.infrastructure = {
      ...config.infrastructure,
      contextBudget: {
        ...config.infrastructure.contextBudget,
        minSecondsBetweenCompaction: 0,
      },
    };
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "context-compaction-interval-1";

    runtime.onTurnStart(sessionId, 1);
    expect(
      runtime.shouldRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(true);
    runtime.markContextCompacted(sessionId, { fromTokens: 820, toTokens: 120 });

    runtime.onTurnStart(sessionId, 2);
    expect(
      runtime.shouldRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(false);

    runtime.onTurnStart(sessionId, 3);
    expect(
      runtime.shouldRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(true);
  });

  test("keeps ledger turn aligned with turn_start instead of tool-result sequence", () => {
    const workspace = createWorkspace("turn-alignment");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "turn-alignment-1";

    runtime.onTurnStart(sessionId, 7);
    runtime.recordToolResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo one" },
      outputText: "one",
      success: true,
    });
    runtime.recordToolResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo two" },
      outputText: "two",
      success: true,
    });
    runtime.recordAssistantUsage({
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

  test("writes context_compacted evidence into ledger", () => {
    const workspace = createWorkspace("context-compaction-ledger");
    writeConfig(workspace, createConfig({}));
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "context-compaction-ledger-1";

    runtime.onTurnStart(sessionId, 3);
    runtime.markContextCompacted(sessionId, {
      fromTokens: 8000,
      toTokens: 1200,
    });

    const rows = runtime.ledger.list(sessionId);
    expect(rows.some((row) => row.tool === "brewva_context_compaction")).toBe(true);
  });
});

describe("Gap remediation: interrupt recovery snapshot", () => {});

describe("Gap remediation: rollback safety net", () => {
  test("tracks file mutations and restores the latest patch set", () => {
    const workspace = createWorkspace("rollback");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-1";
    const filePath = join(workspace, "src/main.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    runtime.onTurnStart(sessionId, 1);
    runtime.markToolCall(sessionId, "edit");
    runtime.recordToolResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      success: true,
    });

    runtime.trackToolCallStart({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      args: { file_path: "src/main.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.trackToolCallEnd({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      success: true,
    });

    const rollback = runtime.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    const verification = runtime.verification.stateStore.get(sessionId);
    expect(verification.evidence.length).toBe(0);
    expect(Object.keys(verification.checkRuns)).toHaveLength(0);
  });

  test("rolls back added files by deleting them", () => {
    const workspace = createWorkspace("rollback-add");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-add-1";
    const createdPath = join(workspace, "src/new-file.ts");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    runtime.onTurnStart(sessionId, 1);

    runtime.trackToolCallStart({
      sessionId,
      toolCallId: "tool-add",
      toolName: "write",
      args: { file_path: "src/new-file.ts" },
    });
    writeFileSync(createdPath, "export const created = true;\n", "utf8");
    runtime.trackToolCallEnd({
      sessionId,
      toolCallId: "tool-add",
      toolName: "write",
      success: true,
    });

    const rollback = runtime.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(existsSync(createdPath)).toBe(false);
  });

  test("returns restore_failed when rollback snapshot is missing", () => {
    const workspace = createWorkspace("rollback-restore-failed");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-restore-failed-1";
    const filePath = join(workspace, "src/main.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    runtime.onTurnStart(sessionId, 1);

    runtime.trackToolCallStart({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      args: { file_path: "src/main.ts" },
    });
    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.trackToolCallEnd({
      sessionId,
      toolCallId: "tool-1",
      toolName: "edit",
      success: true,
    });

    const snapshotDir = join(workspace, ".orchestrator/snapshots", sessionId);
    for (const entry of readdirSync(snapshotDir)) {
      if (!entry.endsWith(".snap")) continue;
      rmSync(join(snapshotDir, entry), { force: true });
    }

    const rollback = runtime.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(false);
    expect(rollback.reason).toBe("restore_failed");
    expect(rollback.failedPaths).toContain("src/main.ts");
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 2;\n");
    expect(runtime.fileChanges.hasHistory(sessionId)).toBe(true);
  });

  test("does not track file paths outside workspace during snapshot capture", () => {
    const workspace = createWorkspace("rollback-path-traversal");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "rollback-path-traversal-1";

    const outside = runtime.fileChanges.captureBeforeToolCall({
      sessionId,
      toolCallId: "tc-outside",
      toolName: "edit",
      args: { file_path: "../outside.ts" },
    });
    expect(outside.trackedFiles).toEqual([]);

    const absoluteOutside = runtime.fileChanges.captureBeforeToolCall({
      sessionId,
      toolCallId: "tc-abs",
      toolName: "edit",
      args: { file_path: "/etc/passwd" },
    });
    expect(absoluteOutside.trackedFiles).toEqual([]);

    mkdirSync(join(workspace, "src"), { recursive: true });
    const inside = runtime.fileChanges.captureBeforeToolCall({
      sessionId,
      toolCallId: "tc-inside",
      toolName: "edit",
      args: { file_path: "src/inside.ts" },
    });
    expect(inside.trackedFiles).toEqual(["src/inside.ts"]);
  });

  test("supports cross-process undo via persisted patchset history", () => {
    const workspace = createWorkspace("rollback-persisted");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const sessionId = "rollback-persisted-1";
    const filePath = join(workspace, "src/persisted.ts");
    writeFileSync(filePath, "export const persisted = 1;\n", "utf8");

    const runtimeA = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".config/brewva/brewva.json",
    });
    runtimeA.onTurnStart(sessionId, 1);
    runtimeA.trackToolCallStart({
      sessionId,
      toolCallId: "persist-1",
      toolName: "edit",
      args: { file_path: "src/persisted.ts" },
    });
    writeFileSync(filePath, "export const persisted = 2;\n", "utf8");
    runtimeA.trackToolCallEnd({
      sessionId,
      toolCallId: "persist-1",
      toolName: "edit",
      success: true,
    });

    const runtimeB = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".config/brewva/brewva.json",
    });
    const resolved = runtimeB.resolveUndoSessionId();
    expect(resolved).toBe(sessionId);

    const rollback = runtimeB.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("export const persisted = 1;\n");
  });
});

describe("Gap remediation: structured replay events", () => {
  test("converts recorded events into structured replay stream", () => {
    const workspace = createWorkspace("replay");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "replay-1";
    runtime.recordEvent({ sessionId, type: "session_start", payload: { cwd: workspace } });
    runtime.recordEvent({ sessionId, type: "tool_call", turn: 1, payload: { toolName: "read" } });

    const structured = runtime.queryStructuredEvents(sessionId);
    expect(structured.length).toBe(2);
    expect(structured[0]?.schema).toBe("brewva.event.v1");
    expect(structured[0]?.category).toBe("session");
    expect(structured[1]?.category).toBe("tool");

    const sessions = runtime.listReplaySessions();
    expect(sessions.some((entry) => entry.sessionId === sessionId)).toBe(true);
  });
});

describe("Gap remediation: live event subscription", () => {
  test("streams structured events and stops after unsubscribe", () => {
    const workspace = createWorkspace("event-subscribe");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "event-subscribe-1";

    const received: any[] = [];
    const unsubscribe = runtime.subscribeEvents((event) => {
      received.push(event);
    });

    runtime.onTurnStart(sessionId, 1);
    runtime.recordEvent({ sessionId, type: "session_start", payload: { cwd: workspace } });
    runtime.recordToolResult({
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
    runtime.recordEvent({ sessionId, type: "turn_end", turn: 1 });
    expect(received).toHaveLength(before);
  });
});

describe("Gap remediation: cost view and budget linkage", () => {
  test("allocates cost usage across tools based on call counts in the same turn", () => {
    const workspace = createWorkspace("cost-allocation");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "cost-allocation-1";
    runtime.onTurnStart(sessionId, 1);

    runtime.markToolCall(sessionId, "read");
    runtime.markToolCall(sessionId, "read");
    runtime.markToolCall(sessionId, "grep");

    runtime.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 300,
      costUsd: 0.03,
    });

    const summary = runtime.getCostSummary(sessionId);
    expect(summary.tools.read?.callCount).toBe(2);
    expect(summary.tools.grep?.callCount).toBe(1);
    expect(summary.tools.read?.allocatedTokens).toBeCloseTo(200, 3);
    expect(summary.tools.grep?.allocatedTokens).toBeCloseTo(100, 3);
    expect(summary.tools.read?.allocatedCostUsd).toBeCloseTo(0.02, 6);
    expect(summary.tools.grep?.allocatedCostUsd).toBeCloseTo(0.01, 6);
  });

  test("tracks skill/tool breakdown and blocks tools when budget action is block_tools", () => {
    const workspace = createWorkspace("cost");
    const config = createConfig({});
    config.infrastructure = {
      ...config.infrastructure,
      costTracking: {
        ...config.infrastructure.costTracking,
        maxCostUsdPerSession: 0.01,
        maxCostUsdPerSkill: 0.005,
        alertThresholdRatio: 0.5,
        actionOnExceed: "block_tools",
      },
    };
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "cost-1";
    runtime.onTurnStart(sessionId, 1);
    runtime.markToolCall(sessionId, "edit");
    runtime.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.02,
    });

    const summary = runtime.getCostSummary(sessionId);
    expect(summary.totalCostUsd).toBeGreaterThan(0.01);
    expect(summary.budget.blocked).toBe(true);
    expect(summary.budget.skillExceeded).toBe(true);
    expect(summary.skills["(none)"]).toBeDefined();
    expect(summary.tools.edit?.callCount).toBe(1);

    const access = runtime.checkToolAccess(sessionId, "read");
    expect(access.allowed).toBe(false);
    expect(runtime.checkToolAccess(sessionId, "skill_complete").allowed).toBe(true);
    expect(runtime.checkToolAccess(sessionId, "session_compact").allowed).toBe(true);
  });

  test("enforces global skill budget status consistently with tool access checks", () => {
    const workspace = createWorkspace("cost-budget-consistency");
    const config = createConfig({});
    config.infrastructure = {
      ...config.infrastructure,
      costTracking: {
        ...config.infrastructure.costTracking,
        maxCostUsdPerSession: 1,
        maxCostUsdPerSkill: 0.001,
        alertThresholdRatio: 0.5,
        actionOnExceed: "block_tools",
      },
    };
    writeConfig(workspace, config);
    mkdirSync(join(workspace, "skills/base/patching"), { recursive: true });
    writeFileSync(
      join(workspace, "skills/base/patching/SKILL.md"),
      `---
name: patching
description: test patching skill
tier: base
tags: [patching]
tools:
  required: [read]
  optional: [edit]
  denied: [write]
budget:
  max_tool_calls: 20
  max_tokens: 20000
---
patching`,
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "cost-budget-consistency-1";
    runtime.onTurnStart(sessionId, 1);
    runtime.markToolCall(sessionId, "read");
    runtime.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 40,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 60,
      costUsd: 0.002,
    });
    expect(runtime.activateSkill(sessionId, "patching").ok).toBe(true);

    const summary = runtime.getCostSummary(sessionId);
    expect(summary.budget.skillExceeded).toBe(true);
    expect(summary.budget.blocked).toBe(true);

    const access = runtime.checkToolAccess(sessionId, "read");
    expect(access.allowed).toBe(false);
    expect(runtime.checkToolAccess(sessionId, "skill_complete").allowed).toBe(true);
    expect(runtime.checkToolAccess(sessionId, "session_compact").allowed).toBe(true);
  });
});

describe("Gap remediation: runtime core compaction gate", () => {
  test("blocks non-session_compact tools at critical pressure and unblocks after compaction", () => {
    const workspace = createWorkspace("core-compaction-gate");
    const config = createConfig({});
    config.infrastructure = {
      ...config.infrastructure,
      contextBudget: {
        ...config.infrastructure.contextBudget,
        enabled: true,
        compactionThresholdPercent: 0.8,
        hardLimitPercent: 0.9,
        minTurnsBetweenCompaction: 2,
      },
    };
    writeConfig(workspace, config);

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".config/brewva/brewva.json" });
    const sessionId = "core-compaction-gate-1";
    runtime.onTurnStart(sessionId, 3);

    const usage = {
      tokens: 95,
      contextWindow: 100,
      percent: 0.95,
    };
    runtime.observeContextUsage(sessionId, usage);

    const blocked = runtime.startToolCall({
      sessionId,
      toolCallId: "tc-blocked",
      toolName: "exec",
      args: { command: "echo blocked" },
      usage,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("session_compact")).toBe(true);
    expect(
      runtime.queryEvents(sessionId, { type: "context_compaction_gate_blocked_tool" }),
    ).toHaveLength(1);

    const compactAllowed = runtime.startToolCall({
      sessionId,
      toolCallId: "tc-compact",
      toolName: "session_compact",
      args: { reason: "critical" },
      usage,
    });
    expect(compactAllowed.allowed).toBe(true);

    runtime.markContextCompacted(sessionId, {
      fromTokens: usage.tokens,
      toTokens: 40,
    });

    const unblocked = runtime.startToolCall({
      sessionId,
      toolCallId: "tc-after-compact",
      toolName: "exec",
      args: { command: "echo ok" },
      usage,
    });
    expect(unblocked.allowed).toBe(true);
  });
});
