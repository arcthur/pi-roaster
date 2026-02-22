import { describe, expect, test } from "bun:test";
import type { ChannelAdapter } from "../../packages/brewva-runtime/src/channels/adapter.js";
import { DEFAULT_CHANNEL_CAPABILITIES } from "../../packages/brewva-runtime/src/channels/capabilities.js";
import { ChannelAdapterRegistry } from "../../packages/brewva-runtime/src/channels/registry.js";

function createAdapter(id: string): ChannelAdapter {
  return {
    id,
    capabilities: () => DEFAULT_CHANNEL_CAPABILITIES,
    start: async () => undefined,
    stop: async () => undefined,
    sendTurn: async () => ({ providerMessageId: "m1" }),
  };
}

describe("channel adapter registry", () => {
  test("registers adapters with aliases and resolves builtin alias normalization", () => {
    const registry = new ChannelAdapterRegistry();
    registry.register({
      id: "telegram",
      aliases: ["tg"],
      create: () => createAdapter("telegram"),
    });

    expect(registry.resolveId("telegram")).toBe("telegram");
    expect(registry.resolveId("tg")).toBe("telegram");
    expect(registry.resolveId("TG")).toBe("telegram");
    expect(registry.list()).toEqual([{ id: "telegram", aliases: [] }]);
  });

  test("rejects duplicate adapter ids and alias conflicts", () => {
    const registry = new ChannelAdapterRegistry();
    registry.register({
      id: "telegram",
      create: () => createAdapter("telegram"),
    });
    expect(() =>
      registry.register({
        id: "telegram",
        create: () => createAdapter("telegram"),
      }),
    ).toThrow("adapter already registered: telegram");

    registry.register({
      id: "discord",
      aliases: ["dc"],
      create: () => createAdapter("discord"),
    });
    expect(() =>
      registry.register({
        id: "dummy",
        aliases: ["dc"],
        create: () => createAdapter("dummy"),
      }),
    ).toThrow("adapter alias already registered: dc -> discord");
  });

  test("creates adapter and validates id consistency", () => {
    const registry = new ChannelAdapterRegistry();
    registry.register({
      id: "telegram",
      create: () => createAdapter("telegram"),
    });
    expect(registry.createAdapter("telegram")?.id).toBe("telegram");

    registry.register({
      id: "slack",
      create: () => createAdapter("discord"),
    });
    expect(() => registry.createAdapter("slack")).toThrow(
      "adapter id mismatch: expected slack, got discord",
    );
  });

  test("unregister removes aliases and primary id", () => {
    const registry = new ChannelAdapterRegistry();
    registry.register({
      id: "telegram",
      aliases: ["telegram-bot"],
      create: () => createAdapter("telegram"),
    });
    expect(registry.unregister("telegram-bot")).toBe(true);
    expect(registry.resolveId("telegram")).toBeUndefined();
    expect(registry.resolveId("telegram-bot")).toBeUndefined();
  });
});
