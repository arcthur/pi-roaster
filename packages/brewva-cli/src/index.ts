#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { format, parseArgs as parseNodeArgs } from "node:util";
import { BrewvaRuntime, parseTaskSpec, type TaskSpec } from "@brewva/brewva-runtime";
import { InteractiveMode, runPrintMode } from "@mariozechner/pi-coding-agent";
import { JsonLineWriter, writeJsonLine } from "./json-lines.js";
import { createBrewvaSession, type BrewvaSessionResult } from "./session.js";

const NODE_VERSION_RANGE = "^20.19.0 || >=22.12.0";

type Semver = Readonly<{ major: number; minor: number; patch: number }>;

function parseSemver(versionText: string | undefined): Semver | null {
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

function isSupportedNodeVersion(version: Semver): boolean {
  if (version.major === 20) return version.minor >= 19;
  if (version.major === 21) return false;
  if (version.major === 22) return version.minor >= 12;
  return version.major > 22;
}

function assertSupportedRuntime(): void {
  const versions = process.versions as NodeJS.ProcessVersions & { bun?: string };
  if (typeof versions.bun === "string" && versions.bun.length > 0) return;

  const detected = typeof versions.node === "string" ? versions.node : process.version;
  const parsed = parseSemver(versions.node ?? process.version);
  if (!parsed || !isSupportedNodeVersion(parsed)) {
    console.error(
      `brewva: unsupported Node.js version ${detected}. Brewva requires Node.js ${NODE_VERSION_RANGE} (ES2023 baseline).`,
    );
    process.exit(1);
  }

  if (
    typeof Array.prototype.toSorted !== "function" ||
    typeof Array.prototype.toReversed !== "function"
  ) {
    console.error(
      `brewva: Node.js ${detected} is missing ES2023 builtins (toSorted/toReversed). Please upgrade Node.js to ${NODE_VERSION_RANGE}.`,
    );
    process.exit(1);
  }
}

function printConfigDiagnostics(
  diagnostics: BrewvaRuntime["configDiagnostics"],
  verbose: boolean,
): void {
  if (diagnostics.length === 0) return;

  const errors = diagnostics.filter((diagnostic) => diagnostic.level === "error");
  const warnings = diagnostics.filter((diagnostic) => diagnostic.level === "warn");

  for (const diagnostic of errors) {
    console.error(`[config:error] ${diagnostic.configPath}: ${diagnostic.message}`);
  }

  if (warnings.length === 0) return;
  const maxWarnings = verbose ? warnings.length : Math.min(3, warnings.length);
  for (const diagnostic of warnings.slice(0, maxWarnings)) {
    console.error(`[config:warn] ${diagnostic.configPath}: ${diagnostic.message}`);
  }
  if (!verbose && warnings.length > maxWarnings) {
    console.error(
      `[config:warn] ${warnings.length - maxWarnings} more warning(s) suppressed (run with --verbose for details).`,
    );
  }
}

function printHelp(): void {
  console.log(`Brewva - AI-native coding agent CLI

Usage:
  brewva [options] [prompt]

Modes:
  default               Interactive TUI mode (same flow as pi)
  --print               One-shot mode (prints final answer and exits)
  --mode json           One-shot JSON event stream

Options:
  --cwd <path>          Working directory
  --config <path>       Brewva config path (default: .brewva/brewva.json)
  --model <provider/id> Model override
  --task <json>         TaskSpec JSON (schema: brewva.task.v1)
  --task-file <path>    TaskSpec JSON file
  --no-extensions       Disable extension hooks (runtime core safety chain remains active)
  --print, -p           Run one-shot mode
  --interactive, -i     Force interactive TUI mode
  --mode <text|json>    One-shot output mode
  --json                Alias for --mode json
  --undo                Roll back the latest tracked patch set in this session
  --replay              Replay persisted runtime events
  --session <id>        Target session id for --undo/--replay
  --verbose             Verbose interactive startup
  -h, --help            Show help

Examples:
  brewva
  brewva "Fix failing tests in runtime"
  brewva --print "Refactor this function"
  brewva --mode json "Summarize recent changes"
  brewva --task-file ./task.json
  brewva --undo --session <session-id>
  brewva --replay --mode json --session <session-id>`);
}

type CliMode = "interactive" | "print-text" | "print-json";

interface CliArgs {
  cwd?: string;
  configPath?: string;
  model?: string;
  taskJson?: string;
  taskFile?: string;
  enableExtensions: boolean;
  undo: boolean;
  replay: boolean;
  sessionId?: string;
  mode: CliMode;
  modeExplicit: boolean;
  verbose: boolean;
  prompt?: string;
}

const CLI_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  cwd: { type: "string" },
  config: { type: "string" },
  model: { type: "string" },
  task: { type: "string" },
  "task-file": { type: "string" },
  "no-extensions": { type: "boolean" },
  print: { type: "boolean", short: "p" },
  interactive: { type: "boolean", short: "i" },
  mode: { type: "string" },
  json: { type: "boolean" },
  undo: { type: "boolean" },
  replay: { type: "boolean" },
  session: { type: "string" },
  verbose: { type: "boolean" },
} as const;

