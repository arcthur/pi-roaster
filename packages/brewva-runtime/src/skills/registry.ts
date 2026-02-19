import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrewvaConfig, SkillDocument, SkillTier, SkillsIndexEntry } from "../types.js";
import {
  resolveGlobalBrewvaRootDir,
  resolveProjectBrewvaRootDir,
} from "../config/paths.js";
import { parseSkillDocument, tightenContract } from "./contract.js";

const TIER_PRIORITY: Record<SkillTier, number> = {
  base: 1,
  pack: 2,
  project: 3,
};

export type SkillRootSource =
  | "module_ancestor"
  | "exec_ancestor"
  | "global_root"
  | "project_root"
  | "config_root";

export interface SkillRegistryRoot {
  rootDir: string;
  skillDir: string;
  source: SkillRootSource;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasTierDirectories(skillDir: string): boolean {
  return isDirectory(join(skillDir, "base"))
    || isDirectory(join(skillDir, "packs"))
    || isDirectory(join(skillDir, "project"));
}

function resolveSkillDirectory(rootDir: string): string | undefined {
  const normalizedRoot = resolve(rootDir);
  const direct = normalizedRoot;
  const nested = join(normalizedRoot, "skills");
  if (hasTierDirectories(direct)) return direct;
  if (hasTierDirectories(nested)) return nested;
  return undefined;
}

const MAX_ANCESTOR_DEPTH = 10;

function collectBoundedAncestors(startDir: string): string[] {
  const out: string[] = [];
  let current = resolve(startDir);
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function sourcePriority(source: SkillRootSource): number {
  if (source === "config_root") return 5;
  if (source === "project_root") return 4;
  if (source === "global_root") return 3;
  if (source === "exec_ancestor") return 2;
  return 1;
}

function appendDiscoveredRoot(
  roots: SkillRegistryRoot[],
  rootIndexBySkillDir: Map<string, number>,
  rootDir: string,
  source: SkillRootSource,
): void {
  const skillDir = resolveSkillDirectory(rootDir);
  if (!skillDir) return;
  const skillDirKey = resolve(skillDir);
  const existingIndex = rootIndexBySkillDir.get(skillDirKey);
  if (existingIndex !== undefined) {
    const existing = roots[existingIndex];
    if (!existing) return;
    if (sourcePriority(source) > sourcePriority(existing.source)) {
      roots[existingIndex] = {
        rootDir: resolve(rootDir),
        skillDir: existing.skillDir,
        source,
      };
    }
    return;
  }

  rootIndexBySkillDir.set(skillDirKey, roots.length);
  roots.push({
    rootDir: resolve(rootDir),
    skillDir: skillDirKey,
    source,
  });
}

export function discoverSkillRegistryRoots(input: {
  cwd: string;
  configuredRoots?: string[];
  moduleUrl?: string;
  execPath?: string;
  globalRootDir?: string;
}): SkillRegistryRoot[] {
  const roots: SkillRegistryRoot[] = [];
  const rootIndexBySkillDir = new Map<string, number>();

  const moduleUrl = input.moduleUrl ?? import.meta.url;
  let modulePath: string | undefined;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    modulePath = undefined;
  }
  if (modulePath) {
    const moduleAncestors = collectBoundedAncestors(dirname(modulePath)).reverse();
    for (const ancestor of moduleAncestors) {
      appendDiscoveredRoot(roots, rootIndexBySkillDir, ancestor, "module_ancestor");
    }
  }

  const execPath = input.execPath ?? process.execPath;
  if (typeof execPath === "string" && execPath.trim().length > 0) {
    const execAncestors = collectBoundedAncestors(dirname(resolve(execPath))).reverse();
    for (const ancestor of execAncestors) {
      appendDiscoveredRoot(roots, rootIndexBySkillDir, ancestor, "exec_ancestor");
    }
  }

  const globalRootDir = input.globalRootDir ?? resolveGlobalBrewvaRootDir();
  appendDiscoveredRoot(roots, rootIndexBySkillDir, globalRootDir, "global_root");

  const projectRoot = resolveProjectBrewvaRootDir(input.cwd);
  appendDiscoveredRoot(roots, rootIndexBySkillDir, projectRoot, "project_root");

  for (const configured of input.configuredRoots ?? []) {
    if (typeof configured !== "string") continue;
    const trimmed = configured.trim();
    if (!trimmed) continue;
    appendDiscoveredRoot(
      roots,
      rootIndexBySkillDir,
      resolve(input.cwd, trimmed),
      "config_root",
    );
  }

  return roots;
}

function isContainedWithin(candidate: string, container: string): boolean {
  const resolved = resolve(candidate);
  const base = resolve(container);
  return resolved === base || resolved.startsWith(base + "/");
}

function listSkillFiles(rootDir: string): string[] {
  if (!isDirectory(rootDir)) return [];
  const resolvedRoot = resolve(rootDir);
  const out: string[] = [];

  const walk = (dir: string, allowRootMarkdown: boolean): void => {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const real = realpathSync(full);
          if (!isContainedWithin(real, resolvedRoot)) continue;
          const st = statSync(real);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        walk(full, false);
        continue;
      }
      if (!isFile) continue;
      const isRootMd = allowRootMarkdown && entry.name.endsWith(".md");
      const isSkillMd = !allowRootMarkdown && entry.name === "SKILL.md";
      if (isRootMd || isSkillMd) {
        out.push(full);
      }
    }
  };

  walk(resolvedRoot, true);
  return out;
}

