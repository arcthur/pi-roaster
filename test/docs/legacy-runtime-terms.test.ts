import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function listMarkdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
      continue;
    }
    if (entry.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

const BANNED_PATTERNS: RegExp[] = [
  /\bstartToolCall\b/u,
  /\bfinishToolCall\b/u,
  /\bruntime\.recordEvent\b/u,
  /\bruntime\.buildContextInjection\b/u,
  /\bbrewva\.working-memory\b/u,
  /\bbrewva\.memory-recall\b/u,
];

describe("docs legacy runtime term guard", () => {
  it("does not reference removed runtime naming patterns", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const docsDir = resolve(repoRoot, "docs");
    const markdownFiles = listMarkdownFiles(docsDir);

    const violations: string[] = [];
    for (const filePath of markdownFiles) {
      const content = readFileSync(filePath, "utf-8");
      for (const pattern of BANNED_PATTERNS) {
        if (!pattern.test(content)) continue;
        violations.push(`${filePath}: matched ${pattern.toString()}`);
      }
    }

    expect(violations, `Found legacy runtime terms in docs:\n${violations.join("\n")}`).toEqual([]);
  });
});
