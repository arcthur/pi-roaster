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
  test("given agentId option, when creating brewva session, then runtime identity agent id is normalized", async () => {
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

  test("given ui quietStartup override in config, when creating brewva session, then runtime and session settings apply override", async () => {
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

  test("given config without ui override, when creating brewva session, then runtime ui defaults are preserved", async () => {
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