function resolveModeFromFlag(value: string): CliMode | null {
  if (value === "text") return "print-text";
  if (value === "json") return "print-json";
  console.error(`Error: --mode must be "text" or "json" (received "${value}").`);
  return null;
}

function parseArgs(argv: string[]): CliArgs | null {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: CLI_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    printHelp();
    return null;
  }

  if (parsed.values.help === true) {
    printHelp();
    return null;
  }

  let mode: CliMode = "interactive";
  let modeExplicit = false;
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== "option") continue;
    if (token.name === "print") {
      mode = "print-text";
      modeExplicit = true;
      continue;
    }
    if (token.name === "interactive") {
      mode = "interactive";
      modeExplicit = true;
      continue;
    }
    if (token.name === "json") {
      mode = "print-json";
      modeExplicit = true;
      continue;
    }
    if (token.name === "mode") {
      if (typeof token.value !== "string") continue;
      const resolved = resolveModeFromFlag(token.value);
      if (!resolved) return null;
      mode = resolved;
      modeExplicit = true;
    }
  }

  const prompt = parsed.positionals.join(" ").trim() || undefined;

  return {
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
    model: typeof parsed.values.model === "string" ? parsed.values.model : undefined,
    taskJson: typeof parsed.values.task === "string" ? parsed.values.task : undefined,
    taskFile:
      typeof parsed.values["task-file"] === "string" ? parsed.values["task-file"] : undefined,
    enableExtensions: parsed.values["no-extensions"] !== true,
    undo: parsed.values.undo === true,
    replay: parsed.values.replay === true,
    sessionId: typeof parsed.values.session === "string" ? parsed.values.session : undefined,
    mode,
    modeExplicit,
    verbose: parsed.values.verbose === true,
    prompt,
  };
}

