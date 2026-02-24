import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  deleteManagedSession,
  markSessionBackgrounded,
  startManagedExec,
  terminateRunningSession,
  type ManagedExecFinishedSession,
  type ManagedExecRunningSession,
} from "./exec-process-registry.js";
import type { BrewvaToolRuntime } from "./types.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineTool } from "./utils/tool.js";

const ExecSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  workdir: Type.Optional(Type.String()),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000 })),
  yield_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000 })),
  background: Type.Optional(Type.Boolean()),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 7_200 })),
});

const DEFAULT_YIELD_MS = 10_000;
const SHELL_COMMAND = "sh";
const SHELL_ARGS = ["-lc"];
const DEFAULT_SANDBOX_WORKDIR = "/";
const SANDBOX_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_AUDIT_COMMAND_PREVIEW_LENGTH = 240;
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DENY_LIST_BEST_EFFORT_MESSAGE =
  "security.execution.commandDenyList is best-effort and must not be treated as a hard security boundary.";

const ENV_ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=.*/u;
const COMMAND_PREFIX_TOKENS = new Set(["sudo", "command", "time"]);
const SHELL_WRAPPER_TOKENS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);
const MAX_COMMAND_PARSE_DEPTH = 2;

type SecurityMode = BrewvaConfig["security"]["mode"];
type ExecutionBackend = BrewvaConfig["security"]["execution"]["backend"];
type SandboxConfig = BrewvaConfig["security"]["execution"]["sandbox"];
type MicrosandboxSdk = Pick<typeof import("microsandbox"), "NodeSandbox">;

type RecordedExecEvent =
  | "exec_routed"
  | "exec_fallback_host"
  | "exec_blocked_isolation"
  | "exec_sandbox_error";

interface ResolvedExecutionPolicy {
  mode: SecurityMode;
  backendPreference: ExecutionBackend;
  backend: "host" | "sandbox";
  enforceIsolation: boolean;
  allowHostFallback: boolean;
  denyListBestEffort: true;
  commandDenyList: Set<string>;
  sandbox: SandboxConfig;
}

interface ExecToolOptions {
  runtime?: BrewvaToolRuntime;
}

interface SandboxCommandBuildResult {
  shellCommand: string;
  requestedCwd?: string;
  effectiveCwd?: string;
  requestedEnvKeys: string[];
  appliedEnvKeys: string[];
  droppedEnvKeys: string[];
}

interface SandboxExecutionResult {
  output: string;
  exitCode: number;
  requestedCwd?: string;
  effectiveCwd: string;
  requestedEnvKeys: string[];
  appliedEnvKeys: string[];
  droppedEnvKeys: string[];
  timeoutSec: number;
}

let microsandboxSdkPromise: Promise<MicrosandboxSdk> | null = null;

class SandboxCommandFailedError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "SandboxCommandFailedError";
    this.exitCode = exitCode;
  }
}

class SandboxAbortedError extends Error {
  constructor() {
    super("Execution aborted by signal.");
    this.name = "SandboxAbortedError";
  }
}

function normalizeCommand(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const command = value.trim();
  return command.length > 0 ? command : undefined;
}

function resolveWorkdir(baseCwd: string, value: unknown): string {
  if (typeof value !== "string") return baseCwd;
  const trimmed = value.trim();
  if (!trimmed) return baseCwd;
  return resolve(baseCwd, trimmed);
}

