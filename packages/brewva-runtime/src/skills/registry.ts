import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatISO } from "date-fns";
import { resolveGlobalBrewvaRootDir, resolveProjectBrewvaRootDir } from "../config/paths.js";
import type {
  BrewvaConfig,
  SkillCategory,
  SkillDocument,
  SkillRoutingScope,
  SkillsIndexEntry,
} from "../types.js";
import {
  createEmptySkillResources,
  mergeOverlayContract,
  mergeSkillResources,
  parseSkillDocument,
  tightenContract,
} from "./contract.js";
import {
  getSkillCostHint,
  listSkillAllowedEffects,
  listSkillFallbackTools,
  listSkillOutputs,
  listSkillPreferredTools,
  resolveSkillEffectLevel,
} from "./facets.js";
const LOADABLE_SKILL_CATEGORIES: SkillCategory[] = [
  "core",
  "domain",
  "operator",
  "meta",
  "internal",
];

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

export interface SkillRegistryLoadReport {
  roots: SkillRegistryRoot[];
  routingEnabled: boolean;
  routingScopes: SkillRoutingScope[];
  routableSkills: string[];
  hiddenSkills: string[];
  overlaySkills: string[];
  sharedContextFiles: string[];
  categories: Partial<Record<SkillCategory, string[]>>;
}

interface SharedContextEntry {
  filePath: string;
  markdown: string;
}

function cloneSkillRegistryRoot(entry: SkillRegistryRoot): SkillRegistryRoot {
  return {
    rootDir: entry.rootDir,
    skillDir: entry.skillDir,
    source: entry.source,
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasSkillCategoryDirectories(skillDir: string): boolean {
  return (
    LOADABLE_SKILL_CATEGORIES.some((category) => isDirectory(join(skillDir, category))) ||
    isDirectory(join(skillDir, "project"))
  );
}

function resolveSkillDirectory(rootDir: string): string | undefined {
  const normalizedRoot = resolve(rootDir);
  const direct = normalizedRoot;
  const nested = join(normalizedRoot, "skills");
  if (hasSkillCategoryDirectories(direct)) return direct;
  if (hasSkillCategoryDirectories(nested)) return nested;
  return undefined;
}

const MAX_ANCESTOR_DEPTH = 10;

function collectBoundedAncestors(startDir: string): string[] {
  const out: string[] = [];
  let current = resolve(startDir);
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
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
    const moduleAncestors = collectBoundedAncestors(dirname(modulePath)).toReversed();
    for (const ancestor of moduleAncestors) {
      appendDiscoveredRoot(roots, rootIndexBySkillDir, ancestor, "module_ancestor");
    }
  }

  const execPath = input.execPath ?? process.execPath;
  if (typeof execPath === "string" && execPath.trim().length > 0) {
    const execAncestors = collectBoundedAncestors(dirname(resolve(execPath))).toReversed();
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
    appendDiscoveredRoot(roots, rootIndexBySkillDir, resolve(input.cwd, trimmed), "config_root");
  }

  return roots;
}

function isContainedWithin(candidate: string, container: string): boolean {
  const resolved = resolve(candidate);
  const base = resolve(container);
  return resolved === base || resolved.startsWith(base + "/");
}

function walkFiles(
  rootDir: string,
  predicate: (path: string, allowRootMarkdown: boolean) => boolean,
): string[] {
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
      if (predicate(full, allowRootMarkdown)) {
        out.push(full);
      }
    }
  };

  walk(resolvedRoot, true);
  return out;
}

function listSkillFiles(rootDir: string): string[] {
  return walkFiles(rootDir, (path) => basename(path) === "SKILL.md").toSorted((a, b) =>
    a.localeCompare(b),
  );
}

function listMarkdownFiles(rootDir: string): string[] {
  return walkFiles(rootDir, (path) => path.endsWith(".md")).toSorted((a, b) => a.localeCompare(b));
}

function joinMarkdownSections(sections: string[]): string {
  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join("\n\n");
}

function renderSharedContext(entries: SharedContextEntry[]): string {
  if (entries.length === 0) return "";
  const sections = entries.map((entry) => {
    const title = basename(entry.filePath).replace(/\.md$/i, "");
    return `## Project Context: ${title}\n\n${entry.markdown.trim()}`;
  });
  return joinMarkdownSections(sections);
}

