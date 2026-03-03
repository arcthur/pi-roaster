import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaRuntime,
  discoverSkillRegistryRoots,
  emitSkippedPackFilterWarning,
  resetSkippedPackFilterWarningCache,
} from "@brewva/brewva-runtime";

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
    expect(runtime.skills.get("commitcraft")).toBeDefined();
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
    expect(runtime.skills.get("commitcraft")).toBeUndefined();

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
    expect(runtime.skills.get("externalcraft")).toBeDefined();
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
      expect(runtime.skills.get("globalcraft")).toBeDefined();

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
    expect(runtime.skills.get("directcraft")).toBeDefined();
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

  test("loads workspace pack skills when skills.packs is empty (no filter)", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-workspace-pack-"));
    writeSkill(join(workspace, ".brewva/skills/packs/custom-pack/SKILL.md"), {
      name: "packcraft",
      tag: "packcrafttag",
    });

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.skills.packs = [];

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    expect(runtime.skills.get("packcraft")).toBeDefined();
    const loadReport = runtime.skills.getLoadReport();
    expect(loadReport.skippedPacks.some((entry) => entry.pack === "custom-pack")).toBe(false);
    expect(loadReport.activePacks).toContain("custom-pack");
  });

  test("does not load config_root pack skills when not listed in non-empty skills.packs", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-config-pack-workspace-"));
    const external = mkdtempSync(join(tmpdir(), "brewva-skill-config-pack-external-"));
    writeSkill(join(external, "skills/packs/custom-pack/SKILL.md"), {
      name: "external-packcraft",
      tag: "external-packcrafttag",
    });

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.skills.roots = [external];
    config.skills.packs = ["skill-creator"];

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    expect(runtime.skills.get("external-packcraft")).toBeUndefined();
    const loadReport = runtime.skills.getLoadReport();
    expect(
      loadReport.skippedPacks.some(
        (entry) => entry.pack === "custom-pack" && entry.source === "config_root",
      ),
    ).toBe(true);
  });

  test("emits skipped-pack warning only once for the same skipped set", () => {
    resetSkippedPackFilterWarningCache();
    const logs: string[] = [];
    const report = {
      roots: [],
      activePacks: [],
      skippedPacks: [
        {
          pack: "custom-pack",
          source: "project_root" as const,
          rootDir: "/tmp/project",
          skillDir: "/tmp/project/.brewva/skills",
          reason: "not_in_skills.packs" as const,
        },
      ],
    };

    const first = emitSkippedPackFilterWarning(report, {
      log: (message) => logs.push(message),
    });
    const second = emitSkippedPackFilterWarning(report, {
      log: (message) => logs.push(message),
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.includes("custom-pack")).toBe(true);
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
