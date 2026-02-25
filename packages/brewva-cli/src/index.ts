#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { runGatewayCli } from "@brewva/brewva-gateway";
import {
  BrewvaRuntime,
  normalizeAgentId,
  parseTaskSpec,
  type TaskSpec,
} from "@brewva/brewva-runtime";
import { InteractiveMode, runPrintMode } from "@mariozechner/pi-coding-agent";
import { formatISO } from "date-fns";
import { runChannelMode } from "./channel-mode.js";
import { runDaemon } from "./daemon-mode.js";
import {
  resolveBackendWorkingCwd,
  shouldFallbackAfterGatewayFailure,
  tryGatewayPrint,
  writeGatewayAssistantText,
} from "./gateway-print.js";
import { writeJsonLine } from "./json-lines.js";
import { ensureSessionShutdownRecorded } from "./runtime-utils.js";
import { createBrewvaSession } from "./session.js";

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

Subcommands:
  brewva gateway ...   Local control-plane daemon commands
  brewva onboard ...   One-shot onboarding helpers (daemon install/uninstall)

Modes:
  default               Interactive TUI mode (same flow as pi)
  --print               One-shot mode (prints final answer and exits)
  --mode json           One-shot JSON event stream

Options:
  --cwd <path>          Working directory
  --config <path>       Brewva config path (default: .brewva/brewva.json)
  --model <provider/id> Model override
  --agent <id>          Agent identity id (.brewva/agents/<id>/identity.md)
  --task <json>         TaskSpec JSON (schema: brewva.task.v1)
  --task-file <path>    TaskSpec JSON file
  --no-extensions       Disable extension hooks (runtime core safety chain remains active)
  --print, -p           Run one-shot mode
  --interactive, -i     Force interactive TUI mode
  --mode <text|json>    One-shot output mode
  --backend <kind>      Session backend: auto | embedded | gateway (default: auto)
  --json                Alias for --mode json
  --undo                Roll back the latest tracked patch set in this session
  --replay              Replay persisted runtime events
  --daemon              Run scheduler daemon (no interactive session)
  --channel <name>      Run channel gateway mode (currently: telegram)
  --telegram-token <t>  Telegram bot token for --channel telegram
  --telegram-callback-secret <s>
                        Secret used to sign/verify Telegram approval callbacks
  --telegram-poll-timeout <seconds>
                        Telegram getUpdates timeout in seconds
  --telegram-poll-limit <n>
                        Telegram getUpdates batch size (1-100)
  --telegram-poll-retry-ms <ms>
                        Delay before retry when polling fails
  --session <id>        Target session id for --undo/--replay
  --verbose             Verbose interactive startup
  -v, --version         Show CLI version
  -h, --help            Show help

