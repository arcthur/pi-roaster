import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RoasterConfig, SkillDocument, SkillTier, SkillsIndexEntry } from "../types.js";
import { parseSkillDocument, tightenContract } from "./contract.js";

const TIER_PRIORITY: Record<SkillTier, number> = {
  base: 1,
  pack: 2,
  project: 3,
};

function listSkillFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const out: string[] = [];

  const walk = (dir: string, allowRootMarkdown: boolean): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = statSync(full);
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

  walk(rootDir, true);
  return out;
}

export interface SkillRegistryOptions {
  rootDir: string;
  config: RoasterConfig;
}

export class SkillRegistry {
  private readonly rootDir: string;
  private readonly config: RoasterConfig;
  private skills = new Map<string, SkillDocument>();

  constructor(options: SkillRegistryOptions) {
    this.rootDir = options.rootDir;
    this.config = options.config;
  }

  load(): void {
    this.skills.clear();

    this.loadTier("base", join(this.rootDir, "skills/base"));

    const activePacks = new Set(this.config.skills.packs);
    const packsDir = join(this.rootDir, "skills/packs");
    if (existsSync(packsDir)) {
      const entries = readdirSync(packsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!activePacks.has(entry.name)) continue;
        this.loadTier("pack", join(packsDir, entry.name));
      }
    }

    this.loadTier("project", join(this.rootDir, "skills/project"));

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

  writeIndex(filePath = join(this.rootDir, ".pi/skills_index.json")): string {
    const parent = dirname(filePath);
    if (parent && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      skills: this.buildIndex(),
    };
    writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return filePath;
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
