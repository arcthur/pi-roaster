import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_ROASTER_CONFIG } from "@pi-roaster/roaster-runtime";

describe("docs/reference configuration coverage", () => {
  it("documents all top-level roaster config keys", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/configuration.md"), "utf-8");
    const keys = Object.keys(DEFAULT_ROASTER_CONFIG);

    const missing = keys.filter((key) => !markdown.includes(`\`${key}\``));

    expect(missing, `Missing keys in docs/reference/configuration.md: ${missing.join(", ")}`).toEqual([]);
  });
});
