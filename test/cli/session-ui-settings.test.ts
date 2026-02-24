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
  test("passes agentId from CLI session options into runtime identity scope", async () => {
    const workspace = createWorkspace("agent-id");
    const result = await createBrewvaSession({
      cwd: workspace,
      agentId: "Code Reviewer",
    });
    try {
      expect(result.runtime.agentId).toBe("code-reviewer");
    } finally {
      result.session.dispose();
    }
  });

  test("applies ui startup settings from brewva config into session settings", async () => {
    const workspace = createWorkspace("explicit");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          ui: {
            quietStartup: false,
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
      const activeTools = result.session.getActiveToolNames();
      expect(result.runtime.config.ui.quietStartup).toBe(false);
      expect(result.session.settingsManager.getQuietStartup()).toBe(false);
      expect(activeTools.includes("exec")).toBe(true);
      expect(activeTools.includes("process")).toBe(true);
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
      const activeTools = result.session.getActiveToolNames();
      expect(result.runtime.config.ui.quietStartup).toBe(true);
      expect(result.session.settingsManager.getQuietStartup()).toBe(true);
      expect(activeTools.includes("exec")).toBe(true);
      expect(activeTools.includes("process")).toBe(true);
    } finally {
      result.session.dispose();
    }
  });
});
