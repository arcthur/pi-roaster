import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function writeIdentity(workspace: string, agentId: string, content: string): void {
  const path = join(workspace, ".brewva", "agents", agentId, "identity.md");
  mkdirSync(join(workspace, ".brewva", "agents", agentId), { recursive: true });
  writeFileSync(path, `${content.trim()}\n`, "utf8");
}

function writeAgentsRules(workspace: string): void {
  writeFileSync(
    join(workspace, "AGENTS.md"),
    [
      "## CRITICAL RULES",
      "- User-facing command name is `brewva`.",
      "- Use workspace package imports `@brewva/brewva-runtime`.",
      "- Use Bun `1.3.9`.",
      "- Run bun run test:dist.",
    ].join("\n"),
    "utf8",
  );
}

describe("Context injection orchestrator characterization", () => {
  test("registers semantic sources and emits context_injected event", async () => {
    const workspace = createWorkspace("ctx-orchestrator-sources");
    writeIdentity(workspace, "default", "role: orchestrator characterization");
    writeAgentsRules(workspace);

    const runtime = new BrewvaRuntime({ cwd: workspace, agentId: "default" });
    const sessionId = "ctx-orchestrator-sources-1";
    runtime.context.onTurnStart(sessionId, 1);

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Characterize context orchestration",
      constraints: ["Keep deterministic markers"],
    });
    runtime.task.recordBlocker(sessionId, {
      message: "failing test blocks progress",
      source: "test",
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth:ctx-char",
      kind: "diagnostic",
      severity: "warn",
      summary: "test truth fact",
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: test failure marker",
      success: false,
    });

    const injection = await runtime.context.buildInjection(
      sessionId,
      "continue context characterization",
      { tokens: 800, contextWindow: 4000, percent: 0.2 },
      "leaf-a",
    );
    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("[Identity]")).toBe(true);
    expect(injection.text.includes("[TruthLedger]")).toBe(true);
    expect(injection.text.includes("[TruthFacts]")).toBe(true);
    expect(injection.text.includes("[TaskLedger]")).toBe(true);
    expect(injection.text.includes("[RecentToolFailures]")).toBe(true);
    expect(injection.text.includes("[WorkingMemory]")).toBe(true);
    expect(injection.text.includes("\n\n")).toBe(true);

    const injectedEvent = runtime.events.query(sessionId, { type: "context_injected", last: 1 })[0];
    expect(injectedEvent).toBeDefined();
    const payload = injectedEvent?.payload as
      | {
          sourceCount?: number;
          finalTokens?: number;
          originalTokens?: number;
          strategyArm?: string;
          stabilityForced?: boolean;
        }
      | undefined;
    expect(typeof payload?.sourceCount).toBe("number");
    expect((payload?.sourceCount ?? 0) >= 5).toBe(true);
    expect((payload?.finalTokens ?? 0) > 0).toBe(true);
    expect((payload?.originalTokens ?? 0) >= (payload?.finalTokens ?? 0)).toBe(true);
    expect(payload?.strategyArm).toBe("managed");
    expect(payload?.stabilityForced).toBe(false);
  });

  test("drops duplicate fingerprint in same scope and emits context_injection_dropped", async () => {
    const workspace = createWorkspace("ctx-orchestrator-duplicate");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.enabled = false;
    config.infrastructure.toolFailureInjection.enabled = false;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "ctx-orchestrator-duplicate-1";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Keep scope fingerprint stable",
    });

    runtime.context.onTurnStart(sessionId, 1);
    const first = await runtime.context.buildInjection(
      sessionId,
      "duplicate fingerprint probe",
      { tokens: 600, contextWindow: 4000, percent: 0.15 },
      "leaf-a",
    );
    expect(first.accepted).toBe(true);
    expect(first.text.length).toBeGreaterThan(0);

    runtime.context.onTurnStart(sessionId, 2);
    const second = await runtime.context.buildInjection(
      sessionId,
      "duplicate fingerprint probe",
      { tokens: 600, contextWindow: 4000, percent: 0.15 },
      "leaf-a",
    );
    expect(second.accepted).toBe(false);
    expect(second.text).toBe("");

    const dropped = runtime.events.query(sessionId, {
      type: "context_injection_dropped",
      last: 1,
    })[0];
    expect(dropped).toBeDefined();
    const payload = dropped?.payload as { reason?: string; originalTokens?: number } | undefined;
    expect(payload?.reason).toBe("duplicate_content");
    expect((payload?.originalTokens ?? 0) > 0).toBe(true);
  });
});
