import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function writeSkill(filePath: string, input: { name: string; description: string }): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${input.name}`,
      `description: ${input.description}`,
      "intent:",
      "  outputs: []",
      "effects:",
      "  allowed_effects: [workspace_read]",
      "resources:",
      "  default_lease:",
      "    max_tool_calls: 20",
      "    max_tokens: 20000",
      "  hard_ceiling:",
      "    max_tool_calls: 30",
      "    max_tokens: 30000",
      "execution_hints:",
      "  preferred_tools: [read]",
      "  fallback_tools: []",
      "consumes: []",
      "---",
      `# ${input.name}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function runForkSkill(input: {
  scriptPath: string;
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}): ReturnType<typeof spawnSync> {
  return spawnSync("python3", [input.scriptPath, ...input.args], {
    cwd: input.cwd,
    env: input.env ?? process.env,
    encoding: "utf8",
  });
}

function toTextOutput(value: ReturnType<typeof spawnSync>["stdout"]): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function assertSuccess(result: ReturnType<typeof spawnSync>): void {
  if (result.status !== 0) {
    const stdout = toTextOutput(result.stdout);
    const stderr = toTextOutput(result.stderr);
    throw new Error(
      `fork_skill.py failed (status=${result.status})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
}

describe("skill-authoring fork script", () => {
  const repoRoot = resolve(import.meta.dir, "../..");
  const scriptPath = join(repoRoot, "skills/meta/skill-authoring/scripts/fork_skill.py");

  test("forks a global skill into a project overlay and becomes effective", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-fork-project-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-fork-xdg-"));
    const previousXdg = process.env.XDG_CONFIG_HOME;

    try {
      mkdirSync(join(workspace, ".brewva"), { recursive: true });
      writeSkill(join(xdgRoot, "brewva/skills/domain/chaincraft/SKILL.md"), {
        name: "chaincraft",
        description: "global chaincraft",
      });

      const result = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["chaincraft"],
        env: {
          ...process.env,
          XDG_CONFIG_HOME: xdgRoot,
        },
      });
      assertSuccess(result);

      const destination = join(workspace, ".brewva/skills/project/overlays/chaincraft/SKILL.md");
      expect(existsSync(destination)).toBe(true);
      const forked = readFileSync(destination, "utf8");
      expect(forked.includes("source_name: chaincraft")).toBe(true);
      expect(forked.includes("tool: skill-authoring/scripts/fork_skill.py")).toBe(true);
      expect(forked.includes("source_category: domain")).toBe(true);
      expect(forked.includes("routing:")).toBe(false);

      process.env.XDG_CONFIG_HOME = xdgRoot;
      const runtime = new BrewvaRuntime({ cwd: workspace });
      expect(runtime.skills.get("chaincraft")?.overlayFiles).toContain(resolve(destination));
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
      rmSync(workspace, { recursive: true, force: true });
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });

  test("requires --force when destination already exists", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-fork-force-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-fork-force-xdg-"));

    try {
      mkdirSync(join(workspace, ".brewva"), { recursive: true });
      writeSkill(join(xdgRoot, "brewva/skills/domain/forcecraft/SKILL.md"), {
        name: "forcecraft",
        description: "global forcecraft",
      });

      const env = {
        ...process.env,
        XDG_CONFIG_HOME: xdgRoot,
      };

      const first = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["forcecraft"],
        env,
      });
      assertSuccess(first);

      const second = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["forcecraft"],
        env,
      });
      expect(second.status).not.toBe(0);
      expect(second.stdout.includes("Destination already exists")).toBe(true);

      const forced = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["forcecraft", "--force"],
        env,
      });
      assertSuccess(forced);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });

  test("fails by default when custom destination is inactive, can be allowed", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-fork-inactive-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-fork-inactive-xdg-"));

    try {
      mkdirSync(join(workspace, ".brewva"), { recursive: true });
      writeSkill(join(xdgRoot, "brewva/skills/domain/inactivecraft/SKILL.md"), {
        name: "inactivecraft",
        description: "global inactivecraft",
      });

      const env = {
        ...process.env,
        XDG_CONFIG_HOME: xdgRoot,
      };

      const inactive = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["inactivecraft", "--path", "./vendor-skills"],
        env,
      });
      expect(inactive.status).toBe(2);

      const destination = join(
        workspace,
        "vendor-skills/skills/project/overlays/inactivecraft/SKILL.md",
      );
      expect(existsSync(destination)).toBe(true);

      const allowed = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["inactivecraft", "--path", "./vendor-skills", "--force", "--allow-inactive"],
        env,
      });
      assertSuccess(allowed);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });

  test("reports inactive when skill is disabled by config", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-fork-disabled-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-fork-disabled-xdg-"));

    try {
      mkdirSync(join(workspace, ".brewva"), { recursive: true });
      writeSkill(join(xdgRoot, "brewva/skills/domain/disabledcraft/SKILL.md"), {
        name: "disabledcraft",
        description: "global disabledcraft",
      });

      writeFileSync(
        join(workspace, ".brewva/brewva.json"),
        JSON.stringify({
          skills: {
            disabled: ["disabledcraft"],
          },
        }),
      );

      const env = {
        ...process.env,
        XDG_CONFIG_HOME: xdgRoot,
      };

      const inactive = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["disabledcraft"],
        env,
      });
      expect(inactive.status).toBe(2);
      expect(inactive.stdout.includes("Remove the skill from skills.disabled")).toBe(true);

      const allowed = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["disabledcraft", "--force", "--allow-inactive"],
        env,
      });
      assertSuccess(allowed);
      expect(allowed.stdout.includes("skills.disabled")).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });
});
