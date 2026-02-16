import type { TaskSpec, VerificationLevel } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function normalizeVerificationLevel(value: unknown): VerificationLevel | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "quick" || value === "standard" || value === "strict") {
    return value;
  }
  return undefined;
}

export function normalizeTaskSpec(input: TaskSpec): TaskSpec {
  const goal = input.goal.trim();
  const expectedBehavior = normalizeNonEmptyString(input.expectedBehavior);
  const constraints = normalizeStringArray(input.constraints);
  const files = normalizeStringArray(input.targets?.files);
  const symbols = normalizeStringArray(input.targets?.symbols);
  const verificationLevel = normalizeVerificationLevel(input.verification?.level);
  const verificationCommands = normalizeStringArray(input.verification?.commands);

  return {
    schema: "roaster.task.v1",
    goal,
    targets:
      files || symbols
        ? {
            files,
            symbols,
          }
        : undefined,
    expectedBehavior,
    constraints,
    verification:
      verificationLevel || verificationCommands
        ? {
            level: verificationLevel,
            commands: verificationCommands,
          }
        : undefined,
  };
}

export function parseTaskSpec(input: unknown): { ok: true; spec: TaskSpec } | { ok: false; error: string } {
  if (typeof input === "string") {
    const goal = input.trim();
    if (!goal) return { ok: false, error: "TaskSpec goal must be a non-empty string." };
    return { ok: true, spec: { schema: "roaster.task.v1", goal } };
  }

  if (!isRecord(input)) {
    return { ok: false, error: "TaskSpec must be an object." };
  }

  const schema = normalizeNonEmptyString(input.schema);
  if (schema && schema !== "roaster.task.v1") {
    return { ok: false, error: `Unsupported TaskSpec schema: ${schema}` };
  }

  const goal = normalizeNonEmptyString(input.goal ?? input.prompt);
  if (!goal) {
    return { ok: false, error: "TaskSpec goal must be a non-empty string." };
  }

  const targetsRaw = input.targets;
  const targets = isRecord(targetsRaw)
    ? {
        files: normalizeStringArray(targetsRaw.files),
        symbols: normalizeStringArray(targetsRaw.symbols),
      }
    : undefined;

  const verificationRaw = input.verification;
  const verification = isRecord(verificationRaw)
    ? {
        level: normalizeVerificationLevel(verificationRaw.level),
        commands: normalizeStringArray(verificationRaw.commands),
      }
    : undefined;

  const spec: TaskSpec = normalizeTaskSpec({
    schema: "roaster.task.v1",
    goal,
    targets:
      targets?.files || targets?.symbols
        ? {
            files: targets.files,
            symbols: targets.symbols,
          }
        : undefined,
    expectedBehavior: normalizeNonEmptyString(input.expectedBehavior),
    constraints: normalizeStringArray(input.constraints),
    verification:
      verification?.level || verification?.commands
        ? {
            level: verification.level,
            commands: verification.commands,
          }
        : undefined,
  });

  return { ok: true, spec };
}