function resolveYieldMs(params: { yieldMs?: unknown; yield_ms?: unknown }): number {
  const raw = typeof params.yieldMs === "number" ? params.yieldMs : params.yield_ms;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_YIELD_MS;
  return Math.max(0, Math.min(120_000, Math.trunc(raw)));
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeCommandToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) return "";
  const withoutQuotes = trimmed.replace(/^["']+|["']+$/gu, "");
  const normalized = withoutQuotes.toLowerCase();
  if (normalized.length === 0) return "";
  return normalized.includes("/") ? basename(normalized) : normalized;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const input = command.trim();
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

interface PrimaryCommandDescriptor {
  token: string;
  tokenIndex: number;
  tokens: string[];
}

function resolvePrimaryCommandDescriptor(command: string): PrimaryCommandDescriptor | undefined {
  const tokens = tokenizeCommand(command);
  let envMode = false;

  for (const [tokenIndex, token] of tokens.entries()) {
    const normalizedToken = normalizeCommandToken(token);
    if (!normalizedToken) continue;

    if (ENV_ASSIGNMENT_TOKEN.test(token)) {
      continue;
    }

    if (normalizedToken === "env") {
      envMode = true;
      continue;
    }

    if (envMode && token.startsWith("-")) {
      continue;
    }

    if (COMMAND_PREFIX_TOKENS.has(normalizedToken)) {
      continue;
    }

    return {
      token: normalizedToken,
      tokenIndex,
      tokens,
    };
  }

  return undefined;
}

function resolveShellInlineScript(descriptor: PrimaryCommandDescriptor): string | undefined {
  if (!SHELL_WRAPPER_TOKENS.has(descriptor.token)) {
    return undefined;
  }

  for (let index = descriptor.tokenIndex + 1; index < descriptor.tokens.length; index += 1) {
    const token = descriptor.tokens[index]!;
    if (token === "--") {
      return undefined;
    }

    if (token.startsWith("--")) {
      if (token === "--command") {
        return descriptor.tokens[index + 1];
      }
      if (token.startsWith("--command=")) {
        const inlineScript = token.slice("--command=".length);
        return inlineScript.length > 0 ? inlineScript : undefined;
      }
      continue;
    }

    if (!token.startsWith("-")) {
      return undefined;
    }

    const normalizedFlags = token.replace(/^-+/u, "");
    if (normalizedFlags.length === 0) {
      continue;
    }

    const cIndex = normalizedFlags.indexOf("c");
    if (cIndex === -1) {
      continue;
    }

    const inlineScript = normalizedFlags.slice(cIndex + 1);
    if (inlineScript.length > 0) {
      return inlineScript;
    }

    return descriptor.tokens[index + 1];
  }

  return undefined;
}

function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const pushCurrent = () => {
    const normalized = current.trim();
    if (normalized.length > 0) {
      segments.push(normalized);
    }
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ";" || char === "\n") {
      pushCurrent();
      continue;
    }

    if (char === "&" && command[index + 1] === "&") {
      pushCurrent();
      index += 1;
      continue;
    }

    if (char === "|") {
      pushCurrent();
      if (command[index + 1] === "|") {
        index += 1;
      }
      continue;
    }

    current += char;
  }

  pushCurrent();
  return segments;
}

function collectPrimaryCommandTokens(command: string, depth = 0): string[] {
  if (depth > MAX_COMMAND_PARSE_DEPTH) {
    return [];
  }

  const descriptor = resolvePrimaryCommandDescriptor(command);
  if (!descriptor) {
    return [];
  }

  const tokens = [descriptor.token];
  const inlineScript = resolveShellInlineScript(descriptor);
  if (!inlineScript) {
    return tokens;
  }

  const nestedTokens = resolvePrimaryCommandTokens(inlineScript, depth + 1);
  return [...new Set([...tokens, ...nestedTokens])];
}

function resolvePrimaryCommandTokens(command: string, depth = 0): string[] {
  if (depth > MAX_COMMAND_PARSE_DEPTH) {
    return [];
  }

  const segments = splitShellCommandSegments(command);
  const tokens = segments
    .flatMap((segment) => collectPrimaryCommandTokens(segment, depth))
    .filter((token) => token.length > 0);
  return [...new Set(tokens)];
}

function formatExit(session: ManagedExecFinishedSession): string {
  if (session.exitSignal) return `signal ${session.exitSignal}`;
  return `code ${session.exitCode ?? 0}`;
}

function runningResult(session: ManagedExecRunningSession) {
  const lines = [
    `Command still running (session ${session.id}, pid ${session.pid ?? "n/a"}).`,
    "Use process (list/poll/log/write/kill/clear/remove) for follow-up.",
  ];
  if (session.tail.trim().length > 0) {
    lines.push("", session.tail.trimEnd());
  }
  return textResult(lines.join("\n"), {
    status: "running",
    sessionId: session.id,
    pid: session.pid ?? undefined,
    startedAt: session.startedAt,
    cwd: session.cwd,
    tail: session.tail,
    command: session.command,
    backend: "host",
  });
}

async function waitForCompletionOrYield(
  completion: Promise<ManagedExecFinishedSession>,
  yieldMs: number,
): Promise<ManagedExecFinishedSession | undefined> {
  if (yieldMs === 0) return undefined;
  const timerTag = Symbol("yield");
  let yieldTimer: ReturnType<typeof setTimeout> | undefined;
  const winner = await Promise.race([
    completion,
    new Promise<symbol>((resolveNow) => {
      yieldTimer = setTimeout(() => resolveNow(timerTag), yieldMs);
    }),
  ]);
  if (winner !== timerTag && yieldTimer !== undefined) {
    clearTimeout(yieldTimer);
  }
  if (winner === timerTag) return undefined;
  return winner as ManagedExecFinishedSession;
}

