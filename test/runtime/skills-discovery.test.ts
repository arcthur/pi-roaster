import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime } from "@brewva/brewva-runtime";
import { discoverSkillRegistryRoots } from "@brewva/brewva-runtime";

function writeSkill(filePath: string, input: { name: string; tag: string }): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `---\nname: ${input.name}\ndescription: ${input.name} skill\ntags: [${input.tag}]\ntools:\n  required: [read]\n  optional: []\n  denied: []\nbudget:\n  max_tool_calls: 10\n  max_tokens: 10000\n---\n# ${input.name}\n`,
    "utf8",
  );
}

describe("skill discovery and loading", () => {
  test("loads project skills from cwd .brewva root", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-project-"));
    writeSkill(join(workspace, ".brewva/skills/base/commitcraft/SKILL.md"), {
      name: "commitcraft",
      tag: "commitcrafttag",
    });
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const selected = runtime.skills.select("please use commitcrafttag for this task");
    expect(selected.some((entry) => entry.name === "commitcraft")).toBe(true);
    const roots = discoverSkillRegistryRoots({
      cwd: workspace,
      configuredRoots: runtime.config.skills.roots ?? [],
    });
    expect(
      roots.some(
        (entry) =>
          entry.source === "project_root" &&
          entry.skillDir === resolve(workspace, ".brewva/skills"),
      ),
    ).toBe(true);
  });

  test("does not load ancestor .brewva skills when running from nested cwd", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-ancestor-disabled-"));
    writeSkill(join(workspace, ".brewva/skills/base/commitcraft/SKILL.md"), {
      name: "commitcraft",
      tag: "commitcrafttag",
    });
    const nested = join(workspace, "apps/api");
    mkdirSync(nested, { recursive: true });

    const runtime = new BrewvaRuntime({ cwd: nested });
    const selected = runtime.skills.select("please use commitcrafttag for this task");
    expect(selected.some((entry) => entry.name === "commitcraft")).toBe(false);

    const roots = discoverSkillRegistryRoots({
      cwd: nested,
      configuredRoots: runtime.config.skills.roots ?? [],
    });
    expect(roots.some((entry) => entry.skillDir === resolve(workspace, ".brewva/skills"))).toBe(
      false,
    );
  });

  test("loads skills from config.skills.roots when cwd has no local skill tree", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-config-root-workspace-"));
    const external = mkdtempSync(join(tmpdir(), "brewva-skill-config-root-external-"));
    writeSkill(join(external, "skills/base/externalcraft/SKILL.md"), {
      name: "externalcraft",
      tag: "externalcrafttag",
    });

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.skills.roots = [external];

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const selected = runtime.skills.select("apply externalcrafttag flow");
    expect(selected.some((entry) => entry.name === "externalcraft")).toBe(true);
    const roots = discoverSkillRegistryRoots({
      cwd: workspace,
      configuredRoots: runtime.config.skills.roots ?? [],
    });
    expect(
      roots.some(
        (entry) => entry.source === "config_root" && entry.skillDir === resolve(external, "skills"),
      ),
    ).toBe(true);
  });

  test("loads skills from global .config/brewva root", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-global-workspace-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-global-xdg-"));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgRoot;

    try {
      writeSkill(join(xdgRoot, "brewva/skills/base/globalcraft/SKILL.md"), {
        name: "globalcraft",
        tag: "globalcrafttag",
      });

      const runtime = new BrewvaRuntime({ cwd: workspace });
      const selected = runtime.skills.select("apply globalcrafttag flow");
      expect(selected.some((entry) => entry.name === "globalcraft")).toBe(true);

      const roots = discoverSkillRegistryRoots({
        cwd: workspace,
        configuredRoots: runtime.config.skills.roots ?? [],
      });
      expect(
        roots.some(
          (entry) =>
            entry.source === "global_root" && entry.skillDir === resolve(xdgRoot, "brewva/skills"),
        ),
      ).toBe(true);
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
    }
  });

  test("loads config skill roots that use direct tier layout", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-direct-layout-workspace-"));
    const directRoot = mkdtempSync(join(tmpdir(), "brewva-skill-direct-layout-root-"));
    writeSkill(join(directRoot, "base/directcraft/SKILL.md"), {
      name: "directcraft",
      tag: "directcrafttag",
    });

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.skills.roots = [directRoot];

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const selected = runtime.skills.select("please run directcrafttag");
    expect(runtime.skills.get("directcraft")).toBeDefined();
    expect(selected.some((entry) => entry.name === "directcraft")).toBe(true);
  });

  test("resolves relative config.skills.roots from cwd", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-relative-root-workspace-"));
    writeSkill(join(workspace, "vendor-skills/skills/base/relativecraft/SKILL.md"), {
      name: "relativecraft",
      tag: "relativecrafttag",
    });

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.skills.roots = ["./vendor-skills"];

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    expect(runtime.skills.get("relativecraft")).toBeDefined();
  });

  test("loads workspace pack skills even when not listed in skills.packs", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-workspace-pack-"));
    writeSkill(join(workspace, ".brewva/skills/packs/custom-pack/SKILL.md"), {
      name: "packcraft",
      tag: "packcrafttag",
    });

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.skills.packs = [];

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const selected = runtime.skills.select("run packcrafttag workflow");
    expect(runtime.skills.get("packcraft")).toBeDefined();
    expect(selected.some((entry) => entry.name === "packcraft")).toBe(true);
  });

  test("project skills override global skills when names collide", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-precedence-workspace-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-precedence-xdg-"));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgRoot;

    try {
      writeSkill(join(xdgRoot, "brewva/skills/base/chaincraft/SKILL.md"), {
        name: "chaincraft",
        tag: "globaltag",
      });
      writeSkill(join(workspace, ".brewva/skills/base/chaincraft/SKILL.md"), {
        name: "chaincraft",
        tag: "projecttag",
      });

      const runtime = new BrewvaRuntime({ cwd: workspace });
      expect(runtime.skills.get("chaincraft")?.contract.tags).toContain("projecttag");
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
    }
  });
});
