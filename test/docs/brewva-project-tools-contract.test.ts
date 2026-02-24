import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TOOL_SOURCE_FILES = [
  "ast-grep.ts",
  "cost-view.ts",
  "exec.ts",
  "ledger-query.ts",
  "look-at.ts",
  "lsp.ts",
  "process.ts",
  "rollback-last-patch.ts",
  "schedule-intent.ts",
  "session-compact.ts",
  "skill-load.ts",
  "skill-complete.ts",
  "tape.ts",
  "task-ledger.ts",
];

function collectBrewvaToolNames(sourceRoot: string): string[] {
  const names = new Set<string>();
  for (const file of TOOL_SOURCE_FILES) {
    const text = readFileSync(join(sourceRoot, file), "utf-8");
    const matches = text.match(/name:\s*"([a-z0-9_]+)"/g) ?? [];
    for (const match of matches) {
      const parsed = /name:\s*"([a-z0-9_]+)"/.exec(match)?.[1];
      if (parsed) names.add(parsed);
    }
  }
  return [...names].toSorted();
}

function parseInlineArray(value: string): string[] {
  const raw = value.trim();
  if (!raw.startsWith("[") || !raw.endsWith("]")) return [];
  const body = raw.slice(1, -1).trim();
  if (!body) return [];
  return body
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseSkillContractTools(markdown: string): Set<string> {
  const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(markdown)?.[1];
  if (!frontmatter) return new Set<string>();

  const collected = new Set<string>();
  const lines = frontmatter.split("\n");
  let inTools = false;
  let activeList: "required" | "optional" | null = null;

  for (const line of lines) {
    const raw = line;
    const trimmed = raw.trim();
    const indent = raw.length - raw.trimStart().length;

    if (!inTools) {
      if (trimmed === "tools:") {
        inTools = true;
      }
      continue;
    }

    if (indent < 2 || trimmed.length === 0) {
      if (indent < 2) break;
      continue;
    }

    if (trimmed.startsWith("required:")) {
      activeList = "required";
      for (const value of parseInlineArray(trimmed.slice("required:".length))) {
        collected.add(value);
      }
      continue;
    }

    if (trimmed.startsWith("optional:")) {
      activeList = "optional";
      for (const value of parseInlineArray(trimmed.slice("optional:".length))) {
        collected.add(value);
      }
      continue;
    }

    if (trimmed.startsWith("denied:")) {
      activeList = null;
      continue;
    }

    if (trimmed.startsWith("- ") && activeList) {
      collected.add(trimmed.slice(2).trim());
    }
  }

  return collected;
}

describe("brewva-project skill contract", () => {
  it("covers all runtime tools from @brewva/brewva-tools", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const brewvaToolNames = collectBrewvaToolNames(resolve(repoRoot, "packages/brewva-tools/src"));

    const skillMarkdown = readFileSync(
      resolve(repoRoot, "skills/project/brewva-project/SKILL.md"),
      "utf-8",
    );
    const declared = parseSkillContractTools(skillMarkdown);
    const missing = brewvaToolNames.filter((name) => !declared.has(name));

    expect(
      missing,
      `Missing @brewva/brewva-tools entries in brewva-project skill contract: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
