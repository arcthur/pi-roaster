import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RoasterConfig } from "../types.js";
import { DEFAULT_ROASTER_CONFIG } from "./defaults.js";
import { deepMerge } from "./merge.js";
import { normalizeRoasterConfig } from "./normalize.js";

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
}

function normalizeLegacyConfigAliases(config: Partial<RoasterConfig>): Partial<RoasterConfig> {
  const infrastructure = config.infrastructure;
  if (!infrastructure) return config;

  const interruptRecovery = infrastructure.interruptRecovery;
  if (!interruptRecovery) return config;

  if (typeof interruptRecovery.resumeHintInjectionEnabled === "boolean") {
    return config;
  }
  if (typeof interruptRecovery.resumeHintInSystemPrompt !== "boolean") {
    return config;
  }

  return {
    ...config,
    infrastructure: {
      ...infrastructure,
      interruptRecovery: {
        ...interruptRecovery,
        resumeHintInjectionEnabled: interruptRecovery.resumeHintInSystemPrompt,
      },
    },
  };
}

export function loadRoasterConfig(options: LoadConfigOptions = {}): RoasterConfig {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, options.configPath ?? ".pi/roaster.json");
  const defaults = structuredClone(DEFAULT_ROASTER_CONFIG);
  if (!existsSync(configPath)) {
    return normalizeRoasterConfig(defaults, DEFAULT_ROASTER_CONFIG);
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = normalizeLegacyConfigAliases(JSON.parse(raw) as Partial<RoasterConfig>);
  const merged = deepMerge(defaults, parsed);
  return normalizeRoasterConfig(merged, DEFAULT_ROASTER_CONFIG);
}
