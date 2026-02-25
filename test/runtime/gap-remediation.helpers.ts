import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { createTestConfig, type DeepPartial } from "../fixtures/config.js";
import { createTestWorkspace, writeTestConfig } from "../helpers/workspace.js";

export const GAP_REMEDIATION_CONFIG_PATH = ".config/brewva/brewva.json";

export function createGapRemediationWorkspace(name: string): string {
  return createTestWorkspace(name, { configDir: ".config/brewva" });
}

export function writeGapRemediationConfig(workspace: string, config: BrewvaConfig): void {
  writeTestConfig(workspace, config, GAP_REMEDIATION_CONFIG_PATH);
}

export function createGapRemediationConfig(overrides: DeepPartial<BrewvaConfig>): BrewvaConfig {
  return createTestConfig(overrides);
}
