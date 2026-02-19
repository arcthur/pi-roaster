import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type Schema = Record<string, unknown>;

function stableStringify(value: unknown): string {
  const keyOrder = [
    "$schema",
    "$id",
    "$ref",
    "title",
    "description",
    "markdownDescription",
    "type",
    "additionalProperties",
    "properties",
    "required",
    "items",
    "enum",
    "oneOf",
    "anyOf",
    "allOf",
    "patternProperties",
    "definitions",
    "$defs",
  ];
  const keyPriority = new Map<string, number>(keyOrder.map((key, index) => [key, index]));
  const sortKeys = (keys: string[]): string[] =>
    keys.sort((a, b) => {
      const ai = keyPriority.get(a);
      const bi = keyPriority.get(b);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.localeCompare(b);
    });

  const normalize = (input: unknown): unknown => {
    if (!input || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(normalize);

    const record = input as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of sortKeys(Object.keys(record))) {
      output[key] = normalize(record[key]);
    }
    return output;
  };

  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

async function main(): Promise<void> {
  const require = createRequire(import.meta.url);
  const { createGenerator } = require("ts-json-schema-generator") as typeof import("ts-json-schema-generator");

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const tsconfig = resolve(repoRoot, "packages/brewva-runtime/tsconfig.json");
  const typesPath = resolve(repoRoot, "packages/brewva-runtime/src/types.ts");
  const outputPath = resolve(repoRoot, "packages/brewva-runtime/schema/brewva.schema.json");

  const schema = createGenerator({
    tsconfig,
    path: typesPath,
    type: "BrewvaConfig",
    expose: "export",
    jsDoc: "extended",
    additionalProperties: false,
    sortProps: true,
    topRef: true,
    skipTypeCheck: false,
  }).createSchema("BrewvaConfig") as Schema;

  schema.title = "brewva BrewvaConfig";
  schema.description = "JSON Schema for .brewva/brewva.json (Brewva runtime configuration).";

  const parent = dirname(outputPath);
  mkdirSync(parent, { recursive: true });
  writeFileSync(outputPath, stableStringify(schema), "utf8");
}

await main();