Examples:
  brewva
  brewva "Fix failing tests in runtime"
  brewva --print "Refactor this function"
  brewva --backend gateway --print "Summarize this file"
  brewva --agent code-reviewer --print "Review recent diff"
  brewva --mode json "Summarize recent changes"
  brewva --task-file ./task.json
  brewva --undo --session <session-id>
  brewva --replay --mode json --session <session-id>
  brewva onboard --install-daemon
  brewva --channel telegram --telegram-token <bot-token>
  brewva --daemon`);
}

function readCliVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
      return packageJson.version.trim();
    }
  } catch {
    // Fall back to unknown version when package metadata cannot be read.
  }
  return "unknown";
}

const CLI_VERSION = readCliVersion();

function printVersion(): void {
  console.log(CLI_VERSION);
}

type CliMode = "interactive" | "print-text" | "print-json";
type CliBackendKind = "auto" | "embedded" | "gateway";

interface TelegramCliChannelConfig {
  token?: string;
  callbackSecret?: string;
  pollTimeoutSeconds?: number;
  pollLimit?: number;
  pollRetryMs?: number;
}

interface CliChannelConfig {
  telegram?: TelegramCliChannelConfig;
}

interface CliArgs {
  cwd?: string;
  configPath?: string;
  model?: string;
  agentId?: string;
  taskJson?: string;
  taskFile?: string;
  channel?: string;
  channelConfig?: CliChannelConfig;
  enableExtensions: boolean;
  undo: boolean;
  replay: boolean;
  daemon: boolean;
  sessionId?: string;
  mode: CliMode;
  backend: CliBackendKind;
  modeExplicit: boolean;
  verbose: boolean;
  prompt?: string;
}

type CliParseResult =
  | { kind: "ok"; args: CliArgs }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error" };

const CLI_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  cwd: { type: "string" },
  config: { type: "string" },
  model: { type: "string" },
  agent: { type: "string" },
  task: { type: "string" },
  "task-file": { type: "string" },
  "no-extensions": { type: "boolean" },
  print: { type: "boolean", short: "p" },
  interactive: { type: "boolean", short: "i" },
  mode: { type: "string" },
  backend: { type: "string" },
  json: { type: "boolean" },
  undo: { type: "boolean" },
  replay: { type: "boolean" },
  daemon: { type: "boolean" },
  channel: { type: "string" },
  "telegram-token": { type: "string" },
  "telegram-callback-secret": { type: "string" },
  "telegram-poll-timeout": { type: "string" },
  "telegram-poll-limit": { type: "string" },
  "telegram-poll-retry-ms": { type: "string" },
  session: { type: "string" },
  verbose: { type: "boolean" },
} as const;

const ONBOARD_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  "install-daemon": { type: "boolean" },
  "uninstall-daemon": { type: "boolean" },
  launchd: { type: "boolean" },
  systemd: { type: "boolean" },
  "no-start": { type: "boolean" },
  "dry-run": { type: "boolean" },
  cwd: { type: "string" },
  config: { type: "string" },
  model: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "log-file": { type: "string" },
  "token-file": { type: "string" },
  heartbeat: { type: "string" },
  "no-extensions": { type: "boolean" },
  "tick-interval-ms": { type: "string" },
  "session-idle-ms": { type: "string" },
  "max-workers": { type: "string" },
  "max-open-queue": { type: "string" },
  "max-payload-bytes": { type: "string" },
  "health-http-port": { type: "string" },
  "health-http-path": { type: "string" },
  label: { type: "string" },
  "service-name": { type: "string" },
  "plist-file": { type: "string" },
  "unit-file": { type: "string" },
} as const;

function resolveModeFromFlag(value: string): CliMode | null {
  if (value === "text") return "print-text";
  if (value === "json") return "print-json";
  console.error(`Error: --mode must be "text" or "json" (received "${value}").`);
  return null;
}

function resolveBackendFromFlag(value: string | undefined): CliBackendKind | null {
  if (!value) return "auto";
  if (value === "auto" || value === "embedded" || value === "gateway") {
    return value;
  }
  console.error(`Error: --backend must be "auto", "embedded", or "gateway" (received "${value}").`);
  return null;
}

function parseOptionalIntegerFlag(
  name: string,
  raw: unknown,
): { value: number | undefined; error?: string } {
  if (typeof raw !== "string") {
    return { value: undefined };
  }
  const normalized = raw.trim();
  if (!normalized) {
    return { value: undefined, error: `Error: --${name} must be an integer.` };
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { value: undefined, error: `Error: --${name} must be an integer.` };
  }
  return { value };
}

function parseCliArgs(argv: string[]): CliParseResult {
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
    return { kind: "error" };
  }

  if (parsed.values.help === true) {
    printHelp();
    return { kind: "help" };
  }
  if (parsed.values.version === true) {
    printVersion();
    return { kind: "version" };
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
      if (!resolved) return { kind: "error" };
      mode = resolved;
      modeExplicit = true;
    }
  }
  const backend = resolveBackendFromFlag(
    typeof parsed.values.backend === "string" ? parsed.values.backend : undefined,
  );
  if (!backend) {
    return { kind: "error" };
  }

  const prompt = parsed.positionals.join(" ").trim() || undefined;
  const pollTimeout = parseOptionalIntegerFlag(
    "telegram-poll-timeout",
    parsed.values["telegram-poll-timeout"],
  );
  if (pollTimeout.error) {
    console.error(pollTimeout.error);
    return { kind: "error" };
  }
  const pollLimit = parseOptionalIntegerFlag(
    "telegram-poll-limit",
    parsed.values["telegram-poll-limit"],
  );
  if (pollLimit.error) {
    console.error(pollLimit.error);
    return { kind: "error" };
  }
  const pollRetryMs = parseOptionalIntegerFlag(
    "telegram-poll-retry-ms",
    parsed.values["telegram-poll-retry-ms"],
  );
  if (pollRetryMs.error) {
    console.error(pollRetryMs.error);
    return { kind: "error" };
  }
  const args: CliArgs = {
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
    model: typeof parsed.values.model === "string" ? parsed.values.model : undefined,
    agentId:
      typeof parsed.values.agent === "string" && parsed.values.agent.trim().length > 0
        ? normalizeAgentId(parsed.values.agent)
        : undefined,
    taskJson: typeof parsed.values.task === "string" ? parsed.values.task : undefined,
    taskFile:
      typeof parsed.values["task-file"] === "string" ? parsed.values["task-file"] : undefined,
    channel: typeof parsed.values.channel === "string" ? parsed.values.channel : undefined,
    channelConfig: {
      telegram: {
        token:
          typeof parsed.values["telegram-token"] === "string"
            ? parsed.values["telegram-token"]
            : undefined,
        callbackSecret:
          typeof parsed.values["telegram-callback-secret"] === "string"
            ? parsed.values["telegram-callback-secret"]
            : undefined,
        pollTimeoutSeconds: pollTimeout.value,
        pollLimit: pollLimit.value,
        pollRetryMs: pollRetryMs.value,
      },
    },
    enableExtensions: parsed.values["no-extensions"] !== true,
    undo: parsed.values.undo === true,
    replay: parsed.values.replay === true,
    daemon: parsed.values.daemon === true,
    sessionId: typeof parsed.values.session === "string" ? parsed.values.session : undefined,
    mode,
    backend,
    modeExplicit,
    verbose: parsed.values.verbose === true,
    prompt,
  };

  if (args.undo && args.replay) {
    console.error("Error: --undo cannot be combined with --replay.");
    return { kind: "error" };
  }
  if ((args.undo || args.replay) && (args.taskJson || args.taskFile)) {
    console.error("Error: --undo/--replay cannot be combined with --task/--task-file.");
    return { kind: "error" };
  }
  if (args.channel?.trim().toLowerCase() === "telegram") {
    const token = args.channelConfig?.telegram?.token?.trim();
    if (!token) {
      console.error("Error: --telegram-token is required when --channel telegram is set.");
      return { kind: "error" };
    }
  }

  return { kind: "ok", args };
}

function parseArgs(argv: string[]): CliArgs | null {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "ok") {
    return null;
  }
  return parsed.args;
}

function printOnboardHelp(): void {
  console.log(`Brewva Onboard - daemon bootstrap shortcuts

