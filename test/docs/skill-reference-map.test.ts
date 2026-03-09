import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface SkillReferenceCase {
  name: string;
  skillPath: string;
  referencesDir: string;
}

function repoRoot(): string {
  return resolve(import.meta.dirname, "../..");
}

function listReferenceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .toSorted();
}

describe("skill reference maps", () => {
  const root = repoRoot();
  const cases: SkillReferenceCase[] = [
    {
      name: "goal-loop",
      skillPath: join(root, "skills/packs/goal-loop/SKILL.md"),
      referencesDir: join(root, "skills/packs/goal-loop/references"),
    },
    {
      name: "zca-structured-output",
      skillPath: join(root, "skills/packs/zca-structured-output/SKILL.md"),
      referencesDir: join(root, "skills/packs/zca-structured-output/references"),
    },
    {
      name: "recovery",
      skillPath: join(root, "skills/base/recovery/SKILL.md"),
      referencesDir: join(root, "skills/base/recovery/references"),
    },
  ];

  for (const testCase of cases) {
    test(`${testCase.name} links every local reference file from SKILL.md`, () => {
      const markdown = readFileSync(testCase.skillPath, "utf-8");
      const referenceFiles = listReferenceFiles(testCase.referencesDir);

      expect(referenceFiles.length).toBeGreaterThan(0);
      for (const fileName of referenceFiles) {
        expect(markdown).toContain(`references/${fileName}`);
      }
    });
  }
});
