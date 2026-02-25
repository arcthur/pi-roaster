import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaConfig } from "@brewva/brewva-runtime";

export function createTestWorkspace(
  name: string,
  options?: { configDir?: string },
): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  const configDir = options?.configDir ?? ".brewva";
  mkdirSync(join(workspace, configDir), { recursive: true });
  return workspace;
}

export function writeTestConfig(
  workspace: string,
  config: BrewvaConfig,
  configPath?: string,
): void {
  const resolved = configPath ?? ".brewva/brewva.json";
  writeFileSync(join(workspace, resolved), JSON.stringify(config, null, 2), "utf8");
}
