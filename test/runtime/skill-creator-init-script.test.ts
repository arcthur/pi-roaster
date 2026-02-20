import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function runInitSkill(input: {
  scriptPath: string;
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}): void {
  const result = spawnSync("python3", [input.scriptPath, ...input.args], {
    cwd: input.cwd,
    env: input.env ?? process.env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `init_skill.py failed (status=${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

describe("skill-creator init script default paths", () => {
  const repoRoot = resolve(import.meta.dir, "../..");
  const scriptPath = join(repoRoot, "skills/packs/skill-creator/scripts/init_skill.py");

  test("writes into project .brewva skills packs when .brewva exists", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-init-project-"));
    try {
      mkdirSync(join(workspace, ".brewva"), { recursive: true });
      const skillName = "my-project-skill";
      runInitSkill({
        scriptPath,
        cwd: workspace,
        args: [skillName],
      });

      const skillPath = join(workspace, ".brewva/skills/packs", skillName);
      expect(existsSync(join(skillPath, "SKILL.md"))).toBe(true);
      expect(existsSync(join(skillPath, "scripts/example.py"))).toBe(true);
      expect(existsSync(join(skillPath, "references/api_reference.md"))).toBe(true);
      expect(existsSync(join(skillPath, "assets/example_asset.txt"))).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("falls back to global skills packs when project .brewva is missing", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-init-global-workspace-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-init-global-xdg-"));
    try {
      const skillName = "my-global-skill";
      runInitSkill({
        scriptPath,
        cwd: workspace,
        args: [skillName],
        env: {
          ...process.env,
          XDG_CONFIG_HOME: xdgRoot,
        },
      });

      const globalSkillPath = join(xdgRoot, "brewva/skills/packs", skillName);
      expect(existsSync(join(globalSkillPath, "SKILL.md"))).toBe(true);
      expect(existsSync(join(workspace, ".brewva/skills/packs", skillName))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });

  test("respects explicit --path override", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-init-explicit-"));
    try {
      const skillName = "my-explicit-skill";
      runInitSkill({
        scriptPath,
        cwd: workspace,
        args: [skillName, "--path", "./custom-target"],
      });

      const explicitPath = join(workspace, "custom-target", skillName);
      expect(existsSync(join(explicitPath, "SKILL.md"))).toBe(true);
      expect(existsSync(join(workspace, ".brewva/skills/packs", skillName))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
