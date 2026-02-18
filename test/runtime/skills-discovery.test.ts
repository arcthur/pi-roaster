import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import { DEFAULT_ROASTER_CONFIG, RoasterRuntime } from "@pi-roaster/roaster-runtime";
import { SkillRegistry, discoverSkillRegistryRoots } from "../../packages/roaster-runtime/src/skills/registry.js";

function writeSkill(filePath: string, input: { name: string; tag: string }): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `---\nname: ${input.name}\ndescription: ${input.name} skill\ntags: [${input.tag}]\ntools:\n  required: [read]\n  optional: []\n  denied: []\nbudget:\n  max_tool_calls: 10\n  max_tokens: 10000\n---\n# ${input.name}\n`,
    "utf8",
  );
}

describe("skill discovery and loading", () => {
  test("loads ancestor workspace skills when running from nested cwd", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-skill-ancestor-"));
    writeSkill(join(workspace, "skills/base/commitcraft/SKILL.md"), {
      name: "commitcraft",
      tag: "commitcrafttag",
    });
    const nested = join(workspace, "apps/api");
    mkdirSync(nested, { recursive: true });

    const runtime = new RoasterRuntime({ cwd: nested });
    const selected = runtime.selectSkills("please use commitcrafttag for this task");
    expect(selected.some((entry) => entry.name === "commitcraft")).toBe(true);
    const roots = discoverSkillRegistryRoots({
      cwd: nested,
      configuredRoots: runtime.config.skills.roots ?? [],
    });
    expect(
      roots.some((entry) =>
        entry.source === "cwd_ancestor" && entry.skillDir === resolve(workspace, "skills")),
    ).toBe(true);
  });

  test("loads skills from config.skills.roots when cwd has no local skill tree", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-skill-config-root-workspace-"));
    const external = mkdtempSync(join(tmpdir(), "roaster-skill-config-root-external-"));
    writeSkill(join(external, "skills/base/externalcraft/SKILL.md"), {
      name: "externalcraft",
      tag: "externalcrafttag",
    });

    const config = structuredClone(DEFAULT_ROASTER_CONFIG);
    config.skills.roots = [external];

    const runtime = new RoasterRuntime({ cwd: workspace, config });
    const selected = runtime.selectSkills("apply externalcrafttag flow");
    expect(selected.some((entry) => entry.name === "externalcraft")).toBe(true);
    const roots = discoverSkillRegistryRoots({
      cwd: workspace,
      configuredRoots: runtime.config.skills.roots ?? [],
    });
    expect(
      roots.some((entry) =>
        entry.source === "config_root" && entry.skillDir === resolve(external, "skills")),
    ).toBe(true);
  });

  test("loads config skill roots that use direct tier layout", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-skill-direct-layout-workspace-"));
    const directRoot = mkdtempSync(join(tmpdir(), "roaster-skill-direct-layout-root-"));
    writeSkill(join(directRoot, "base/directcraft/SKILL.md"), {
      name: "directcraft",
      tag: "directcrafttag",
    });

    const config = structuredClone(DEFAULT_ROASTER_CONFIG);
    config.skills.roots = [directRoot];

    const runtime = new RoasterRuntime({ cwd: workspace, config });
    const selected = runtime.selectSkills("please run directcrafttag");
    expect(runtime.getSkill("directcraft")).toBeDefined();
    expect(selected.some((entry) => entry.name === "directcraft")).toBe(true);
  });

  test("resolves relative config.skills.roots from cwd", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-skill-relative-root-workspace-"));
    writeSkill(join(workspace, "vendor-skills/skills/base/relativecraft/SKILL.md"), {
      name: "relativecraft",
      tag: "relativecrafttag",
    });

    const config = structuredClone(DEFAULT_ROASTER_CONFIG);
    config.skills.roots = ["./vendor-skills"];

    const runtime = new RoasterRuntime({ cwd: workspace, config });
    expect(runtime.getSkill("relativecraft")).toBeDefined();
  });

  test("loads workspace pack skills even when not listed in skills.packs", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-skill-workspace-pack-"));
    writeSkill(join(workspace, "skills/packs/custom-pack/SKILL.md"), {
      name: "packcraft",
      tag: "packcrafttag",
    });

    const config = structuredClone(DEFAULT_ROASTER_CONFIG);
    config.skills.packs = [];

    const runtime = new RoasterRuntime({ cwd: workspace, config });
    const selected = runtime.selectSkills("run packcrafttag workflow");
    expect(runtime.getSkill("packcraft")).toBeDefined();
    expect(selected.some((entry) => entry.name === "packcraft")).toBe(true);
  });

  test("discovers skill roots from executable ancestors for packaged binaries", () => {
    const cwd = mkdtempSync(join(tmpdir(), "roaster-skill-discovery-cwd-"));
    const execRoot = mkdtempSync(join(tmpdir(), "roaster-skill-discovery-exec-"));
    mkdirSync(join(execRoot, "bin"), { recursive: true });
    writeSkill(join(execRoot, "skills/base/execraft/SKILL.md"), {
      name: "execraft",
      tag: "execrafttag",
    });

    const roots = discoverSkillRegistryRoots({
      cwd,
      moduleUrl: pathToFileURL(join(cwd, "runtime.js")).href,
      execPath: join(execRoot, "bin/pi-roaster"),
    });
    expect(
      roots.some((entry) =>
        entry.source === "exec_ancestor" && entry.skillDir === resolve(execRoot, "skills")),
    ).toBe(true);
  });

  test("prefers nearer executable ancestor roots over farther ancestors", () => {
    const cwd = mkdtempSync(join(tmpdir(), "roaster-skill-discovery-precedence-cwd-"));
    const farRoot = mkdtempSync(join(tmpdir(), "roaster-skill-discovery-precedence-far-"));
    const nearRoot = join(farRoot, "near");
    mkdirSync(join(nearRoot, "bin"), { recursive: true });

    writeSkill(join(farRoot, "skills/base/chaincraft/SKILL.md"), {
      name: "chaincraft",
      tag: "fartag",
    });
    writeSkill(join(nearRoot, "skills/base/chaincraft/SKILL.md"), {
      name: "chaincraft",
      tag: "neartag",
    });

    const roots = discoverSkillRegistryRoots({
      cwd,
      moduleUrl: pathToFileURL(join(cwd, "runtime.js")).href,
      execPath: join(nearRoot, "bin/pi-roaster"),
    });
    const farSkillDir = resolve(farRoot, "skills");
    const nearSkillDir = resolve(nearRoot, "skills");
    const farIndex = roots.findIndex((entry) => entry.skillDir === farSkillDir);
    const nearIndex = roots.findIndex((entry) => entry.skillDir === nearSkillDir);

    expect(farIndex).toBeGreaterThanOrEqual(0);
    expect(nearIndex).toBeGreaterThan(farIndex);

    const config = structuredClone(DEFAULT_ROASTER_CONFIG);
    const registry = new SkillRegistry({ rootDir: cwd, config, roots });
    registry.load();
    expect(registry.get("chaincraft")?.contract.tags).toContain("neartag");
  });

  test("applies pack filtering by root source", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-skill-source-pack-workspace-"));
    const skillRoot = mkdtempSync(join(tmpdir(), "roaster-skill-source-pack-root-"));
    writeSkill(join(skillRoot, "skills/packs/custom/sourcepack/SKILL.md"), {
      name: "sourcepack",
      tag: "sourcepacktag",
    });

    const config = structuredClone(DEFAULT_ROASTER_CONFIG);
    config.skills.packs = [];

    const moduleRegistry = new SkillRegistry({
      rootDir: workspace,
      config,
      roots: [
        {
          rootDir: skillRoot,
          skillDir: resolve(skillRoot, "skills"),
          source: "module_ancestor",
        },
      ],
    });
    moduleRegistry.load();
    expect(moduleRegistry.get("sourcepack")).toBeUndefined();

    const cwdRegistry = new SkillRegistry({
      rootDir: workspace,
      config,
      roots: [
        {
          rootDir: skillRoot,
          skillDir: resolve(skillRoot, "skills"),
          source: "cwd_ancestor",
        },
      ],
    });
    cwdRegistry.load();
    expect(cwdRegistry.get("sourcepack")).toBeDefined();
  });
});
