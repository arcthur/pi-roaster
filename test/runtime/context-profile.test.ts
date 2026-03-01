import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

const EXPECTED_IGNORED_KEYS = [
  "infrastructure.contextBudget.arena.zones",
  "infrastructure.contextBudget.adaptiveZones",
  "infrastructure.contextBudget.stabilityMonitor",
  "infrastructure.contextBudget.floorUnmetPolicy",
  "infrastructure.toolFailureInjection.sourceTokenLimitsDerived",
] as const;

function createWorkspace(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(workspace, "AGENTS.md"),
    ["## CRITICAL RULES", "- User-facing command name is `brewva`."].join("\n"),
    "utf8",
  );
  return workspace;
}

function createConfig(
  profile: BrewvaConfig["infrastructure"]["contextBudget"]["profile"],
): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.contextBudget.enabled = true;
  config.infrastructure.contextBudget.profile = profile;
  config.infrastructure.contextBudget.maxInjectionTokens = 100;
  config.infrastructure.contextBudget.truncationStrategy = "tail";
  config.infrastructure.contextBudget.floorUnmetPolicy.enabled = false;
  config.infrastructure.contextBudget.arena.zones.truth = { min: 500, max: 1000 };
  config.infrastructure.contextBudget.arena.zones.taskState = { min: 500, max: 1000 };
  config.infrastructure.toolFailureInjection.enabled = false;
  config.memory.enabled = false;
  return config;
}

function seedDemand(runtime: BrewvaRuntime, sessionId: string): void {
  runtime.task.setSpec(sessionId, {
    schema: "brewva.task.v1",
    goal: "profile behavior check " + "x".repeat(4_000),
  });
  runtime.truth.upsertFact(sessionId, {
    id: `truth:${sessionId}`,
    kind: "diagnostic",
    severity: "warn",
    summary: "profile behavior fact " + "y".repeat(4_000),
  });
}

describe("context profile", () => {
  test("simple profile bypasses managed mechanisms and emits ignored-option events once per session", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("brewva-context-profile-simple-"),
      config: createConfig("simple"),
    });
    const sessionId = "context-profile-simple";

    runtime.context.onTurnStart(sessionId, 1);
    seedDemand(runtime, sessionId);
    const first = await runtime.context.buildInjection(sessionId, "first turn");
    expect(first.accepted).toBe(true);

    runtime.context.onTurnStart(sessionId, 2);
    const second = await runtime.context.buildInjection(sessionId, "second turn");
    expect(second.accepted).toBe(true);

    const selected = runtime.events.query(sessionId, { type: "context_profile_selected" });
    expect(selected).toHaveLength(1);
    const selectedPayload = selected[0]?.payload as { profile?: string } | undefined;
    expect(selectedPayload?.profile).toBe("simple");

    const ignored = runtime.events.query(sessionId, { type: "context_profile_option_ignored" });
    expect(ignored).toHaveLength(EXPECTED_IGNORED_KEYS.length);
    const ignoredKeys = new Set(
      ignored
        .map((event) => (event.payload as { optionKey?: string } | undefined)?.optionKey)
        .filter((key): key is string => typeof key === "string"),
    );
    for (const key of EXPECTED_IGNORED_KEYS) {
      expect(ignoredKeys.has(key)).toBe(true);
    }

    const floorUnmet = runtime.events.query(sessionId, {
      type: "context_arena_floor_unmet_unrecoverable",
      last: 1,
    })[0];
    expect(floorUnmet).toBeUndefined();
  });

  test("managed profile keeps floor_unmet behavior and does not emit ignored-option events", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("brewva-context-profile-managed-"),
      config: createConfig("managed"),
    });
    const sessionId = "context-profile-managed";

    runtime.context.onTurnStart(sessionId, 1);
    seedDemand(runtime, sessionId);
    const result = await runtime.context.buildInjection(sessionId, "managed turn");
    expect(result.accepted).toBe(false);

    const selected = runtime.events.query(sessionId, { type: "context_profile_selected" });
    expect(selected).toHaveLength(1);
    const selectedPayload = selected[0]?.payload as { profile?: string } | undefined;
    expect(selectedPayload?.profile).toBe("managed");

    const ignored = runtime.events.query(sessionId, { type: "context_profile_option_ignored" });
    expect(ignored).toHaveLength(0);

    const floorUnmet = runtime.events.query(sessionId, {
      type: "context_arena_floor_unmet_unrecoverable",
      last: 1,
    })[0];
    expect(floorUnmet).toBeDefined();
  });
});