export interface SkillRegistryOptions {
  rootDir: string;
  config: BrewvaConfig;
  roots?: SkillRegistryRoot[];
}

export class SkillRegistry {
  private readonly rootDir: string;
  private readonly config: BrewvaConfig;
  private readonly rootsOverride?: SkillRegistryRoot[];
  private loadedRoots: SkillRegistryRoot[] = [];
  private skills = new Map<string, SkillDocument>();

  constructor(options: SkillRegistryOptions) {
    this.rootDir = options.rootDir;
    this.config = options.config;
    this.rootsOverride = options.roots;
  }

  load(): void {
    this.skills.clear();

    const discoveredRoots = this.rootsOverride ?? discoverSkillRegistryRoots({
      cwd: this.rootDir,
      configuredRoots: this.config.skills.roots ?? [],
    });
    this.loadedRoots = discoveredRoots.map((entry) => ({ ...entry }));

    const activePacks = new Set(this.config.skills.packs);
    for (const root of discoveredRoots) {
      this.loadRoot(root.skillDir, root.source, activePacks);
    }

    for (const disabled of this.config.skills.disabled) {
      this.skills.delete(disabled);
    }

    for (const [name, override] of Object.entries(this.config.skills.overrides)) {
      const skill = this.skills.get(name);
      if (!skill) continue;
      skill.contract = tightenContract(skill.contract, override);
    }
  }

  list(): SkillDocument[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillDocument | undefined {
    return this.skills.get(name);
  }

  getLoadedRoots(): SkillRegistryRoot[] {
    return this.loadedRoots.map((entry) => ({ ...entry }));
  }

  buildIndex(): SkillsIndexEntry[] {
    return this.list().map((skill) => ({
      name: skill.name,
      tier: skill.tier,
      description: skill.description,
      tags: skill.contract.tags,
      antiTags: skill.contract.antiTags ?? [],
      toolsRequired: skill.contract.tools.required,
      costHint: skill.contract.costHint ?? "medium",
      stability: skill.contract.stability ?? "stable",
      composableWith: skill.contract.composableWith ?? [],
      consumes: skill.contract.consumes ?? [],
    }));
  }

  writeIndex(filePath = join(resolveProjectBrewvaRootDir(this.rootDir), "skills_index.json")): string {
    const parent = dirname(filePath);
    if (parent && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      roots: this.getLoadedRoots(),
      skills: this.buildIndex(),
    };
    writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return filePath;
  }

  private loadRoot(
    skillDir: string,
    source: SkillRootSource,
    activePacks: Set<string>,
  ): void {
    this.loadTier("base", join(skillDir, "base"));

    const packsDir = join(skillDir, "packs");
    if (isDirectory(packsDir)) {
      let entries: Array<import("node:fs").Dirent>;
      try {
        entries = readdirSync(packsDir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      const includeAllPacks =
        source === "project_root" || source === "config_root";
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!includeAllPacks && !activePacks.has(entry.name)) continue;
        this.loadTier("pack", join(packsDir, entry.name));
      }
    }

    this.loadTier("project", join(skillDir, "project"));
  }

  private loadTier(tier: SkillTier, dir: string): void {
    const files = listSkillFiles(dir);
    for (const filePath of files) {
      const parsed = parseSkillDocument(filePath, tier);
      const existing = this.skills.get(parsed.name);
      if (!existing) {
        this.skills.set(parsed.name, parsed);
        continue;
      }
      if (TIER_PRIORITY[parsed.tier] >= TIER_PRIORITY[existing.tier]) {
        parsed.contract = tightenContract(existing.contract, parsed.contract);
        this.skills.set(parsed.name, parsed);
      }
    }
  }
}
