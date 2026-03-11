import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrewvaAddonDefinition } from "@brewva/brewva-addons";

const ADDON_ENTRYPOINT_CANDIDATES = [
  "index.js",
  "index.mjs",
  "index.cjs",
  "index.ts",
  "index.mts",
  "index.cts",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
}

function assertConfigDefinition(key: string, value: unknown, filePath: string): void {
  if (!isRecord(value)) {
    throw new Error(`addon config '${key}' must be an object: ${filePath}`);
  }
  if (value.type !== "string" && value.type !== "number" && value.type !== "boolean") {
    throw new Error(`addon config '${key}' has invalid type: ${filePath}`);
  }
  assertNonEmptyString(
    value.description,
    `addon config '${key}' requires a description: ${filePath}`,
  );
  if (
    Object.prototype.hasOwnProperty.call(value, "required") &&
    typeof value.required !== "boolean"
  ) {
    throw new Error(`addon config '${key}' has invalid required flag: ${filePath}`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, "default")) {
    return;
  }
  const defaultValue = value.default;
  if (
    (value.type === "string" && typeof defaultValue !== "string") ||
    (value.type === "number" && typeof defaultValue !== "number") ||
    (value.type === "boolean" && typeof defaultValue !== "boolean")
  ) {
    throw new Error(`addon config '${key}' has invalid default value: ${filePath}`);
  }
}

function assertAddonJob(job: unknown, index: number, filePath: string): void {
  if (!isRecord(job)) {
    throw new Error(`addon jobs[${index}] must be an object: ${filePath}`);
  }
  assertNonEmptyString(job.id, `addon jobs[${index}].id is required: ${filePath}`);
  if (!isRecord(job.schedule)) {
    throw new Error(`addon jobs[${index}].schedule must be an object: ${filePath}`);
  }
  const hasCron = typeof job.schedule.cron === "string" && job.schedule.cron.trim().length > 0;
  const hasInterval =
    typeof job.schedule.intervalMs === "number" && Number.isFinite(job.schedule.intervalMs);
  if (!hasCron && !hasInterval) {
    throw new Error(`addon jobs[${index}].schedule requires cron or intervalMs: ${filePath}`);
  }
  if (typeof job.run !== "function") {
    throw new Error(`addon jobs[${index}].run must be a function: ${filePath}`);
  }
}

function assertAddonPanel(panel: unknown, index: number, filePath: string): void {
  if (!isRecord(panel)) {
    throw new Error(`addon panels[${index}] must be an object: ${filePath}`);
  }
  assertNonEmptyString(panel.id, `addon panels[${index}].id is required: ${filePath}`);
  assertNonEmptyString(panel.title, `addon panels[${index}].title is required: ${filePath}`);
  if (typeof panel.render !== "function") {
    throw new Error(`addon panels[${index}].render must be a function: ${filePath}`);
  }
}

function assertAddonDefinition(value: unknown, filePath: string): BrewvaAddonDefinition {
  if (!isRecord(value)) {
    throw new Error(`addon module must export an object: ${filePath}`);
  }
  const addon = value as unknown as BrewvaAddonDefinition;
  assertNonEmptyString(addon.id, `addon id is required: ${filePath}`);

  if (Object.prototype.hasOwnProperty.call(addon, "config")) {
    if (!isRecord(addon.config)) {
      throw new Error(`addon config must be an object: ${filePath}`);
    }
    for (const [key, definition] of Object.entries(addon.config)) {
      assertNonEmptyString(key, `addon config keys must be non-empty: ${filePath}`);
      assertConfigDefinition(key, definition, filePath);
    }
  }

  if (Object.prototype.hasOwnProperty.call(addon, "jobs")) {
    if (!Array.isArray(addon.jobs)) {
      throw new Error(`addon jobs must be an array: ${filePath}`);
    }
    addon.jobs.forEach((job, index) => assertAddonJob(job, index, filePath));
  }

  if (Object.prototype.hasOwnProperty.call(addon, "panels")) {
    if (!Array.isArray(addon.panels)) {
      throw new Error(`addon panels must be an array: ${filePath}`);
    }
    addon.panels.forEach((panel, index) => assertAddonPanel(panel, index, filePath));
  }
  return addon;
}

export async function discoverAddonEntrypoints(addonsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(addonsDir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const candidate of ADDON_ENTRYPOINT_CANDIDATES) {
        const filePath = resolve(addonsDir, entry.name, candidate);
        try {
          const stats = await stat(filePath);
          if (stats.isFile()) {
            files.push(filePath);
            break;
          }
        } catch {
          // Ignore missing candidate entrypoints.
        }
      }
    }
    return files;
  } catch {
    return [];
  }
}

export async function loadAddonModule(filePath: string): Promise<BrewvaAddonDefinition> {
  const moduleRef = await import(pathToFileURL(filePath).href);
  return assertAddonDefinition(moduleRef.default ?? moduleRef.addon ?? moduleRef, filePath);
}
