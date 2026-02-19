import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrewvaConfig } from "../types.js";
import { DEFAULT_BREWVA_CONFIG } from "./defaults.js";
import { deepMerge } from "./merge.js";
import { normalizeBrewvaConfig } from "./normalize.js";
import {
  resolveGlobalBrewvaConfigPath,
  resolveProjectBrewvaConfigPath,
} from "./paths.js";

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
}

function resolveConfigRelativeSkillRoots(
  config: Partial<BrewvaConfig>,
  configPath: string,
): Partial<BrewvaConfig> {
  const skills = config.skills;
  if (!skills) {
    return config;
  }

  const skillRoots = skills.roots;
  if (!Array.isArray(skillRoots) || skillRoots.length === 0) {
    return config;
  }

  const baseDir = dirname(configPath);
  return {
    ...config,
    skills: {
      ...skills,
      roots: skillRoots.map((entry) => {
        if (typeof entry !== "string") return entry;
        const trimmed = entry.trim();
        if (!trimmed) return entry;
        return resolve(baseDir, trimmed);
      }),
    },
  };
}

function readConfigFile(configPath: string): Partial<BrewvaConfig> | undefined {
  if (!existsSync(configPath)) return undefined;
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<BrewvaConfig>;
  return resolveConfigRelativeSkillRoots(parsed, configPath);
}

export function loadBrewvaConfig(options: LoadConfigOptions = {}): BrewvaConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaults = structuredClone(DEFAULT_BREWVA_CONFIG);

  const configPaths = options.configPath
    ? [resolve(cwd, options.configPath)]
    : [
        resolveGlobalBrewvaConfigPath(),
        resolveProjectBrewvaConfigPath(cwd),
      ];

  let merged = defaults;
  for (const configPath of configPaths) {
    const parsed = readConfigFile(configPath);
    if (!parsed) continue;
    merged = deepMerge(merged, parsed);
  }

  return normalizeBrewvaConfig(merged, DEFAULT_BREWVA_CONFIG);
}