function cloneLoadReport(report: SkillRegistryLoadReport): SkillRegistryLoadReport {
  return {
    roots: report.roots.map(cloneSkillRegistryRoot),
    routingEnabled: report.routingEnabled,
    routingScopes: [...report.routingScopes],
    routableSkills: [...report.routableSkills],
    hiddenSkills: [...report.hiddenSkills],
    overlaySkills: [...report.overlaySkills],
    sharedContextFiles: [...report.sharedContextFiles],
    categories: Object.fromEntries(
      Object.entries(report.categories).map(([key, value]) => [key, [...(value ?? [])]]),
    ) as SkillRegistryLoadReport["categories"],
  };
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
  private lastLoadReport: SkillRegistryLoadReport = {
    roots: [],
    routingEnabled: false,
    routingScopes: ["core", "domain"],
    routableSkills: [],
    hiddenSkills: [],
    overlaySkills: [],
    sharedContextFiles: [],
    categories: {},
  };
  private skills = new Map<string, SkillDocument>();
  private sharedContextEntries: SharedContextEntry[] = [];

  constructor(options: SkillRegistryOptions) {
    this.rootDir = options.rootDir;
    this.config = options.config;
    this.rootsOverride = options.roots;
  }

  load(): void {
    this.skills.clear();
    this.sharedContextEntries = [];

    const discoveredRoots =
      this.rootsOverride ??
      discoverSkillRegistryRoots({
        cwd: this.rootDir,
        configuredRoots: this.config.skills.roots ?? [],
      });
    this.loadedRoots = discoveredRoots.map(cloneSkillRegistryRoot);

    for (const root of discoveredRoots) {
      this.loadRoot(root);
    }

    for (const disabled of this.config.skills.disabled) {
      this.skills.delete(disabled);
    }

    for (const [name, override] of Object.entries(this.config.skills.overrides)) {
      const skill = this.skills.get(name);
      if (!skill) continue;
      skill.contract = tightenContract(skill.contract, override);
    }

    this.lastLoadReport = this.buildLoadReport();
  }

  list(): SkillDocument[] {
    return [...this.skills.values()].toSorted((left, right) => left.name.localeCompare(right.name));
  }

  get(name: string): SkillDocument | undefined {
    return this.skills.get(name);
  }

  getLoadedRoots(): SkillRegistryRoot[] {
    return this.loadedRoots.map(cloneSkillRegistryRoot);
  }

  getLoadReport(): SkillRegistryLoadReport {
    return cloneLoadReport(this.lastLoadReport);
  }

  buildIndex(options: { includeHidden?: boolean } = {}): SkillsIndexEntry[] {
    return this.list()
      .filter((skill) => options.includeHidden === true || this.isRoutable(skill))
      .map((skill) => ({
        name: skill.name,
        category: skill.category,
        description: skill.description,
        outputs: listSkillOutputs(skill.contract),
        preferredTools: listSkillPreferredTools(skill.contract),
        fallbackTools: listSkillFallbackTools(skill.contract),
        allowedEffects: listSkillAllowedEffects(skill.contract),
        costHint: getSkillCostHint(skill.contract),
        stability: skill.contract.stability ?? "stable",
        composableWith: skill.contract.composableWith ?? [],
        consumes: skill.contract.consumes ?? [],
        requires: skill.contract.requires ?? [],
        effectLevel: resolveSkillEffectLevel(skill.contract),
        dispatch: {
          suggestThreshold: skill.contract.dispatch?.suggestThreshold ?? 10,
          autoThreshold: skill.contract.dispatch?.autoThreshold ?? 16,
        },
        routingScope: skill.contract.routing?.scope,
      }));
  }

  writeIndex(
    filePath = join(resolveProjectBrewvaRootDir(this.rootDir), "skills_index.json"),
  ): string {
    const parent = dirname(filePath);
    if (parent && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    const payload = {
      generatedAt: formatISO(Date.now()),
      roots: this.getLoadedRoots(),
      routing: {
        enabled: this.config.skills.routing.enabled,
        scopes: this.config.skills.routing.scopes,
      },
      skills: this.buildIndex(),
    };
    writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return filePath;
  }

  private isRoutable(skill: SkillDocument): boolean {
    if (!this.config.skills.routing.enabled) return false;
    const scope = skill.contract.routing?.scope;
    if (!scope) return false;
    return this.config.skills.routing.scopes.includes(scope);
  }

  private buildLoadReport(): SkillRegistryLoadReport {
    const categories: SkillRegistryLoadReport["categories"] = {};
    const routableSkills: string[] = [];
    const hiddenSkills: string[] = [];
    const overlaySkills: string[] = [];

    for (const skill of this.list()) {
      const categoryBucket = categories[skill.category] ?? [];
      categoryBucket.push(skill.name);
      categories[skill.category] = categoryBucket;
      if (this.isRoutable(skill)) {
        routableSkills.push(skill.name);
      } else {
        hiddenSkills.push(skill.name);
      }
      if (skill.overlayFiles.length > 0) {
        overlaySkills.push(skill.name);
      }
    }

    for (const category of Object.keys(categories) as SkillCategory[]) {
      categories[category] = [...new Set(categories[category] ?? [])].toSorted((a, b) =>
        a.localeCompare(b),
      );
    }

    return {
      roots: this.getLoadedRoots(),
      routingEnabled: this.config.skills.routing.enabled,
      routingScopes: [...this.config.skills.routing.scopes],
      routableSkills: [...new Set(routableSkills)].toSorted((a, b) => a.localeCompare(b)),
      hiddenSkills: [...new Set(hiddenSkills)].toSorted((a, b) => a.localeCompare(b)),
      overlaySkills: [...new Set(overlaySkills)].toSorted((a, b) => a.localeCompare(b)),
      sharedContextFiles: [
        ...new Set(this.sharedContextEntries.map((entry) => entry.filePath)),
      ].toSorted((a, b) => a.localeCompare(b)),
      categories,
    };
  }

  private loadRoot(root: SkillRegistryRoot): void {
    const { skillDir } = root;
    for (const category of LOADABLE_SKILL_CATEGORIES) {
      this.loadCategory(category, join(skillDir, category));
    }

    const sharedEntries = this.loadSharedContext(join(skillDir, "project", "shared"));
    if (sharedEntries.length > 0) {
      this.sharedContextEntries.push(...sharedEntries);
    }
    this.loadOverlays(join(skillDir, "project", "overlays"));
  }

  private loadCategory(category: SkillCategory, dir: string): void {
    const files = listSkillFiles(dir);
    for (const filePath of files) {
      const parsed = parseSkillDocument(filePath, category);
      const existing = this.skills.get(parsed.name);
      if (existing) {
        throw new Error(
          `[skill_registry] ${filePath}: duplicate skill name '${parsed.name}' conflicts with '${existing.filePath}'. Skill names must be globally unique across loaded roots and categories; use a project overlay for same-name specialization.`,
        );
      }
      this.skills.set(parsed.name, parsed);
    }
  }

  private loadSharedContext(dir: string): SharedContextEntry[] {
    return listMarkdownFiles(dir).map((filePath) => ({
      filePath,
      markdown: readFileSync(filePath, "utf8").trim(),
    }));
  }

  private loadOverlays(dir: string): void {
    const overlayFiles = listSkillFiles(dir);
    for (const filePath of overlayFiles) {
      const overlay = parseSkillDocument(filePath, "overlay");
      const baseSkill = this.skills.get(overlay.name);
      if (!baseSkill) {
        throw new Error(
          `[skill_overlay] ${filePath}: overlay target '${overlay.name}' was not loaded before overlay application.`,
        );
      }

      const sharedMarkdown = renderSharedContext(this.sharedContextEntries);
      const mergedMarkdown = joinMarkdownSections([
        sharedMarkdown,
        baseSkill.markdown,
        overlay.markdown,
      ]);
      const mergedResources = mergeSkillResources(
        mergeSkillResources(baseSkill.resources, overlay.resources),
        {
          ...createEmptySkillResources(),
          references: this.sharedContextEntries.map((entry) => entry.filePath),
        },
      );

      this.skills.set(overlay.name, {
        ...baseSkill,
        markdown: mergedMarkdown,
        contract: mergeOverlayContract(baseSkill.contract, overlay.contract),
        resources: mergedResources,
        sharedContextFiles: [
          ...new Set([
            ...baseSkill.sharedContextFiles,
            ...this.sharedContextEntries.map((entry) => entry.filePath),
          ]),
        ],
        overlayFiles: [...new Set([...baseSkill.overlayFiles, filePath])],
      });
    }
  }
}