Usage:
  brewva onboard --install-daemon [options]
  brewva onboard --uninstall-daemon [options]

Options:
  --install-daemon       Install gateway daemon service for current OS
  --uninstall-daemon     Remove previously installed daemon service
  --launchd              Force launchd mode (macOS only)
  --systemd              Force systemd user-service mode (Linux only)
  --no-start             Install files only (skip enable/start)
  --dry-run              Preview generated service and actions
  --json                 Emit JSON output
  -h, --help             Show help

Examples:
  brewva onboard --install-daemon
  brewva onboard --install-daemon --systemd
  brewva onboard --install-daemon --dry-run --json
  brewva onboard --uninstall-daemon`);
}

function pushOnboardStringFlag(args: string[], name: string, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized) {
    return;
  }
  args.push(`--${name}`, normalized);
}

function pushOnboardBooleanFlag(args: string[], name: string, value: unknown): void {
  if (value === true) {
    args.push(`--${name}`);
  }
}

async function runOnboardCli(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: ONBOARD_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printOnboardHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(`Error: unexpected positional args for onboard: ${parsed.positionals.join(" ")}`);
    return 1;
  }

  const installDaemon = parsed.values["install-daemon"] === true;
  const uninstallDaemon = parsed.values["uninstall-daemon"] === true;
  if (installDaemon && uninstallDaemon) {
    console.error("Error: --install-daemon and --uninstall-daemon cannot be used together.");
    return 1;
  }
  if (!installDaemon && !uninstallDaemon) {
    console.error("Error: onboard requires --install-daemon or --uninstall-daemon.");
    printOnboardHelp();
    return 1;
  }

  const gatewayArgs = [installDaemon ? "install" : "uninstall"];
  pushOnboardBooleanFlag(gatewayArgs, "json", parsed.values.json);
  pushOnboardBooleanFlag(gatewayArgs, "launchd", parsed.values.launchd);
  pushOnboardBooleanFlag(gatewayArgs, "systemd", parsed.values.systemd);
  pushOnboardBooleanFlag(gatewayArgs, "dry-run", parsed.values["dry-run"]);

  if (installDaemon) {
    pushOnboardBooleanFlag(gatewayArgs, "no-start", parsed.values["no-start"]);
    pushOnboardBooleanFlag(gatewayArgs, "no-extensions", parsed.values["no-extensions"]);

    pushOnboardStringFlag(gatewayArgs, "cwd", parsed.values.cwd);
    pushOnboardStringFlag(gatewayArgs, "config", parsed.values.config);
    pushOnboardStringFlag(gatewayArgs, "model", parsed.values.model);
    pushOnboardStringFlag(gatewayArgs, "host", parsed.values.host);
    pushOnboardStringFlag(gatewayArgs, "port", parsed.values.port);
    pushOnboardStringFlag(gatewayArgs, "state-dir", parsed.values["state-dir"]);
    pushOnboardStringFlag(gatewayArgs, "pid-file", parsed.values["pid-file"]);
    pushOnboardStringFlag(gatewayArgs, "log-file", parsed.values["log-file"]);
    pushOnboardStringFlag(gatewayArgs, "token-file", parsed.values["token-file"]);
    pushOnboardStringFlag(gatewayArgs, "heartbeat", parsed.values.heartbeat);
    pushOnboardStringFlag(gatewayArgs, "tick-interval-ms", parsed.values["tick-interval-ms"]);
    pushOnboardStringFlag(gatewayArgs, "session-idle-ms", parsed.values["session-idle-ms"]);
    pushOnboardStringFlag(gatewayArgs, "max-workers", parsed.values["max-workers"]);
    pushOnboardStringFlag(gatewayArgs, "max-open-queue", parsed.values["max-open-queue"]);
    pushOnboardStringFlag(gatewayArgs, "max-payload-bytes", parsed.values["max-payload-bytes"]);
    pushOnboardStringFlag(gatewayArgs, "health-http-port", parsed.values["health-http-port"]);
    pushOnboardStringFlag(gatewayArgs, "health-http-path", parsed.values["health-http-path"]);
  }

  pushOnboardStringFlag(gatewayArgs, "label", parsed.values.label);
  pushOnboardStringFlag(gatewayArgs, "service-name", parsed.values["service-name"]);
  pushOnboardStringFlag(gatewayArgs, "plist-file", parsed.values["plist-file"]);
  pushOnboardStringFlag(gatewayArgs, "unit-file", parsed.values["unit-file"]);

  const gatewayResult = await runGatewayCli(gatewayArgs);
  return gatewayResult.exitCode;
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
    const iso = formatISO(event.timestamp);
    const turnText = typeof event.turn === "number" ? `turn=${event.turn}` : "turn=-";
    const payload = event.payload ? JSON.stringify(event.payload) : "{}";
    console.log(`${iso} ${turnText} ${event.type} ${payload}`);
  }
}

function printCostSummary(sessionId: string, runtime: BrewvaRuntime): void {
  const summary = runtime.cost.getSummary(sessionId);
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

function printGatewayCostSummary(input: {
  cwd?: string;
  configPath?: string;
  requestedSessionId: string;
  agentSessionId?: string;
}): void {
  const replaySessionId =
    typeof input.agentSessionId === "string" && input.agentSessionId.trim()
      ? input.agentSessionId
      : input.requestedSessionId;
  const runtime = new BrewvaRuntime({
    cwd: resolveBackendWorkingCwd(input.cwd),
    configPath: input.configPath,
  });
  runtime.context.onTurnStart(replaySessionId, 0);
  printCostSummary(replaySessionId, runtime);
}

async function run(): Promise<void> {
  process.title = "brewva";
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "gateway") {
    const gatewayResult = await runGatewayCli(rawArgs.slice(1));
    if (gatewayResult.handled) {
      process.exitCode = gatewayResult.exitCode;
      return;
    }
  }
  if (rawArgs[0] === "onboard") {
    process.exitCode = await runOnboardCli(rawArgs.slice(1));
    return;
  }

  const parseResult = parseCliArgs(rawArgs);
  if (parseResult.kind === "help" || parseResult.kind === "version") {
    return;
  }
  if (parseResult.kind === "error") {
    process.exitCode = 1;
    return;
  }
  const parsed = parseResult.args;

  if (parsed.channel) {
    if (parsed.backend === "gateway") {
      console.error("Error: --backend gateway is not supported with --channel.");
      process.exitCode = 1;
      return;
    }
    if (parsed.daemon) {
      console.error("Error: --channel cannot be combined with --daemon.");
      process.exitCode = 1;
      return;
    }
    if (parsed.undo || parsed.replay) {
      console.error("Error: --channel cannot be combined with --undo/--replay.");
      process.exitCode = 1;
      return;
    }
    if (parsed.taskJson || parsed.taskFile) {
      console.error("Error: --channel cannot be combined with --task/--task-file.");
      process.exitCode = 1;
      return;
    }
    if (parsed.prompt) {
      console.error("Error: --channel mode does not accept prompt text.");
      process.exitCode = 1;
      return;
    }
    if (parsed.modeExplicit && parsed.mode !== "interactive") {
      console.error("Error: --channel mode cannot be combined with --print/--json/--mode.");
      process.exitCode = 1;
      return;
    }

    await runChannelMode({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      model: parsed.model,
      agentId: parsed.agentId,
      enableExtensions: parsed.enableExtensions,
      verbose: parsed.verbose,
      channel: parsed.channel,
      channelConfig: parsed.channelConfig,
      onRuntimeReady: (runtime) => {
        printConfigDiagnostics(runtime.configDiagnostics, parsed.verbose);
      },
    });
    return;
  }

  if (parsed.daemon) {
    if (parsed.backend === "gateway") {
      console.error("Error: --backend gateway is not supported with --daemon.");
      process.exitCode = 1;
      return;
    }
    if (parsed.modeExplicit && parsed.mode !== "interactive") {
      console.error("Error: --daemon cannot be combined with --print/--json/--mode.");
      process.exitCode = 1;
      return;
    }
    if (parsed.undo || parsed.replay) {
      console.error("Error: --daemon cannot be combined with --undo/--replay.");
      process.exitCode = 1;
      return;
    }
    if (parsed.taskJson || parsed.taskFile) {
      console.error("Error: --daemon cannot be combined with --task/--task-file.");
      process.exitCode = 1;
      return;
    }
    if (parsed.prompt) {
      console.error("Error: --daemon does not accept prompt text.");
      process.exitCode = 1;
      return;
    }

    await runDaemon({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      model: parsed.model,
      agentId: parsed.agentId,
      enableExtensions: parsed.enableExtensions,
      verbose: parsed.verbose,
      onRuntimeReady: (runtime) => {
        printConfigDiagnostics(runtime.configDiagnostics, parsed.verbose);
      },
    });
    return;
  }

  const mode = resolveEffectiveMode(parsed);
  if (!mode) {
    process.exitCode = 1;
    return;
  }
  if (parsed.backend === "gateway") {
    if (parsed.undo || parsed.replay) {
      console.error("Error: --backend gateway is not supported with --undo/--replay.");
      process.exitCode = 1;
      return;
    }
    if (mode === "interactive") {
      console.error("Error: --backend gateway is not supported in interactive mode.");
      process.exitCode = 1;
      return;
    }
    if (mode === "print-json") {
      console.error("Error: --backend gateway is not supported with --mode json.");
      process.exitCode = 1;
      return;
    }
  }
  applyDefaultInteractiveEnv(mode);

  if (parsed.replay) {
    const runtime = new BrewvaRuntime({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
    });
    const targetSessionId = parsed.sessionId ?? runtime.events.listReplaySessions(1)[0]?.sessionId;
    if (!targetSessionId) {
      console.error("Error: no replayable session found.");
      process.exitCode = 1;
      return;
    }
    const events = runtime.events.queryStructured(targetSessionId);
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
    const targetSessionId = runtime.tools.resolveUndoSessionId(parsed.sessionId);
    if (!targetSessionId) {
      console.log("No rollback applied (no_patchset).");
      return;
    }
    const rollback = runtime.tools.rollbackLastPatchSet(targetSessionId);
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

  const pipedInput = await readPipedStdin();
  const taskResolved = loadTaskSpec(parsed);
  if (taskResolved.error) {
    console.error(taskResolved.error);
    process.exitCode = 1;
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

  if (mode !== "interactive" && !initialMessage) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (taskSpec && parsed.backend === "gateway") {
    console.error("Error: --task/--task-file is not supported with --backend gateway.");
    process.exitCode = 1;
    return;
  }

  const shouldAttemptGatewayPrint =
    mode === "print-text" && parsed.backend !== "embedded" && !taskSpec;
  if (mode === "print-text" && parsed.backend === "auto" && taskSpec && parsed.verbose) {
    console.error("[backend] skipping gateway because TaskSpec requires embedded path");
  }

  if (shouldAttemptGatewayPrint) {
    const gatewayResult = await tryGatewayPrint({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      model: parsed.model,
      agentId: parsed.agentId,
      enableExtensions: parsed.enableExtensions,
      prompt: initialMessage ?? "",
      verbose: parsed.verbose,
    });
    if (gatewayResult.ok) {
      writeGatewayAssistantText(gatewayResult.assistantText);
      printGatewayCostSummary({
        cwd: parsed.cwd,
        configPath: parsed.configPath,
        requestedSessionId: gatewayResult.requestedSessionId,
        agentSessionId: gatewayResult.agentSessionId,
      });
      return;
    }

    if (parsed.backend === "gateway") {
      console.error(`gateway: ${gatewayResult.error}`);
      process.exitCode = 1;
      return;
    }

    if (shouldFallbackAfterGatewayFailure(parsed.backend, gatewayResult.stage)) {
      if (parsed.verbose) {
        console.error(
          `[backend] gateway unavailable (${gatewayResult.error}), falling back to embedded`,
        );
      }
    } else {
      console.error(`gateway: ${gatewayResult.error}`);
      process.exitCode = 1;
      return;
    }
  }

  const { session, runtime } = await createBrewvaSession({
    cwd: parsed.cwd,
    configPath: parsed.configPath,
    model: parsed.model,
    agentId: parsed.agentId,
    enableExtensions: parsed.enableExtensions,
  });
  printConfigDiagnostics(runtime.configDiagnostics, parsed.verbose);

  const getSessionId = (): string => session.sessionManager.getSessionId();
  const initialSessionId = getSessionId();
  if (taskSpec) {
    runtime.task.setSpec(initialSessionId, taskSpec);
  }
  const gracefulTimeoutMs = runtime.config.infrastructure.interruptRecovery.gracefulTimeoutMs;
  let terminatedBySignal = false;
  let finalized = false;
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
    runtime.events.record({
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
      await runPrintMode(session, {
        mode: "json",
        initialMessage,
      });
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
      ensureSessionShutdownRecorded(runtime, sessionId);
      if (emitJsonBundle) {
        const replayEvents = runtime.events.queryStructured(sessionId);
        await writeJsonLine({
          schema: "brewva.stream.v1",
          type: "brewva_event_bundle",
          sessionId,
          events: replayEvents,
          costSummary: runtime.cost.getSummary(sessionId),
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
export {
  SUPPORTED_CHANNELS,
  canonicalizeInboundTurnSession,
  collectPromptTurnOutputs,
  resolveSupportedChannel,
} from "./channel-mode.js";
export { JsonLineWriter, type JsonLineWritable, writeJsonLine } from "./json-lines.js";
export {
  resolveBackendWorkingCwd,
  resolveGatewayFailureStage,
  shouldFallbackAfterGatewayFailure,
} from "./gateway-print.js";
export { registerRuntimeCoreEventBridge } from "./session-event-bridge.js";
