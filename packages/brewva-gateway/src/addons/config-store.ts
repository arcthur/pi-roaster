import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AddonConfigDefinition } from "@brewva/brewva-addons";

export type AddonConfigValue = string | number | boolean | undefined;

function matchesAddonConfigDefinition(
  definition: AddonConfigDefinition,
  value: unknown,
): value is string | number | boolean {
  return (
    (definition.type === "string" && typeof value === "string") ||
    (definition.type === "number" && typeof value === "number") ||
    (definition.type === "boolean" && typeof value === "boolean")
  );
}

export class AddonConfigStore {
  constructor(
    private readonly filePath: string,
    private readonly definitions: Record<string, AddonConfigDefinition>,
  ) {}

  async read(): Promise<Record<string, AddonConfigValue>> {
    let raw: unknown = {};
    try {
      raw = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch {
      raw = {};
    }

    const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const resolved: Record<string, AddonConfigValue> = {};

    for (const [key, definition] of Object.entries(this.definitions)) {
      const candidate = input[key];
      if (matchesAddonConfigDefinition(definition, candidate)) {
        resolved[key] = candidate;
        continue;
      }
      resolved[key] = definition.default;
    }

    return resolved;
  }

  async validateRequired(addonId: string): Promise<void> {
    const resolved = await this.read();
    const missing = Object.entries(this.definitions)
      .filter(([, definition]) => definition.required === true)
      .map(([key]) => key)
      .filter((key) => resolved[key] === undefined);

    if (missing.length > 0) {
      throw new Error(
        `missing required config for addon ${addonId}: ${missing.toSorted().join(", ")}`,
      );
    }
  }

  async write(input: Record<string, AddonConfigValue>): Promise<void> {
    const next: Record<string, string | number | boolean> = {};
    for (const [key, definition] of Object.entries(this.definitions)) {
      const value = input[key];
      if (value === undefined) continue;
      if (matchesAddonConfigDefinition(definition, value)) {
        next[key] = value;
      } else {
        throw new Error(`invalid config value for addon ${key}`);
      }
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
}
