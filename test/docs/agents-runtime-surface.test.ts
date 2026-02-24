import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function extractRuntimeDomains(runtimeSource: string): string[] {
  const domains: string[] = [];
  const regex = /^\s*readonly\s+([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*\{/gmu;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(runtimeSource)) !== null) {
    const name = match[1];
    if (!name) continue;
    domains.push(name);
  }

  return [...new Set(domains)].toSorted();
}

describe("AGENTS runtime surface coverage", () => {
  it("documents runtime domain API groups", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const runtimeSource = readFileSync(
      resolve(repoRoot, "packages/brewva-runtime/src/runtime.ts"),
      "utf-8",
    );
    const agentsDoc = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf-8");

    const domains = extractRuntimeDomains(runtimeSource);
    const missing = domains.filter((name) => !agentsDoc.includes(`\`runtime.${name}.*\``));

    expect(missing, `Missing runtime domains in AGENTS.md: ${missing.join(", ")}`).toEqual([]);
  });
});
