import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const BREWVA_CONFIG_DIR_RELATIVE = ".brewva";
export const BREWVA_CONFIG_FILE_NAME = "brewva.json";

function normalizePathInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function resolveMaybeAbsolute(baseDir: string, pathText: string): string {
  const normalized = normalizePathInput(pathText);
  if (isAbsolute(normalized)) {
    return resolve(normalized);
  }
  return resolve(baseDir, normalized);
}

function resolveAgentDirFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const fromBrewva =
    typeof env["BREWVA_CODING_AGENT_DIR"] === "string" ? env["BREWVA_CODING_AGENT_DIR"] : "";
  if (fromBrewva.trim().length > 0) {
    return resolveMaybeAbsolute(process.cwd(), fromBrewva);
  }

  return undefined;
}

export function resolveGlobalBrewvaRootDir(env: NodeJS.ProcessEnv = process.env): string {
  const agentDirFromEnv = resolveAgentDirFromEnv(env);
  if (agentDirFromEnv) {
    return resolve(agentDirFromEnv, "..");
  }

  const configured = typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME : "";
  if (configured.trim().length > 0) {
    return resolveMaybeAbsolute(process.cwd(), join(configured, "brewva"));
  }
  return resolve(homedir(), ".config", "brewva");
}

export function resolveProjectBrewvaRootDir(cwd: string): string {
  return resolve(cwd, BREWVA_CONFIG_DIR_RELATIVE);
}

export function resolveBrewvaConfigPathForRoot(rootDir: string): string {
  return join(rootDir, BREWVA_CONFIG_FILE_NAME);
}

export function resolveGlobalBrewvaConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBrewvaConfigPathForRoot(resolveGlobalBrewvaRootDir(env));
}

export function resolveProjectBrewvaConfigPath(cwd: string): string {
  return resolveBrewvaConfigPathForRoot(resolveProjectBrewvaRootDir(cwd));
}

export function resolveBrewvaAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalBrewvaRootDir(env), "agent");
}

function findAncestor(startDir: string, predicate: (dir: string) => boolean): string | undefined {
  let current = resolve(startDir);
  while (true) {
    if (predicate(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function hasBrewvaConfigRoot(dir: string): boolean {
  return existsSync(resolveBrewvaConfigPathForRoot(resolveProjectBrewvaRootDir(dir)));
}

function hasGitRootMarker(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

export function resolveWorkspaceRootDir(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  return (
    findAncestor(resolvedCwd, (dir) => hasBrewvaConfigRoot(dir) || hasGitRootMarker(dir)) ??
    resolvedCwd
  );
}
