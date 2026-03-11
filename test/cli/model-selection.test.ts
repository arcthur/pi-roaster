import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBrewvaModelSelection } from "@brewva/brewva-tools";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

function createRegistry(): ModelRegistry {
  const tempDir = mkdtempSync(join(tmpdir(), "brewva-model-selection-"));
  const registry = new ModelRegistry(
    AuthStorage.create(join(tempDir, "auth.json")),
    join(tempDir, "models.json"),
  );

  registry.registerProvider("demo", {
    baseUrl: "https://demo.example.com/v1",
    apiKey: "DEMO_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "alpha",
        name: "Alpha",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "alpha-20260101",
        name: "Alpha Snapshot",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "alpha:exacto",
        name: "Alpha Exacto",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "beta-mini",
        name: "Beta Mini",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "alpha-mini",
        name: "Alpha Mini",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });

  registry.registerProvider("proxy", {
    baseUrl: "https://proxy.example.com/v1",
    apiKey: "PROXY_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "demo/alt",
        name: "Proxy Alt",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });

  return registry;
}

describe("resolveBrewvaModelSelection", () => {
  test("supports thinking shorthand for provider-scoped model ids with colons", () => {
    const resolved = resolveBrewvaModelSelection("demo/alpha:exacto:high", createRegistry());

    expect(resolved.model?.provider).toBe("demo");
    expect(resolved.model?.id).toBe("alpha:exacto");
    expect(resolved.thinkingLevel).toBe("high");
  });

  test("supports fuzzy matching and prefers alias models over dated variants", () => {
    const resolved = resolveBrewvaModelSelection("Alpha", createRegistry());

    expect(resolved.model?.provider).toBe("demo");
    expect(resolved.model?.id).toBe("alpha");
    expect(resolved.thinkingLevel).toBeUndefined();
  });

  test("falls back to full model ids when provider inference would be wrong", () => {
    const resolved = resolveBrewvaModelSelection("demo/alt:high", createRegistry());

    expect(resolved.model?.provider).toBe("proxy");
    expect(resolved.model?.id).toBe("demo/alt");
    expect(resolved.thinkingLevel).toBe("high");
  });

  test("throws for unknown or invalid model overrides", () => {
    expect(() => resolveBrewvaModelSelection("demo/missing", createRegistry())).toThrow(
      'Model "demo/missing" was not found in the configured Brewva model registry.',
    );
    expect(() => resolveBrewvaModelSelection("demo/alpha:nope", createRegistry())).toThrow(
      'Model "demo/alpha:nope" was not found in the configured Brewva model registry.',
    );
  });

  test("throws for ambiguous fuzzy matches instead of silently picking one", () => {
    expect(() => resolveBrewvaModelSelection("mini", createRegistry())).toThrow(
      'Model "mini" is ambiguous.',
    );
  });
});
