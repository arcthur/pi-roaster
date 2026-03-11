import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBrewvaSession } from "@brewva/brewva-cli";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-session-ui-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function writeSkill(filePath: string, name: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${name}`,
      `description: ${name} skill`,
      "tools:",
      "  required: [read]",
      "  optional: []",
      "  denied: []",
      "budget:",
      "  max_tool_calls: 5",
      "  max_tokens: 2000",
      "outputs: []",
      "consumes: []",
      "---",
      `# ${name}`,
      "",
      "## Intent",
      "",
      "test skill",
      "",
      "## Trigger",
      "",
      "test",
      "",
      "## Workflow",
      "",
      "### Step 1",
      "",
      "test",
      "",
      "## Stop Conditions",
      "",
      "- none",
      "",
      "## Anti-Patterns",
      "",
      "- none",
      "",
      "## Example",
      "",
      "Input: test",
    ].join("\n"),
    "utf8",
  );
}

describe("brewva session ui settings wiring", () => {
  test("normalizes agentId into runtime identity", async () => {
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

  test("applies ui quietStartup override from config", async () => {
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
      expect(result.runtime.config.ui.quietStartup).toBe(false);
      expect(result.session.settingsManager.getQuietStartup()).toBe(false);
    } finally {
      result.session.dispose();
    }
  });

  test("preserves runtime ui defaults when config only changes skills routing", async () => {
    const workspace = createWorkspace("default");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              profile: "operator",
              scopes: ["core", "domain", "operator"],
            },
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
      expect(result.session.settingsManager.getQuietStartup()).toBe(true);
    } finally {
      result.session.dispose();
    }
  });

  test("session_bootstrap payload records routing load report", async () => {
    const workspace = createWorkspace("skill-load-report");
    writeSkill(join(workspace, ".brewva/skills/operator/custom-ops/SKILL.md"), "custom-ops");

    const result = await createBrewvaSession({
      cwd: workspace,
    });
    try {
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as
        | {
            skillLoad?: {
              routingProfile?: string;
              routingScopes?: string[];
              hiddenSkills?: string[];
            };
          }
        | undefined) ?? { skillLoad: {} };

      expect(payload.skillLoad?.routingProfile).toBe("standard");
      expect(payload.skillLoad?.routingScopes).toEqual(["core", "domain"]);
      expect(payload.skillLoad?.hiddenSkills).toContain("custom-ops");
    } finally {
      result.session.dispose();
    }
  });

  test("routingProfile and routingScopes options override skill routing exposure", async () => {
    const workspace = createWorkspace("skill-routing-override");
    writeSkill(join(workspace, ".brewva/skills/operator/custom-ops/SKILL.md"), "custom-ops");

    const result = await createBrewvaSession({
      cwd: workspace,
      routingProfile: "operator",
      routingScopes: ["core", "domain", "operator"],
    });
    try {
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as
        | {
            skillLoad?: {
              routingProfile?: string;
              routingScopes?: string[];
              routableSkills?: string[];
            };
          }
        | undefined) ?? { skillLoad: {} };

      expect(payload.skillLoad?.routingProfile).toBe("operator");
      expect(payload.skillLoad?.routingScopes).toEqual(["core", "domain", "operator"]);
      expect(payload.skillLoad?.routableSkills).toContain("custom-ops");
    } finally {
      result.session.dispose();
    }
  });

  test("session bootstrap records proposal boundary for the skill broker", async () => {
    const workspace = createWorkspace("skill-broker-bootstrap");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              profile: "standard",
            },
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
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as
        | {
            skillBroker?: {
              enabled?: boolean;
              proposalBoundary?: string;
            };
          }
        | undefined) ?? { skillBroker: { enabled: false } };
      expect(payload.skillBroker?.enabled).toBe(true);
      expect(payload.skillBroker?.proposalBoundary).toBe("runtime.proposals.submit");
    } finally {
      result.session.dispose();
    }
  });

  test("no-addons session bootstrap still exposes the proposal boundary", async () => {
    const workspace = createWorkspace("skill-broker-no-addons");
    const result = await createBrewvaSession({
      cwd: workspace,
      enableExtensions: false,
    });
    try {
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as
        | {
            extensionsEnabled?: boolean;
            skillBroker?: {
              enabled?: boolean;
              proposalBoundary?: string;
            };
          }
        | undefined) ?? { extensionsEnabled: true, skillBroker: { enabled: false } };
      expect(payload.extensionsEnabled).toBe(false);
      expect(payload.skillBroker?.enabled).toBe(true);
      expect(payload.skillBroker?.proposalBoundary).toBe("runtime.proposals.submit");
    } finally {
      result.session.dispose();
    }
  });

  test("autoloads workspace addons and applies persisted scope context packets", async () => {
    const workspace = createWorkspace("addons-autoload");
    const addonDir = join(workspace, ".brewva/addons/ops-status");
    mkdirSync(addonDir, { recursive: true });
    writeFileSync(
      join(addonDir, "index.ts"),
      ['export default { id: "ops-status" };'].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(addonDir, "context-packets.jsonl"),
      `${JSON.stringify({
        addonId: "ops-status",
        writtenAt: Date.now(),
        scopeId: "scope-main",
        packetKey: "daily-summary",
        label: "Daily summary",
        content: "Summary from addon host",
        profile: "status_summary",
      })}\n`,
      "utf8",
    );

    const result = await createBrewvaSession({
      cwd: workspace,
      scopeId: "scope-main",
    });
    try {
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as { addonsEnabled?: boolean } | undefined) ?? {};
      expect(payload.addonsEnabled).toBe(true);

      const packets = result.runtime.proposals.list(sessionId, {
        kind: "context_packet",
      });
      expect(packets).toHaveLength(1);
      const firstPacket = packets[0];
      expect(firstPacket?.proposal.issuer).toBe("addon:ops-status");
      expect((firstPacket?.proposal.payload as { packetKey?: string } | undefined)?.packetKey).toBe(
        "daily-summary",
      );
    } finally {
      result.session.dispose();
    }
  });

  test("fails fast when workspace addon omits required config", async () => {
    const workspace = createWorkspace("addons-required-config");
    const addonDir = join(workspace, ".brewva/addons/ops-status");
    mkdirSync(addonDir, { recursive: true });
    writeFileSync(
      join(addonDir, "index.ts"),
      [
        "export default {",
        '  id: "ops-status",',
        "  config: {",
        "    apiKey: {",
        '      type: "string",',
        '      description: "API key",',
        "      required: true,",
        "    },",
        "  },",
        "};",
      ].join("\n"),
      "utf8",
    );

    try {
      await createBrewvaSession({
        cwd: workspace,
      });
      throw new Error("expected addon config validation to fail");
    } catch (error) {
      expect((error as Error).message).toContain(
        "missing required config for addon ops-status: apiKey",
      );
    }
  });

  test("fails fast when workspace addon exports invalid jobs", async () => {
    const workspace = createWorkspace("addons-invalid-job");
    const addonDir = join(workspace, ".brewva/addons/ops-status");
    mkdirSync(addonDir, { recursive: true });
    writeFileSync(
      join(addonDir, "index.ts"),
      [
        "export default {",
        '  id: "ops-status",',
        "  jobs: [",
        "    {",
        '      id: "",',
        "      schedule: {},",
        '      run: "not-a-function",',
        "    },",
        "  ],",
        "};",
      ].join("\n"),
      "utf8",
    );

    try {
      await createBrewvaSession({
        cwd: workspace,
      });
      throw new Error("expected addon job validation to fail");
    } catch (error) {
      expect((error as Error).message).toContain("addon jobs[0].id is required");
    }
  });
});