function resolveExecutionPolicy(runtime?: BrewvaToolRuntime): ResolvedExecutionPolicy {
  const security = runtime?.config?.security ?? DEFAULT_BREWVA_CONFIG.security;
  const execution = security.execution;
  const enforceIsolation =
    execution.enforceIsolation || isTruthyEnvFlag(process.env.BREWVA_ENFORCE_EXEC_ISOLATION);
  const backendPreference = enforceIsolation ? "sandbox" : execution.backend;
  const backend = resolvePreferredBackend(security.mode, backendPreference);

  return {
    mode: security.mode,
    backendPreference,
    backend,
    enforceIsolation,
    allowHostFallback:
      backend === "sandbox" &&
      !enforceIsolation &&
      security.mode !== "strict" &&
      execution.fallbackToHost,
    denyListBestEffort: true,
    commandDenyList: new Set(
      execution.commandDenyList
        .map((entry) => normalizeCommandToken(entry))
        .filter((entry) => entry.length > 0),
    ),
    sandbox: {
      ...execution.sandbox,
      serverUrl: normalizeOptionalString(process.env.MSB_SERVER_URL) ?? execution.sandbox.serverUrl,
      apiKey: normalizeOptionalString(process.env.MSB_API_KEY) ?? execution.sandbox.apiKey,
    },
  };
}

function resolvePreferredBackend(
  mode: SecurityMode,
  backendPreference: ExecutionBackend,
): "host" | "sandbox" {
  if (backendPreference === "host" || backendPreference === "sandbox") {
    return backendPreference;
  }
  return mode === "permissive" ? "host" : "sandbox";
}

