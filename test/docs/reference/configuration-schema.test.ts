import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_ROASTER_CONFIG } from "@pi-roaster/roaster-runtime";

type SchemaObject = Record<string, unknown>;

function getObject(value: unknown): SchemaObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as SchemaObject;
}

describe("roaster config schema", () => {
  it("covers all top-level RoasterConfig keys", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const schemaPath = resolve(repoRoot, "packages/roaster-runtime/schema/roaster.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as SchemaObject;

    expect(schema.$schema).toBeDefined();
    expect(schema.$ref).toBeDefined();

    const definitions = getObject(schema.definitions);
    expect(definitions).toBeDefined();

    const roasterConfig = getObject(definitions?.RoasterConfig);
    expect(roasterConfig).toBeDefined();

    const properties = getObject(roasterConfig?.properties);
    expect(properties).toBeDefined();

    const keys = Object.keys(DEFAULT_ROASTER_CONFIG);
    const missing = keys.filter((key) => !(key in (properties ?? {})));

    expect(missing, `Missing keys in packages/roaster-runtime/schema/roaster.schema.json: ${missing.join(", ")}`).toEqual(
      [],
    );
  });
});

