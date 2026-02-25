import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("S-001 selector inject top-k and anti-tags", () => {
  test("given query with anti-tag context, when selecting skills, then blocked skill is excluded", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const selected = runtime.skills.select("debug failing test regression in typescript module");
    expect(selected.length).toBeGreaterThan(0);

    const docsSelected = runtime.skills.select("implement a new feature and update docs");
    expect(docsSelected.some((skill) => skill.name === "debugging")).toBe(false);
  });
});