function redactCommandForAudit(command: string): string {
  const redacted = command
    .replace(
      /\b(authorization\s*[:=]\s*bearer\s+)[^\s"'`]+/giu,
      (_match, prefix: string) => `${prefix}<redacted>`,
    )
    .replace(/\b(Bearer\s+)[^\s"'`]+/gu, (_match, prefix: string) => `${prefix}<redacted>`)
    .replace(
      /\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*)(['"]?)[^'"\s]+(\2)/giu,
      (_match, prefix: string, quote: string) => `${prefix}${quote}<redacted>${quote}`,
    )
    .replace(
      /\b(x-api-key\s*[:=]\s*)(['"]?)[^'"\s]+(\2)/giu,
      (_match, prefix: string, quote: string) => `${prefix}${quote}<redacted>${quote}`,
    )
    .replace(
      /(-{1,2}(?:password|token|secret|api-key)\s+)([^\s"'`]+)/giu,
      (_match, prefix: string) => `${prefix}<redacted>`,
    );

  if (redacted.length <= DEFAULT_AUDIT_COMMAND_PREVIEW_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, DEFAULT_AUDIT_COMMAND_PREVIEW_LENGTH)}...`;
}

function hashCommandForAudit(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

function buildCommandAuditPayload(command: string): Record<string, unknown> {
  return {
    commandHash: hashCommandForAudit(command),
    commandRedacted: redactCommandForAudit(command),
  };
}

async function loadMicrosandboxSdk(): Promise<MicrosandboxSdk> {
  if (!microsandboxSdkPromise) {
    microsandboxSdkPromise = import("microsandbox")
      .then((sdk) => ({
        NodeSandbox: sdk.NodeSandbox,
      }))
      .catch((error) => {
        microsandboxSdkPromise = null;
        throw error;
      });
  }
  return await microsandboxSdkPromise;
}

function buildExecAuditPayload(input: {
  toolCallId: string;
  policy: ResolvedExecutionPolicy;
  command: string;
  payload?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    toolCallId: input.toolCallId,
    mode: input.policy.mode,
    configuredBackend: input.policy.backendPreference,
    enforceIsolation: input.policy.enforceIsolation,
    denyListBestEffort: input.policy.denyListBestEffort,
    ...buildCommandAuditPayload(input.command),
    ...input.payload,
  };
}

function isSandboxAbortedError(error: unknown): error is SandboxAbortedError {
  return error instanceof SandboxAbortedError;
}

function escapeForSingleQuotedShell(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function buildSandboxCommand(input: {
  command: string;
  requestedCwd?: string;
  requestedEnv?: Record<string, string>;
}): SandboxCommandBuildResult {
  const requestedEnvEntries = Object.entries(input.requestedEnv ?? {});
  const requestedEnvKeys = requestedEnvEntries.map(([key]) => key);
  const appliedEnvEntries = requestedEnvEntries.filter(([key]) => VALID_ENV_KEY.test(key));
  const appliedEnvKeys = appliedEnvEntries.map(([key]) => key);
  const droppedEnvKeys = requestedEnvEntries
    .map(([key]) => key)
    .filter((key) => !VALID_ENV_KEY.test(key));

  const prefixClauses: string[] = [];
  if (input.requestedCwd) {
    prefixClauses.push(`cd ${escapeForSingleQuotedShell(input.requestedCwd)}`);
  }
  for (const [key, value] of appliedEnvEntries) {
    prefixClauses.push(`export ${key}=${escapeForSingleQuotedShell(value)}`);
  }

  const shellCommand =
    prefixClauses.length > 0 ? `${prefixClauses.join(" && ")} && ${input.command}` : input.command;
  return {
    shellCommand,
    requestedCwd: input.requestedCwd,
    effectiveCwd: input.requestedCwd ?? DEFAULT_SANDBOX_WORKDIR,
    requestedEnvKeys,
    appliedEnvKeys,
    droppedEnvKeys,
  };
}

function recordExecEvent(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string,
  type: RecordedExecEvent,
  payload: Record<string, unknown>,
): void {
  runtime?.events.record?.({
    sessionId,
    type,
    payload,
  });
}

async function executeHostCommand(input: {
  ownerSessionId: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSec?: number;
  background: boolean;
  yieldMs: number;
  signal?: AbortSignal;
}) {
  let started;
  try {
    started = startManagedExec({
      ownerSessionId: input.ownerSessionId,
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      timeoutSec: input.timeoutSec,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`Exec failed to start: ${message}`, {
      status: "failed",
      command: input.command,
      cwd: input.cwd,
      backend: "host",
    });
  }

  const onAbort = () => {
    if (input.background || started.session.backgrounded) return;
    terminateRunningSession(started.session, true);
  };

  if (input.signal?.aborted) {
    onAbort();
  } else if (input.signal) {
    input.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    if (input.background || input.yieldMs === 0) {
      markSessionBackgrounded(input.ownerSessionId, started.session.id);
      return runningResult(started.session);
    }

    const finished = await waitForCompletionOrYield(started.completion, input.yieldMs);
    if (!finished) {
      markSessionBackgrounded(input.ownerSessionId, started.session.id);
      return runningResult(started.session);
    }

    if (!finished.backgrounded) {
      deleteManagedSession(input.ownerSessionId, finished.id);
    }

    const output = finished.aggregated.trimEnd() || "(no output)";
    if (finished.status === "completed") {
      return textResult(output, {
        status: "completed",
        exitCode: finished.exitCode ?? 0,
        durationMs: finished.endedAt - finished.startedAt,
        cwd: finished.cwd,
        command: finished.command,
        backend: "host",
      });
    }

    throw new Error(`${output}\n\nProcess exited with ${formatExit(finished)}.`);
  } finally {
    if (input.signal) {
      input.signal.removeEventListener("abort", onAbort);
    }
  }
}

async function executeSandboxCommand(input: {
  command: string;
  policy: ResolvedExecutionPolicy;
  requestedCwd?: string;
  requestedEnv?: Record<string, string>;
  requestedTimeoutSec?: number;
  signal?: AbortSignal;
}): Promise<SandboxExecutionResult> {
  if (input.signal?.aborted) {
    throw new SandboxAbortedError();
  }

  const sdk = await loadMicrosandboxSdk();
  const sandboxCommand = buildSandboxCommand({
    command: input.command,
    requestedCwd: input.requestedCwd,
    requestedEnv: input.requestedEnv,
  });
  const timeoutSec = input.requestedTimeoutSec ?? input.policy.sandbox.timeout;

  let sandbox: {
    command: {
      run(
        command: string,
        args?: string[],
        timeout?: number,
      ): Promise<{
        output(): Promise<string>;
        error(): Promise<string>;
        exitCode: number;
        success: boolean;
      }>;
    };
    stop(): Promise<void>;
  } | null = null;
  let abortListener: (() => void) | undefined;

  const stopSandbox = async () => {
    if (!sandbox) return;
    const sandboxToStop = sandbox;
    sandbox = null;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sandboxToStop.stop(),
        new Promise<void>((resolveNow) => {
          stopTimer = setTimeout(resolveNow, SANDBOX_STOP_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // ignore stop errors: command outcome should be the primary signal
    } finally {
      if (stopTimer !== undefined) {
        clearTimeout(stopTimer);
      }
    }
  };

  try {
    sandbox = await sdk.NodeSandbox.create({
      name: `brewva-${Date.now().toString(36)}`,
      serverUrl: input.policy.sandbox.serverUrl,
      apiKey: input.policy.sandbox.apiKey,
      image: input.policy.sandbox.defaultImage,
      memory: input.policy.sandbox.memory,
      cpus: input.policy.sandbox.cpus,
      timeout: input.policy.sandbox.timeout,
    });

    if (input.signal?.aborted) {
      throw new SandboxAbortedError();
    }

    const runPromise = sandbox.command.run(
      SHELL_COMMAND,
      [...SHELL_ARGS, sandboxCommand.shellCommand],
      timeoutSec,
    );
    const abortSignal = input.signal;

    let execution: Awaited<typeof runPromise>;
    try {
      execution = await new Promise<Awaited<typeof runPromise>>((resolveRun, rejectRun) => {
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
          if (abortSignal && abortListener) {
            abortSignal.removeEventListener("abort", abortListener);
            abortListener = undefined;
          }
        };

        const resolveOnce = (value: Awaited<typeof runPromise>) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolveRun(value);
        };

        const rejectOnce = (reason: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          rejectRun(reason);
        };

        if (abortSignal) {
          const abortExecution = () => {
            void stopSandbox();
            rejectOnce(new SandboxAbortedError());
          };
          abortListener = abortExecution;

          if (abortSignal.aborted) {
            abortExecution();
            return;
          }

          abortSignal.addEventListener("abort", abortExecution, { once: true });
        }

        timeoutHandle = setTimeout(() => {
          void stopSandbox();
          rejectOnce(
            new SandboxCommandFailedError(`Process timed out after ${timeoutSec} seconds.`, 124),
          );
        }, timeoutSec * 1_000);

        runPromise.then(resolveOnce).catch(rejectOnce);
      });
    } catch (error) {
      if (isSandboxAbortedError(error)) {
        throw error;
      }
      if (error instanceof SandboxCommandFailedError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new SandboxCommandFailedError(message, -1);
    }

    const stdout = await execution.output();
    const stderr = await execution.error();
    const combined = [stdout.trimEnd(), stderr.trimEnd()]
      .filter((part) => part.length > 0)
      .join("\n");

    if (!execution.success) {
      const errorText = combined.length > 0 ? combined : "(no output)";
      throw new SandboxCommandFailedError(
        `${errorText}\n\nProcess exited with code ${execution.exitCode}.`,
        execution.exitCode,
      );
    }

    return {
      output: combined.length > 0 ? combined : "(no output)",
      exitCode: execution.exitCode,
      requestedCwd: sandboxCommand.requestedCwd,
      effectiveCwd: sandboxCommand.effectiveCwd ?? DEFAULT_SANDBOX_WORKDIR,
      requestedEnvKeys: sandboxCommand.requestedEnvKeys,
      appliedEnvKeys: sandboxCommand.appliedEnvKeys,
      droppedEnvKeys: sandboxCommand.droppedEnvKeys,
      timeoutSec,
    };
  } finally {
    if (input.signal && abortListener) {
      input.signal.removeEventListener("abort", abortListener);
    }
    await stopSandbox();
  }
}

export function createExecTool(options?: ExecToolOptions): ToolDefinition {
  return defineTool({
    name: "exec",
    label: "Exec",
    description:
      "Execute shell commands with optional background continuation. Pair with process tool for list/poll/log/kill.",
    parameters: ExecSchema,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const ownerSessionId = getSessionId(ctx);
      const baseCwd =
        typeof ctx.cwd === "string" && ctx.cwd.trim().length > 0 ? ctx.cwd : process.cwd();
      const command = normalizeCommand(params.command);
      if (!command) {
        return textResult("Exec rejected (missing_command).", { status: "failed" });
      }

      const requestedWorkdir = normalizeOptionalString(params.workdir);
      const hostCwd = resolveWorkdir(baseCwd, requestedWorkdir);
      const sandboxRequestedCwd = requestedWorkdir ? hostCwd : undefined;
      const requestedEnv = params.env ? { ...params.env } : undefined;
      const requestedEnvKeys = Object.keys(requestedEnv ?? {});
      const hostEnv = requestedEnv ? { ...process.env, ...requestedEnv } : process.env;
      const timeoutSec = typeof params.timeout === "number" ? params.timeout : undefined;
      const background = params.background === true;
      const yieldMs = background ? 0 : resolveYieldMs(params);

      const policy = resolveExecutionPolicy(options?.runtime);
      const primaryTokens = resolvePrimaryCommandTokens(command);
      const deniedCommand = primaryTokens.find((token) => policy.commandDenyList.has(token));
      if (deniedCommand) {
        const reason = `Command '${deniedCommand}' is denied by security.execution.commandDenyList.`;
        recordExecEvent(
          options?.runtime,
          ownerSessionId,
          "exec_blocked_isolation",
          buildExecAuditPayload({
            toolCallId,
            policy,
            command,
            payload: {
              detectedCommands: primaryTokens,
              deniedCommand,
              reason,
              denyListPolicy: DENY_LIST_BEST_EFFORT_MESSAGE,
            },
          }),
        );
        throw new Error(`exec_blocked_isolation: ${reason}`);
      }

      const preferredBackend = policy.backend;
      recordExecEvent(
        options?.runtime,
        ownerSessionId,
        "exec_routed",
        buildExecAuditPayload({
          toolCallId,
          policy,
          command,
          payload: {
            resolvedBackend: preferredBackend,
            fallbackToHost: policy.allowHostFallback,
            requestedCwd: sandboxRequestedCwd,
            effectiveSandboxCwd: sandboxRequestedCwd ?? DEFAULT_SANDBOX_WORKDIR,
            requestedEnvKeys,
            requestedTimeoutSec: timeoutSec,
            sandboxDefaultTimeoutSec: policy.sandbox.timeout,
          },
        }),
      );

      const runHost = async () =>
        executeHostCommand({
          ownerSessionId,
          command,
          cwd: hostCwd,
          env: hostEnv,
          timeoutSec,
          background,
          yieldMs,
          signal,
        });

      if (preferredBackend === "host") {
        return await runHost();
      }

      if (background) {
        const reason = "sandbox backend does not support background process mode";
        if (policy.allowHostFallback) {
          recordExecEvent(
            options?.runtime,
            ownerSessionId,
            "exec_fallback_host",
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: { reason },
            }),
          );
          return await runHost();
        }

        recordExecEvent(
          options?.runtime,
          ownerSessionId,
          "exec_blocked_isolation",
          buildExecAuditPayload({
            toolCallId,
            policy,
            command,
            payload: { reason },
          }),
        );
        throw new Error(`exec_blocked_isolation: ${reason}`);
      }

      try {
        const startedAt = Date.now();
        const result = await executeSandboxCommand({
          command,
          policy,
          requestedCwd: sandboxRequestedCwd,
          requestedEnv,
          requestedTimeoutSec: timeoutSec,
          signal,
        });
        return textResult(result.output, {
          status: "completed",
          exitCode: result.exitCode,
          durationMs: Date.now() - startedAt,
          cwd: result.effectiveCwd,
          command,
          backend: "sandbox",
          requestedCwd: result.requestedCwd,
          requestedEnvKeys: result.requestedEnvKeys,
          appliedEnvKeys: result.appliedEnvKeys,
          droppedEnvKeys: result.droppedEnvKeys,
          timeoutSec: result.timeoutSec,
        });
      } catch (error) {
        if (error instanceof SandboxCommandFailedError) {
          throw new Error(error.message, { cause: error });
        }
        if (isSandboxAbortedError(error) || signal?.aborted) {
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        recordExecEvent(
          options?.runtime,
          ownerSessionId,
          "exec_sandbox_error",
          buildExecAuditPayload({
            toolCallId,
            policy,
            command,
            payload: {
              error: message,
            },
          }),
        );

        if (policy.allowHostFallback) {
          recordExecEvent(
            options?.runtime,
            ownerSessionId,
            "exec_fallback_host",
            buildExecAuditPayload({
              toolCallId,
              policy,
              command,
              payload: {
                reason: "sandbox_execution_error",
                error: message,
              },
            }),
          );
          return await runHost();
        }

        recordExecEvent(
          options?.runtime,
          ownerSessionId,
          "exec_blocked_isolation",
          buildExecAuditPayload({
            toolCallId,
            policy,
            command,
            payload: {
              reason: "sandbox_execution_error",
              error: message,
            },
          }),
        );
        throw new Error(`exec_blocked_isolation: ${message}`, { cause: error });
      }
    },
  });
}
