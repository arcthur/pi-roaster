import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@brewva/brewva-cli";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-channel-registry-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("channel agent registry", () => {
  test("supports create list focus and soft delete", async () => {
    const workspace = createWorkspace("crud");
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });

    const created = await registry.createAgent({ requestedAgentId: "Jack" });
    expect(created.agentId).toBe("jack");
    expect(registry.isActive("jack")).toBe(true);

    await registry.setFocus("telegram:123", "jack");
    expect(registry.resolveFocus("telegram:123")).toBe("jack");

    await registry.softDeleteAgent("jack");
    expect(registry.isActive("jack")).toBe(false);
    expect(registry.resolveFocus("telegram:123")).toBe("default");
  });

  test("rejects reserved agent names", async () => {
    const workspace = createWorkspace("reserved");
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });

    try {
      await registry.createAgent({ requestedAgentId: "system" });
      expect.unreachable("expected reserved name rejection");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toContain(
        "reserved_agent_id:system",
      );
    }
  });

  test("serializes concurrent create operations", async () => {
    const workspace = createWorkspace("concurrency");
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });

    await Promise.all([
      registry.createAgent({ requestedAgentId: "jack" }),
      registry.createAgent({ requestedAgentId: "mike" }),
      registry.createAgent({ requestedAgentId: "rose" }),
    ]);

    const ids = registry
      .list()
      .map((entry) => entry.agentId)
      .toSorted();
    expect(ids).toEqual(["default", "jack", "mike", "rose"]);
  });
});
