import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type SchemaObject = Record<string, unknown>;

let cachedSchema: { schema: SchemaObject; schemaPath: string } | null = null;
let cachedError: Error | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveSchemaPath(): string | undefined {
  const overridePath = typeof process.env.BREWVA_CONFIG_SCHEMA_PATH === "string"
    ? process.env.BREWVA_CONFIG_SCHEMA_PATH.trim()
    : "";
  if (overridePath.length > 0) {
    return resolve(process.cwd(), overridePath);
  }

  const execCandidate = join(dirname(process.execPath), "brewva.schema.json");
  if (existsSync(execCandidate)) return execCandidate;

  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const packageCandidate = resolve(moduleDir, "../../schema/brewva.schema.json");
    if (existsSync(packageCandidate)) return packageCandidate;
  } catch {
    // ignore import.meta.url resolution errors (e.g. bundled/compiled runtime)
  }

  return undefined;
}

export function loadBrewvaConfigSchema(): { ok: true; schema: SchemaObject; schemaPath: string } | { ok: false; error: Error } {
  if (cachedSchema) {
    return { ok: true, schema: cachedSchema.schema, schemaPath: cachedSchema.schemaPath };
  }
  if (cachedError) {
    return { ok: false, error: cachedError };
  }

  const schemaPath = resolveSchemaPath();
  if (!schemaPath) {
    cachedError = new Error("Config schema file not found.");
    return { ok: false, error: cachedError };
  }

  try {
    const parsed = JSON.parse(readFileSync(schemaPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      cachedError = new Error(`Config schema is not a JSON object: ${schemaPath}`);
      return { ok: false, error: cachedError };
    }
    cachedSchema = { schema: parsed, schemaPath };
    return { ok: true, schema: parsed, schemaPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cachedError = new Error(`Failed to load config schema (${schemaPath}): ${message}`);
    return { ok: false, error: cachedError };
  }
}

