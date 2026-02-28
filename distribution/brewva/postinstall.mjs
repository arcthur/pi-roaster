import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getBinaryPath, getPlatformPackage } from "./bin/platform.js";

const NODE_VERSION_RANGE = "^20.19.0 || >=22.12.0";

function parseSemver(versionText) {
  if (typeof versionText !== "string" || versionText.length === 0) return null;
  const normalized = versionText.startsWith("v") ? versionText.slice(1) : versionText;
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(normalized);
  if (!match?.groups) return null;

  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor);
  const patch = Number(match.groups.patch);

  if (!Number.isInteger(major) || major < 0) return null;
  if (!Number.isInteger(minor) || minor < 0) return null;
  if (!Number.isInteger(patch) || patch < 0) return null;

  return { major, minor, patch };
}

function isSupportedNodeVersion(version) {
  if (version.major === 20) return version.minor >= 19;
  if (version.major === 21) return false;
  if (version.major === 22) return version.minor >= 12;
  return version.major > 22;
}

function assertSupportedNodeRuntime() {
  const detected =
    typeof process.versions?.node === "string" ? process.versions.node : process.version;
  const parsed = parseSemver(process.versions?.node ?? process.version);
  if (!parsed || !isSupportedNodeVersion(parsed)) {
    console.error(
      `brewva: unsupported Node.js version ${detected}. Brewva requires Node.js ${NODE_VERSION_RANGE} (ES2023 baseline).`,
    );
    process.exit(1);
  }
}

assertSupportedNodeRuntime();

const require = createRequire(import.meta.url);

const FALLBACK_DEFAULT_PACKS = ["skill-creator", "telegram-interactive-components"];

function buildDefaultGlobalBrewvaConfig(bundledPacks = []) {
  const packs = bundledPacks.length > 0 ? bundledPacks : FALLBACK_DEFAULT_PACKS;
  return {
    ui: {
      quietStartup: true,
    },
    skills: {
      roots: [],
      packs: [...packs],
      disabled: [],
      overrides: {},
      selector: {
        k: 4,
      },
    },
  };
}

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
  const fromBrewva =
    typeof env["BREWVA_CODING_AGENT_DIR"] === "string" ? env["BREWVA_CODING_AGENT_DIR"] : "";
  if (fromBrewva.trim().length > 0) {
    return resolve(resolveMaybeAbsolute(process.cwd(), fromBrewva), "..");
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

function seedGlobalConfig(globalRoot, defaultConfig) {
  mkdirSync(globalRoot, { recursive: true });
  const configPath = join(globalRoot, "brewva.json");

  if (!existsSync(configPath)) {
    writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
    console.log(`brewva: created global config at ${configPath}`);
    return;
  }

  try {
    const existing = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isRecord(existing)) {
      console.warn(`brewva: skipped renewing config (not an object): ${configPath}`);
      return;
    }
    const merged = deepMerge(defaultConfig, existing);
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

function toPortableRelPath(pathText) {
  return pathText.split(sep).join("/");
}

function listBundledSkillFiles(sourceSkillsDir) {
  const out = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(toPortableRelPath(relative(sourceSkillsDir, full)));
    }
  };
  walk(sourceSkillsDir);
  return out.toSorted((a, b) => a.localeCompare(b));
}

function listBundledPackNames(sourceSkillsDir) {
  const packsDir = join(sourceSkillsDir, "packs");
  if (!existsSync(packsDir)) return [];
  const entries = readdirSync(packsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b));
}

function readSkillsManifest(manifestPath) {
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const files = parsed.files;
    if (!Array.isArray(files)) return undefined;
    return files.filter((entry) => typeof entry === "string" && entry.length > 0);
  } catch {
    return undefined;
  }
}

function writeSkillsManifest(manifestPath, files) {
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function seedGlobalSkills(globalRoot, runtimeBinaryPath) {
  const sourceSkillsDir = join(dirname(runtimeBinaryPath), "skills");
  if (!existsSync(sourceSkillsDir)) {
    console.warn(`brewva: bundled skills not found at ${sourceSkillsDir}`);
    return;
  }
  const targetSkillsDir = join(globalRoot, "skills");
  const manifestPath = join(targetSkillsDir, ".brewva-manifest.json");

  const nextFiles = listBundledSkillFiles(sourceSkillsDir);
  const previousFiles = readSkillsManifest(manifestPath) ?? [];
  const nextFileSet = new Set(nextFiles);

  for (const entry of previousFiles) {
    if (nextFileSet.has(entry)) continue;
    rmSync(join(targetSkillsDir, entry), { recursive: true, force: true });
  }

  copyDirectoryContents(sourceSkillsDir, targetSkillsDir);
  writeSkillsManifest(manifestPath, nextFiles);
  console.log(`brewva: renewed global skills at ${targetSkillsDir}`);
}

function main() {
  const { platform, arch } = process;
  const libcFamily = getLibcFamily();
  const globalRoot = resolveGlobalBrewvaRootDir(process.env);
  let runtimeBinaryPath;

  try {
    const pkg = getPlatformPackage({ platform, arch, libcFamily });
    const binPath = getBinaryPath(pkg, platform);
    runtimeBinaryPath = require.resolve(binPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`brewva: ${message}`);
    console.warn("brewva: platform binary is unavailable on this system.");
  }

  const bundledPacks = runtimeBinaryPath
    ? listBundledPackNames(join(dirname(runtimeBinaryPath), "skills"))
    : [];

  try {
    seedGlobalConfig(globalRoot, buildDefaultGlobalBrewvaConfig(bundledPacks));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`brewva: failed to seed global config: ${message}`);
  }

  if (!runtimeBinaryPath) {
    return;
  }

  try {
    seedGlobalSkills(globalRoot, runtimeBinaryPath);
    console.log(`brewva: installed platform binary for ${platform}-${arch}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`brewva: failed to seed global skills: ${message}`);
  }
}

main();