function loadTaskSpec(parsed: CliArgs): { spec?: TaskSpec; error?: string } {
  if (!parsed.taskJson && !parsed.taskFile) {
    return {};
  }
  if (parsed.taskJson && parsed.taskFile) {
    return { error: "Error: use only one of --task or --task-file." };
  }

  let raw = "";
  if (parsed.taskJson) {
    raw = parsed.taskJson;
  } else if (parsed.taskFile) {
    const absolute = resolve(parsed.taskFile);
    try {
      raw = readFileSync(absolute, "utf8");
    } catch (error) {
      return {
        error: `Error: failed to read TaskSpec file (${absolute}): ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      error: `Error: failed to parse TaskSpec JSON (${error instanceof Error ? error.message : String(error)}).`,
    };
  }

  const result = parseTaskSpec(value);
  if (!result.ok) {
    return { error: `Error: invalid TaskSpec: ${result.error}` };
  }
  return { spec: result.spec };
}

async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  return await new Promise((fulfill) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      const text = data.trim();
      fulfill(text.length > 0 ? text : undefined);
    });
    process.stdin.resume();
  });
}

function resolveEffectiveMode(parsed: CliArgs): CliMode | null {
  if (parsed.mode !== "interactive") {
    return parsed.mode;
  }

  const hasTerminal = process.stdin.isTTY && process.stdout.isTTY;
  if (hasTerminal) {
    return "interactive";
  }

  if (parsed.modeExplicit) {
    console.error("Error: interactive mode requires a TTY terminal.");
    return null;
  }

  return "print-text";
}

function applyDefaultInteractiveEnv(mode: CliMode): void {
  if (mode !== "interactive") return;
  if (process.env.PI_SKIP_VERSION_CHECK === undefined) {
    process.env.PI_SKIP_VERSION_CHECK = "1";
  }
}

function printReplayText(
  events: Array<{
    timestamp: number;
    turn?: number;
    type: string;
    payload?: Record<string, unknown>;
  }>,
): void {
  for (const event of events) {
    const iso = new Date(event.timestamp).toISOString();
    const turnText = typeof event.turn === "number" ? `turn=${event.turn}` : "turn=-";
    const payload = event.payload ? JSON.stringify(event.payload) : "{}";
    console.log(`${iso} ${turnText} ${event.type} ${payload}`);
  }
}

function printCostSummary(sessionId: string, runtime: BrewvaRuntime): void {
  const summary = runtime.getCostSummary(sessionId);
  if (summary.totalTokens <= 0 && summary.totalCostUsd <= 0) return;

  const topSkill = Object.entries(summary.skills).toSorted(
    (a, b) => b[1].totalCostUsd - a[1].totalCostUsd,
  )[0];
  const topTool = Object.entries(summary.tools).toSorted(
    (a, b) => b[1].allocatedCostUsd - a[1].allocatedCostUsd,
  )[0];

  const parts = [
    `tokens=${summary.totalTokens}`,
    `cost=$${summary.totalCostUsd.toFixed(6)}`,
    `budget=${summary.budget.blocked ? "blocked" : "ok"}`,
  ];
  if (topSkill) {
    parts.push(`topSkill=${topSkill[0]}($${topSkill[1].totalCostUsd.toFixed(6)})`);
  }
  if (topTool) {
    parts.push(`topTool=${topTool[0]}($${topTool[1].allocatedCostUsd.toFixed(6)})`);
  }
  console.error(`[cost] session=${sessionId} ${parts.join(" ")}`);
}

async function runSerializedJsonPrintMode(
  session: BrewvaSessionResult["session"],
  initialMessage: string | undefined,
): Promise<void> {
  const writer = new JsonLineWriter();
  const originalLog = console.log;

  console.log = (...args: unknown[]): void => {
    const line = args.length === 0 ? "" : format(...args);
    writer.writeLine(line);
  };

  try {
    await runPrintMode(session, {
      mode: "json",
      initialMessage,
    });
  } finally {
    console.log = originalLog;
    await writer.flush();
  }
}

async function run(): Promise<void> {
  process.title = "brewva";
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) return;

  const pipedInput = await readPipedStdin();
  const taskResolved = loadTaskSpec(parsed);
  if (taskResolved.error) {
    console.error(taskResolved.error);
    return;
  }

  let taskSpec = taskResolved.spec;
  let initialMessage = parsed.prompt ?? pipedInput;
  if (taskSpec && parsed.prompt) {
    taskSpec = { ...taskSpec, goal: parsed.prompt.trim() };
  }
  if (taskSpec && !initialMessage) {
    initialMessage = taskSpec.goal;
  }
  const mode = resolveEffectiveMode(parsed);
  if (!mode) return;
  applyDefaultInteractiveEnv(mode);

  if (!parsed.undo && !parsed.replay && mode !== "interactive" && !initialMessage) {
    printHelp();
    return;
  }

  if (parsed.replay) {
    const runtime = new BrewvaRuntime({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
    });
    const targetSessionId = parsed.sessionId ?? runtime.listReplaySessions(1)[0]?.sessionId;
    if (!targetSessionId) {
      console.error("Error: no replayable session found.");
      return;
    }
    const events = runtime.queryStructuredEvents(targetSessionId);
    if (mode === "print-json") {
      for (const event of events) {
        await writeJsonLine(event);
      }
    } else {
      printReplayText(events);
    }
    return;
  }

  if (parsed.undo) {
    const runtime = new BrewvaRuntime({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
    });
    const targetSessionId = runtime.resolveUndoSessionId(parsed.sessionId);
    if (!targetSessionId) {
      console.log("No rollback applied (no_patchset).");
      return;
    }
    const rollback = runtime.rollbackLastPatchSet(targetSessionId);
    if (!rollback.ok) {
      const suffix = rollback.reason ? ` (${rollback.reason})` : "";
      console.log(`No rollback applied${suffix}.`);
    } else {
      console.log(
        `Rolled back patch set ${rollback.patchSetId ?? "unknown"} in session ${targetSessionId} (${rollback.restoredPaths.length} file(s) restored).`,
      );
    }
    return;
  }

  const { session, runtime } = await createBrewvaSession({
    cwd: parsed.cwd,
    configPath: parsed.configPath,
    model: parsed.model,
    enableExtensions: parsed.enableExtensions,
  });
  printConfigDiagnostics(runtime.configDiagnostics, parsed.verbose);

  const getSessionId = (): string => session.sessionManager.getSessionId();
  const initialSessionId = getSessionId();
  if (taskSpec) {
    runtime.setTaskSpec(initialSessionId, taskSpec);
  }
  const gracefulTimeoutMs = runtime.config.infrastructure.interruptRecovery.gracefulTimeoutMs;
  let terminatedBySignal = false;
  let finalized = false;
  const ensureSessionShutdownRecorded = (sessionId: string): void => {
    if (runtime.queryEvents(sessionId, { type: "session_shutdown", last: 1 }).length > 0) return;
    runtime.recordEvent({
      sessionId,
      type: "session_shutdown",
    });
  };

  const finalizeAndExit = (code: number): void => {
    if (finalized) return;
    finalized = true;
    session.dispose();
    process.exit(code);
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (terminatedBySignal) return;
    terminatedBySignal = true;

    const sessionId = getSessionId();
    runtime.recordEvent({
      sessionId,
      type: "session_interrupted",
      payload: { signal },
    });

    const timeout = setTimeout(() => {
      void session.abort().finally(() => {
        finalizeAndExit(130);
      });
    }, gracefulTimeoutMs);

    void session.agent
      .waitForIdle()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout);
        finalizeAndExit(130);
      });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  let emitJsonBundle = false;

  try {
    if (mode === "interactive") {
      const interactiveMode = new InteractiveMode(session, {
        initialMessage,
        verbose: parsed.verbose,
      });
      await interactiveMode.run();
      printCostSummary(getSessionId(), runtime);
      return;
    }

    if (mode === "print-json") {
      await runSerializedJsonPrintMode(session, initialMessage);
      emitJsonBundle = true;
    } else {
      await runPrintMode(session, {
        mode: "text",
        initialMessage,
      });
      printCostSummary(getSessionId(), runtime);
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    if (!terminatedBySignal) {
      const sessionId = getSessionId();
      ensureSessionShutdownRecorded(sessionId);
      if (emitJsonBundle) {
        const replayEvents = runtime.queryStructuredEvents(sessionId);
        await writeJsonLine({
          schema: "brewva.stream.v1",
          type: "brewva_event_bundle",
          sessionId,
          events: replayEvents,
          costSummary: runtime.getCostSummary(sessionId),
        });
      }
      session.dispose();
    }
  }
}

const isBunMain = (import.meta as ImportMeta & { main?: boolean }).main;
const isNodeMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isBunMain ?? isNodeMain) {
  assertSupportedRuntime();
  void run();
}

export { createBrewvaSession } from "./session.js";
export { parseArgs };
