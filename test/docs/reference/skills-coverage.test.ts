import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function collectSkillNames(root: string): string[] {
  const tiers = ["base", "packs", "project"];
  const names: string[] = [];

  for (const tier of tiers) {
    const tierDir = join(root, tier);
    for (const entry of readdirSync(tierDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      names.push(entry.name);
    }
  }

  return names.sort();
}

describe("docs/reference skills coverage", () => {
  it("documents all skill names", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const skillNames = collectSkillNames(resolve(repoRoot, "skills"));
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/skills.md"), "utf-8");

    const missing = skillNames.filter((name) => !markdown.includes(`\`${name}\``));

    expect(missing, `Missing skills in docs/reference/skills.md: ${missing.join(", ")}`).toEqual([]);
  });
});
