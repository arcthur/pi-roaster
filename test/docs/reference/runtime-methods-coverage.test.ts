import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function collectPublicRuntimeMethods(source: string): string[] {
  const lines = source.split("\n");
  const methods: string[] = [];

  for (const line of lines) {
    if (!line.startsWith("  ")) continue;
    if (line.startsWith("  private ")) continue;
    if (line.startsWith("  constructor(")) continue;

    const match = /^  ([a-zA-Z][a-zA-Z0-9_]*)\(/.exec(line);
    if (!match) continue;

    const method = match[1];
    if (!method) continue;
    methods.push(method);
  }

  return [...new Set(methods)].sort();
}

describe("docs/reference runtime coverage", () => {
  it("documents public runtime methods", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const runtimeSource = readFileSync(resolve(repoRoot, "packages/brewva-runtime/src/runtime.ts"), "utf-8");
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/runtime.md"), "utf-8");

    const methods = collectPublicRuntimeMethods(runtimeSource);
    const missing = methods.filter((name) => !markdown.includes(`\`${name}\``));

    expect(missing, `Missing runtime methods in docs/reference/runtime.md: ${missing.join(", ")}`).toEqual([]);
  });
});
