import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

type SchemaObject = Record<string, unknown>;

function getObject(value: unknown): SchemaObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as SchemaObject;
}

describe("brewva config schema", () => {
  it("covers all top-level BrewvaConfig keys", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const schemaPath = resolve(repoRoot, "packages/brewva-runtime/schema/brewva.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as SchemaObject;

    expect(schema.$schema).toBeDefined();
    expect(schema.$ref).toBeDefined();

    const definitions = getObject(schema.definitions);
    expect(definitions).toBeDefined();

    const brewvaConfig = getObject(definitions?.BrewvaConfig);
    expect(brewvaConfig).toBeDefined();

    const properties = getObject(brewvaConfig?.properties);
    expect(properties).toBeDefined();

    const keys = Object.keys(DEFAULT_BREWVA_CONFIG);
    const missing = keys.filter((key) => !(key in (properties ?? {})));

    expect(missing, `Missing keys in packages/brewva-runtime/schema/brewva.schema.json: ${missing.join(", ")}`).toEqual(
      [],
    );
  });
});

