import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrewvaConfig } from "../types.js";
import { DEFAULT_BREWVA_CONFIG } from "./defaults.js";
import { deepMerge } from "./merge.js";
import { normalizeBrewvaConfig } from "./normalize.js";
import { validateBrewvaConfigFile } from "./validate.js";
import {
  resolveGlobalBrewvaConfigPath,
  resolveProjectBrewvaConfigPath,
} from "./paths.js";

export type BrewvaConfigDiagnosticLevel = "warn" | "error";

export interface BrewvaConfigDiagnostic {
  level: BrewvaConfigDiagnosticLevel;
  code: "config_parse_error" | "config_not_object" | "config_schema_unavailable" | "config_schema_invalid";
  message: string;
  configPath: string;
}

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function stripMetaFields(value: Record<string, unknown>): Record<string, unknown> {
  const output = { ...value };
  // Used for editor completion/validation, ignored by runtime.
  delete output["$schema"];
  return output;
}

function readConfigFile(configPath: string, diagnostics: BrewvaConfigDiagnostic[]): Partial<BrewvaConfig> | undefined {
  if (!existsSync(configPath)) return undefined;
  let parsed: unknown;
  try {
    const raw = readFileSync(configPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push({
      level: "error",
      code: "config_parse_error",
      message: `Failed to parse config JSON: ${message}`,
      configPath,
    });
    return undefined;
  }

  if (!isRecord(parsed)) {
    diagnostics.push({
      level: "error",
      code: "config_not_object",
      message: "Config must be a JSON object at the top-level.",
      configPath,
    });
    return undefined;
  }

  const validation = validateBrewvaConfigFile(parsed);
  if (!validation.ok) {
    if (validation.error) {
      diagnostics.push({
        level: "warn",
        code: "config_schema_unavailable",
        message: `Schema validation is unavailable: ${validation.error}`,
        configPath,
      });
    }
    for (const error of validation.errors) {
      diagnostics.push({
        level: "warn",
        code: "config_schema_invalid",
        message: `Config does not match schema: ${error}`,
        configPath,
      });
    }
  }

  const cleaned = stripMetaFields(parsed);
  return resolveConfigRelativeSkillRoots(cleaned as Partial<BrewvaConfig>, configPath);
}

export function loadBrewvaConfigWithDiagnostics(options: LoadConfigOptions = {}): {
  config: BrewvaConfig;
  diagnostics: BrewvaConfigDiagnostic[];
} {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaults = structuredClone(DEFAULT_BREWVA_CONFIG);
  const diagnostics: BrewvaConfigDiagnostic[] = [];

  const configPaths = options.configPath
    ? [resolve(cwd, options.configPath)]
    : [
        resolveGlobalBrewvaConfigPath(),
        resolveProjectBrewvaConfigPath(cwd),
      ];

  let merged = defaults;
  for (const configPath of configPaths) {
    const parsed = readConfigFile(configPath, diagnostics);
    if (!parsed) continue;
    merged = deepMerge(merged, parsed);
  }

  return {
    config: normalizeBrewvaConfig(merged, DEFAULT_BREWVA_CONFIG),
    diagnostics,
  };
}

export function loadBrewvaConfig(options: LoadConfigOptions = {}): BrewvaConfig {
  return loadBrewvaConfigWithDiagnostics(options).config;
}
