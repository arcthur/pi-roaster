import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { loadBrewvaConfigSchema } from "./schema.js";

let cachedValidator: { validate: ValidateFunction<unknown>; schemaPath: string } | null = null;
let cachedError: Error | null = null;

function formatError(error: ErrorObject): string {
  const instancePath = error.instancePath && error.instancePath.length > 0 ? error.instancePath : "/";
  if (error.keyword === "additionalProperties") {
    const additionalProperty = (error.params as { additionalProperty?: unknown } | undefined)?.additionalProperty;
    if (typeof additionalProperty === "string" && additionalProperty.length > 0) {
      return `${instancePath}: unknown property "${additionalProperty}"`;
    }
  }
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "invalid value";
  return `${instancePath}: ${message}`;
}

function getValidator(): { ok: true; validate: ValidateFunction<unknown>; schemaPath: string } | { ok: false; error: Error } {
  if (cachedValidator) return { ok: true, validate: cachedValidator.validate, schemaPath: cachedValidator.schemaPath };
  if (cachedError) return { ok: false, error: cachedError };

  const schemaLoad = loadBrewvaConfigSchema();
  if (!schemaLoad.ok) {
    cachedError = schemaLoad.error;
    return { ok: false, error: cachedError };
  }

  try {
    const ajv = new Ajv({
      allErrors: true,
      allowUnionTypes: true,
      // We want actionable diagnostics, not strict-mode noise.
      strict: false,
    });
    const validate = ajv.compile(schemaLoad.schema);
    cachedValidator = { validate, schemaPath: schemaLoad.schemaPath };
    return { ok: true, validate, schemaPath: schemaLoad.schemaPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cachedError = new Error(`Failed to compile config schema validator: ${message}`);
    return { ok: false, error: cachedError };
  }
}

export interface BrewvaConfigFileValidationResult {
  ok: boolean;
  errors: string[];
  schemaPath?: string;
  error?: string;
}

export function validateBrewvaConfigFile(value: unknown): BrewvaConfigFileValidationResult {
  const validator = getValidator();
  if (!validator.ok) {
    return { ok: false, errors: [], error: validator.error.message };
  }

  const ok = validator.validate(value);
  if (ok) return { ok: true, errors: [], schemaPath: validator.schemaPath };

  const errors = (validator.validate.errors ?? []).map(formatError);
  return { ok: false, errors, schemaPath: validator.schemaPath };
}
