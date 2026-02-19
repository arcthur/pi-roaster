import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaSession } from "@brewva/brewva-cli";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-session-ui-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("brewva session ui settings wiring", () => {
  test("applies ui startup settings from brewva config into session settings", async () => {
    const workspace = createWorkspace("explicit");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          ui: {
            quietStartup: false,
            collapseChangelog: false,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await createBrewvaSession({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    try {
      expect(result.runtime.config.ui.quietStartup).toBe(false);
      expect(result.runtime.config.ui.collapseChangelog).toBe(false);
      expect(result.session.settingsManager.getQuietStartup()).toBe(false);
      expect(result.session.settingsManager.getCollapseChangelog()).toBe(false);
    } finally {
      result.session.dispose();
    }
  });

  test("uses runtime ui defaults when config does not provide ui override", async () => {
    const workspace = createWorkspace("default");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            packs: ["typescript", "react", "bun"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await createBrewvaSession({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    try {
      expect(result.runtime.config.ui.quietStartup).toBe(true);
      expect(result.runtime.config.ui.collapseChangelog).toBe(true);
      expect(result.session.settingsManager.getQuietStartup()).toBe(true);
      expect(result.session.settingsManager.getCollapseChangelog()).toBe(true);
    } finally {
      result.session.dispose();
    }
  });
});
