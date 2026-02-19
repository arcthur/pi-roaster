import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function collectToolNames(sourceRoot: string): string[] {
  const files = [
    "ast-grep.ts",
    "cost-view.ts",
    "exec.ts",
    "ledger-query.ts",
    "look-at.ts",
    "lsp.ts",
    "process.ts",
    "rollback-last-patch.ts",
    "session-compact.ts",
    "skill-load.ts",
    "skill-complete.ts",
    "tape.ts",
    "task-ledger.ts",
  ];

  const names = new Set<string>();
  for (const file of files) {
    const text = readFileSync(join(sourceRoot, file), "utf-8");
    const matches = text.match(/name:\s*"([a-z0-9_]+)"/g) ?? [];
    for (const match of matches) {
      const parsed = /name:\s*"([a-z0-9_]+)"/.exec(match)?.[1];
      if (parsed) names.add(parsed);
    }
  }

  return [...names].toSorted();
}

describe("docs/guide features tool coverage", () => {
  it("documents all tool names in features guide", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const toolNames = collectToolNames(resolve(repoRoot, "packages/brewva-tools/src"));
    const markdown = readFileSync(resolve(repoRoot, "docs/guide/features.md"), "utf-8");

    const missing = toolNames.filter((name) => !markdown.includes(`\`${name}\``));

    expect(missing, `Missing tools in docs/guide/features.md: ${missing.join(", ")}`).toEqual([]);
  });
});
