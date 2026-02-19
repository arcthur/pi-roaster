import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RoasterConfig } from "../types.js";
import { DEFAULT_ROASTER_CONFIG } from "./defaults.js";
import { deepMerge } from "./merge.js";
import { normalizeRoasterConfig } from "./normalize.js";
import {
  resolveGlobalRoasterConfigPath,
  resolveProjectRoasterConfigPath,
} from "./paths.js";

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
}

function resolveConfigRelativeSkillRoots(
  config: Partial<RoasterConfig>,
  configPath: string,
): Partial<RoasterConfig> {
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

function readConfigFile(configPath: string): Partial<RoasterConfig> | undefined {
  if (!existsSync(configPath)) return undefined;
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<RoasterConfig>;
  return resolveConfigRelativeSkillRoots(parsed, configPath);
}

export function loadRoasterConfig(options: LoadConfigOptions = {}): RoasterConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaults = structuredClone(DEFAULT_ROASTER_CONFIG);

  const configPaths = options.configPath
    ? [resolve(cwd, options.configPath)]
    : [
        resolveGlobalRoasterConfigPath(),
        resolveProjectRoasterConfigPath(cwd),
      ];

  let merged = defaults;
  for (const configPath of configPaths) {
    const parsed = readConfigFile(configPath);
    if (!parsed) continue;
    merged = deepMerge(merged, parsed);
  }

  return normalizeRoasterConfig(merged, DEFAULT_ROASTER_CONFIG);
}
