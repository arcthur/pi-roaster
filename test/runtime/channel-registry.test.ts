import { describe, expect, test } from "bun:test";
import {
  ChannelAdapterRegistry,
  DEFAULT_CHANNEL_CAPABILITIES,
  type ChannelAdapter,
} from "@brewva/brewva-runtime/channels";

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
  test("given adapter registration with aliases, when resolving ids, then builtin alias normalization is applied", () => {
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

  test("given conflicting adapter ids or aliases, when registering adapter, then registry rejects duplicates", () => {
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

  test("given adapter factory output id mismatch, when creating adapter, then registry throws mismatch error", () => {
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

  test("given adapter with aliases, when unregistering by alias, then alias and primary id are removed", () => {
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
