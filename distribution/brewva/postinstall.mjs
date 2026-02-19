import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getBinaryPath, getPlatformPackage } from "./bin/platform.js";

const require = createRequire(import.meta.url);

const DEFAULT_GLOBAL_BREWVA_CONFIG = {
  skills: {
    roots: [],
    packs: ["typescript", "react", "bun"],
    disabled: [],
    overrides: {},
    selector: {
      k: 4,
      maxDigestTokens: 1200,
    },
  },
};

function getLibcFamily() {
  if (process.platform !== "linux") {
    return undefined;
  }

  try {
    const detectLibc = require("detect-libc");
    return detectLibc.familySync();
  } catch {
    return null;
  }
}

function normalizePathInput(input) {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function resolveMaybeAbsolute(baseDir, pathText) {
  const normalized = normalizePathInput(pathText);
  if (isAbsolute(normalized)) {
    return resolve(normalized);
  }
  return resolve(baseDir, normalized);
}

function resolveGlobalBrewvaRootDir(env = process.env) {
  const fromBrewva = typeof env["BREWVA_CODING_AGENT_DIR"] === "string"
    ? env["BREWVA_CODING_AGENT_DIR"]
    : "";
  if (fromBrewva.trim().length > 0) {
    return resolve(resolveMaybeAbsolute(process.cwd(), fromBrewva), "..");
  }

  const fromPi = typeof env.PI_CODING_AGENT_DIR === "string" ? env.PI_CODING_AGENT_DIR : "";
  if (fromPi.trim().length > 0) {
    return resolve(resolveMaybeAbsolute(process.cwd(), fromPi), "..");
  }

  const configured = typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME : "";
  if (configured.trim().length > 0) {
    return resolveMaybeAbsolute(process.cwd(), join(configured, "brewva"));
  }
  return resolve(homedir(), ".config", "brewva");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, override) {
  if (!isRecord(base)) return cloneJsonValue(override);
  if (!isRecord(override)) return cloneJsonValue(base);

  const result = cloneJsonValue(base);
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMerge(current, value);
      continue;
    }
    result[key] = cloneJsonValue(value);
  }
  return result;
}

function seedGlobalConfig(globalRoot) {
  mkdirSync(globalRoot, { recursive: true });
  const configPath = join(globalRoot, "brewva.json");

  if (!existsSync(configPath)) {
    writeFileSync(configPath, `${JSON.stringify(DEFAULT_GLOBAL_BREWVA_CONFIG, null, 2)}\n`, "utf8");
    console.log(`brewva: created global config at ${configPath}`);
    return;
  }

  try {
    const existing = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isRecord(existing)) {
      console.warn(`brewva: skipped renewing config (not an object): ${configPath}`);
      return;
    }
    const merged = deepMerge(DEFAULT_GLOBAL_BREWVA_CONFIG, existing);
    writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    console.log(`brewva: renewed global config at ${configPath}`);
  } catch {
    console.warn(`brewva: skipped renewing config (invalid JSON): ${configPath}`);
  }
}

function copyDirectoryContents(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    cpSync(source, target, { recursive: true, force: true });
  }
}

function seedGlobalSkills(globalRoot, runtimeBinaryPath) {
  const sourceSkillsDir = join(dirname(runtimeBinaryPath), "skills");
  if (!existsSync(sourceSkillsDir)) {
    console.warn(`brewva: bundled skills not found at ${sourceSkillsDir}`);
    return;
  }
  const targetSkillsDir = join(globalRoot, "skills");
  copyDirectoryContents(sourceSkillsDir, targetSkillsDir);
  console.log(`brewva: renewed global skills at ${targetSkillsDir}`);
}

function main() {
  const { platform, arch } = process;
  const libcFamily = getLibcFamily();
  const globalRoot = resolveGlobalBrewvaRootDir(process.env);

  try {
    seedGlobalConfig(globalRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`brewva: failed to seed global config: ${message}`);
  }

  try {
    const pkg = getPlatformPackage({ platform, arch, libcFamily });
    const binPath = getBinaryPath(pkg, platform);
    const runtimeBinaryPath = require.resolve(binPath);
    seedGlobalSkills(globalRoot, runtimeBinaryPath);
    console.log(`brewva: installed platform binary for ${platform}-${arch}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`brewva: ${message}`);
    console.warn("brewva: platform binary is unavailable on this system.");
  }
}

main();
