import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager } from "@brewva/brewva-cli";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-channel-runtime-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("channel runtime manager", () => {
  test("forces per-agent state namespace and disables scheduler", async () => {
    const workspace = createWorkspace("namespace");
    const controller = new BrewvaRuntime({ cwd: workspace });
    const manager = new AgentRuntimeManager({
      controllerRuntime: controller,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 60_000,
    });

    const runtime = await manager.getOrCreateRuntime("jack");
    expect(runtime.config.ledger.path).toBe(".brewva/agents/jack/state/ledger/evidence.jsonl");
    expect(runtime.config.memory.dir).toBe(".brewva/agents/jack/state/memory");
    expect(runtime.config.infrastructure.events.dir).toBe(".brewva/agents/jack/state/events");
    expect(runtime.config.infrastructure.turnWal.dir).toBe(".brewva/agents/jack/state/turn-wal");
    expect(runtime.config.schedule.projectionPath).toBe(
      ".brewva/agents/jack/state/schedule/intents.jsonl",
    );
    expect(runtime.config.schedule.enabled).toBe(false);
  });

  test("evicts least recently used idle runtime when pool is full", async () => {
    const workspace = createWorkspace("lru");
    const controller = new BrewvaRuntime({ cwd: workspace });
    const manager = new AgentRuntimeManager({
      controllerRuntime: controller,
      maxLiveRuntimes: 1,
      idleRuntimeTtlMs: 60_000,
    });

    await manager.getOrCreateRuntime("jack");
    await manager.getOrCreateRuntime("mike");

    expect(manager.listRuntimes().map((entry) => entry.agentId)).toEqual(["mike"]);
  });

  test("evicts idle runtimes by ttl", async () => {
    const workspace = createWorkspace("idle");
    const controller = new BrewvaRuntime({ cwd: workspace });
    const manager = new AgentRuntimeManager({
      controllerRuntime: controller,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 10,
    });

    await manager.getOrCreateRuntime("jack");
    const before = manager.listRuntimes().length;
    const evicted = manager.evictIdleRuntimes(Date.now() + 100);

    expect(before).toBe(1);
    expect(evicted).toEqual(["jack"]);
    expect(manager.listRuntimes()).toEqual([]);
  });

  test("throws when agent config overlay JSON is invalid", async () => {
    const workspace = createWorkspace("invalid-config");
    const controller = new BrewvaRuntime({ cwd: workspace });
    const manager = new AgentRuntimeManager({
      controllerRuntime: controller,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 60_000,
    });

    const agentRoot = join(workspace, ".brewva", "agents", "jack");
    mkdirSync(agentRoot, { recursive: true });
    writeFileSync(join(agentRoot, "config.json"), "{ invalid", "utf8");

    try {
      await manager.getOrCreateRuntime("jack");
      expect.unreachable("expected invalid agent config to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("invalid_agent_config:jack:");
    }
  });
});
