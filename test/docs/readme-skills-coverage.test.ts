import { describe, expect, it } from "bun:test";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function listSkillNames(rootDir: string): string[] {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(rootDir, entry.name, "SKILL.md");
    try {
      if (statSync(skillPath).isFile()) {
        names.push(entry.name);
      }
    } catch {
      // Ignore non-skill folders.
    }
  }
  return names.toSorted();
}

describe("README skill coverage", () => {
  it("mentions all repository skills", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf-8");

    const baseSkills = listSkillNames(resolve(repoRoot, "skills/base"));
    const packSkills = listSkillNames(resolve(repoRoot, "skills/packs"));
    const projectSkills = listSkillNames(resolve(repoRoot, "skills/project"));
    const allSkills = [...baseSkills, ...packSkills, ...projectSkills];

    const missing = allSkills.filter((name) => !readme.includes(`\`${name}\``));

    expect(missing, `Missing skills in README.md: ${missing.join(", ")}`).toEqual([]);
  });
});
