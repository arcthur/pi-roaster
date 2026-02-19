import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function extractLongFlags(cliSource: string): string[] {
  const matches = cliSource.match(/--[a-z][a-z-]*/g) ?? [];
  return [...new Set(matches)].sort();
}

describe("docs/reference commands coverage", () => {
  it("documents all long-form CLI flags", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const cliPath = resolve(repoRoot, "packages/brewva-cli/src/index.ts");
    const docsPath = resolve(repoRoot, "docs/reference/commands.md");

    const cliSource = readFileSync(cliPath, "utf-8");
    const docs = readFileSync(docsPath, "utf-8");

    const flags = extractLongFlags(cliSource);
    const missing = flags.filter((flag) => !docs.includes(`\`${flag}\``));

    expect(
      missing,
      `Missing CLI flags in docs/reference/commands.md: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
