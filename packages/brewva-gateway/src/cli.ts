import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import { BrewvaConfigLoadError, resolveBrewvaAgentDir } from "@brewva/brewva-runtime";
import { readGatewayToken } from "./auth.js";
import { connectGatewayClient } from "./client.js";
import { GatewayDaemon } from "./daemon/gateway-daemon.js";
import {
  isProcessAlive,
  readPidRecord,
  removePidRecord,
  type GatewayPidRecord,
} from "./daemon/pid.js";
import {
  GatewaySupervisorDefaults,
  buildGatewaySupervisorCommand,
  installGatewayService,
  resolveSupervisorKind,
  uninstallGatewayService,
} from "./daemon/service-manager.js";
import { assertLoopbackHost, normalizeGatewayHost } from "./network.js";
import { sleep } from "./utils/async.js";
import { toErrorMessage } from "./utils/errors.js";

function formatGatewayStartupError(error: unknown): string {
  if (error instanceof BrewvaConfigLoadError) {
    return `[config:error] ${error.configPath}: ${error.message}`;
  }
  return toErrorMessage(error);
}

export interface GatewayPaths {
  stateDir: string;
  pidFilePath: string;
  logFilePath: string;
  tokenFilePath: string;
  heartbeatPolicyPath: string;
}

export interface GatewayStatusReport {
  running: boolean;
  reachable: boolean;
  stalePid: boolean;
  pidRecord?: GatewayPidRecord;
  host?: string;
  port?: number;
  health?: unknown;
  deep?: unknown;
  error?: string;
}

export interface RunGatewayCliOptions {
  allowUnknownCommandFallback?: boolean;
}

export interface RunGatewayCliResult {
  handled: boolean;
  exitCode: number;
}

const START_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  detach: { type: "boolean" },
  foreground: { type: "boolean" },
  "wait-ms": { type: "string" },
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
  "no-addons": { type: "boolean" },
  json: { type: "boolean" },
  "tick-interval-ms": { type: "string" },
  "session-idle-ms": { type: "string" },
  "max-workers": { type: "string" },
  "max-open-queue": { type: "string" },
  "max-payload-bytes": { type: "string" },
  "health-http-port": { type: "string" },
  "health-http-path": { type: "string" },
} as const;

const STATUS_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  deep: { type: "boolean" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "token-file": { type: "string" },
  "timeout-ms": { type: "string" },
} as const;

const STOP_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  force: { type: "boolean" },
  reason: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "token-file": { type: "string" },
  "timeout-ms": { type: "string" },
} as const;

const HEARTBEAT_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "token-file": { type: "string" },
  "timeout-ms": { type: "string" },
} as const;

const ROTATE_TOKEN_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "token-file": { type: "string" },
  "timeout-ms": { type: "string" },
} as const;

const LOGS_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  "state-dir": { type: "string" },
  "log-file": { type: "string" },
  tail: { type: "string" },
} as const;

const INSTALL_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
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
  "no-addons": { type: "boolean" },
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

const UNINSTALL_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  launchd: { type: "boolean" },
  systemd: { type: "boolean" },
  "dry-run": { type: "boolean" },
  label: { type: "string" },
  "service-name": { type: "string" },
  "plist-file": { type: "string" },
  "unit-file": { type: "string" },
} as const;

function parseOptionalIntegerFlag(
  flag: string,
  raw: unknown,
  options: {
    minimum?: number;
    maximum?: number;
  } = {},
): { value?: number; error?: string } {
  if (typeof raw !== "string") {
    return {};
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: `Error: --${flag} must be an integer.` };
  }

  const value = Number(trimmed);
  if (!Number.isInteger(value)) {
    return { error: `Error: --${flag} must be an integer.` };
  }
  if (options.minimum !== undefined && value < options.minimum) {
    return { error: `Error: --${flag} must be >= ${options.minimum}.` };
  }
  if (options.maximum !== undefined && value > options.maximum) {
    return { error: `Error: --${flag} must be <= ${options.maximum}.` };
  }
  return { value };
}

function pushStringFlag(args: string[], name: string, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized) {
    return;
  }
  args.push(`--${name}`, normalized);
}

function resolveDetachedBootstrapPrefix(): string[] {
  const entryArg = process.argv[1];
  if (typeof entryArg !== "string" || !entryArg.trim()) {
    return [];
  }
  const resolved = resolve(entryArg);
  if (!existsSync(resolved)) {
    return [];
  }
  if (!/\.[cm]?[jt]s$/iu.test(resolved)) {
    return [];
  }
  return [resolved];
}

function isLikelyBrewvaEntrypoint(filePath: string | undefined): boolean {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return false;
  }
  const resolved = resolve(filePath);
  const normalized = resolved.toLowerCase();
  const baseName = normalized.split(/[\\/]/u).pop() ?? "";
  if (baseName === "brewva" || baseName === "brewva.exe") {
    return true;
  }
  if (baseName.startsWith("brewva.")) {
    return true;
  }
  if (
    normalized.includes("/packages/brewva-cli/") ||
    normalized.includes("\\packages\\brewva-cli\\")
  ) {
    return true;
  }
  if (normalized.includes("/distribution/") && baseName.startsWith("brewva")) {
    return true;
  }
  return false;
}

function buildDetachedStartArgs(values: Readonly<Record<string, unknown>>): string[] {
  const args = ["gateway", "start", "--foreground"];
  pushStringFlag(args, "cwd", values.cwd);
  pushStringFlag(args, "config", values.config);
  pushStringFlag(args, "model", values.model);
  pushStringFlag(args, "host", values.host);
  pushStringFlag(args, "port", values.port);
  pushStringFlag(args, "state-dir", values["state-dir"]);
  pushStringFlag(args, "pid-file", values["pid-file"]);
  pushStringFlag(args, "log-file", values["log-file"]);
  pushStringFlag(args, "token-file", values["token-file"]);
  pushStringFlag(args, "heartbeat", values.heartbeat);
  pushStringFlag(args, "tick-interval-ms", values["tick-interval-ms"]);
  pushStringFlag(args, "session-idle-ms", values["session-idle-ms"]);
  pushStringFlag(args, "max-workers", values["max-workers"]);
  pushStringFlag(args, "max-open-queue", values["max-open-queue"]);
  pushStringFlag(args, "max-payload-bytes", values["max-payload-bytes"]);
  pushStringFlag(args, "health-http-port", values["health-http-port"]);
  pushStringFlag(args, "health-http-path", values["health-http-path"]);
  if (values["no-addons"] === true) {
    args.push("--no-addons");
  }
  return args;
}

function parseOptionalPathFlag(flag: string, raw: unknown): { value?: string; error?: string } {
  if (typeof raw !== "string") {
    return {};
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: `Error: --${flag} must be a non-empty path.` };
  }
  return {
    value: trimmed.startsWith("/") ? trimmed : `/${trimmed}`,
  };
}

async function waitForGatewayReady(
  paths: GatewayPaths,
  waitMs: number,
): Promise<GatewayStatusReport> {
  const timeoutMs = Math.max(200, waitMs);
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const status = await queryGatewayStatus({
      paths,
      deep: false,
      timeoutMs: Math.min(1_000, timeoutMs),
    });
    if (status.running && status.reachable) {
      return status;
    }
    if (status.error) {
      lastError = status.error;
    }
    await sleep(120);
  }

  if (lastError) {
    throw new Error(`gateway did not become ready: ${lastError}`);
  }
  throw new Error(`gateway did not become ready within ${timeoutMs}ms`);
}

function readTailLines(filePath: string, tail: number): string[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (tail <= 0) {
    return lines;
  }
  return lines.slice(-tail);
}

export function resolveGatewayPaths(input: {
  stateDir?: string;
  pidFilePath?: string;
  logFilePath?: string;
  tokenFilePath?: string;
  heartbeatPolicyPath?: string;
}): GatewayPaths {
  const stateDir = resolve(input.stateDir ?? join(resolveBrewvaAgentDir(), "gateway"));
  return {
    stateDir,
    pidFilePath: resolve(input.pidFilePath ?? join(stateDir, "gateway.pid.json")),
    logFilePath: resolve(input.logFilePath ?? join(stateDir, "gateway.log")),
    tokenFilePath: resolve(input.tokenFilePath ?? join(stateDir, "gateway.token")),
    heartbeatPolicyPath: resolve(input.heartbeatPolicyPath ?? join(stateDir, "HEARTBEAT.md")),
  };
}

function printGatewayHelp(): void {
  console.log(`Brewva Gateway - local control plane daemon

Usage:
  brewva gateway <command> [options]

Commands:
  start               Start gateway daemon (foreground by default; add --detach for background)
  install             Install OS supervisor service (launchd on macOS, systemd --user on Linux)
  uninstall           Uninstall OS supervisor service
  status              Probe daemon health or deep status
  stop                Ask daemon to stop and wait for process exit (--force enables SIGTERM fallback)
  heartbeat-reload    Reload HEARTBEAT.md policy without restart
  rotate-token        Rotate control-plane token and revoke old authenticated clients
  logs                Print gateway daemon logs (tail)
  help                Show this help

Examples:
  brewva gateway start
  brewva gateway start --detach
  brewva gateway start --health-http-port 43112
  brewva gateway install
  brewva gateway install --systemd
  brewva gateway uninstall
  brewva gateway status --deep --json
  brewva gateway logs --tail 200
  brewva gateway heartbeat-reload
  brewva gateway rotate-token
  brewva gateway stop`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(100, timeoutMs);
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

export async function queryGatewayStatus(input: {
  paths: GatewayPaths;
  deep: boolean;
  timeoutMs: number;
  hostOverride?: string;
  portOverride?: number;
}): Promise<GatewayStatusReport> {
  const pidRecord = readPidRecord(input.paths.pidFilePath);
  if (!pidRecord) {
    return {
      running: false,
      reachable: false,
      stalePid: false,
    };
  }

  if (!isProcessAlive(pidRecord.pid)) {
    return {
      running: false,
      reachable: false,
      stalePid: true,
      pidRecord,
    };
  }

  const host = normalizeGatewayHost(input.hostOverride ?? pidRecord.host);
  assertLoopbackHost(host);
  const port = input.portOverride ?? pidRecord.port;
  const token = readGatewayToken(input.paths.tokenFilePath);
  if (!token) {
    return {
      running: true,
      reachable: false,
      stalePid: false,
      pidRecord,
      host,
      port,
      error: `gateway token missing: ${input.paths.tokenFilePath}`,
    };
  }

  try {
    const client = await connectGatewayClient({
      host,
      port,
      token,
      connectTimeoutMs: input.timeoutMs,
      requestTimeoutMs: input.timeoutMs,
    });
    const payload = await client.request(input.deep ? "status.deep" : "health", {});
    await client.close();

    return {
      running: true,
      reachable: true,
      stalePid: false,
      pidRecord,
      host,
      port,
      health: input.deep ? undefined : payload,
      deep: input.deep ? payload : undefined,
    };
  } catch (error) {
    return {
      running: true,
      reachable: false,
      stalePid: false,
      pidRecord,
      host,
      port,
      error: toErrorMessage(error),
    };
  }
}

function printStatusText(status: GatewayStatusReport, deep: boolean, paths: GatewayPaths): void {
  if (!status.running) {
    if (status.stalePid && status.pidRecord) {
      console.log(
        `gateway: stale pid file (${paths.pidFilePath}); pid=${status.pidRecord.pid} is not alive.`,
      );
      return;
    }
    console.log(`gateway: not running (pid file: ${paths.pidFilePath})`);
    return;
  }

  if (!status.reachable) {
    console.log(
      `gateway: process is alive (pid=${status.pidRecord?.pid}) but probe failed: ${status.error ?? "unknown error"}`,
    );
    return;
  }

  console.log(
    `gateway: running pid=${status.pidRecord?.pid} host=${status.host} port=${status.port} deep=${deep ? "yes" : "no"}`,
  );
  if (deep && status.deep !== undefined) {
    console.log(JSON.stringify(status.deep, null, 2));
  }
}

async function handleStart(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: START_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printGatewayHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(
      `Error: unexpected positional args for gateway start: ${parsed.positionals.join(" ")}`,
    );
    return 1;
  }
  if (parsed.values.detach === true && parsed.values.foreground === true) {
    console.error("Error: --detach and --foreground cannot be used together.");
    return 1;
  }

  const portParsed = parseOptionalIntegerFlag("port", parsed.values.port, {
    minimum: 1,
    maximum: 65535,
  });
  if (portParsed.error) {
    console.error(portParsed.error);
    return 1;
  }

  const tickParsed = parseOptionalIntegerFlag(
    "tick-interval-ms",
    parsed.values["tick-interval-ms"],
    {
      minimum: 1000,
    },
  );
  if (tickParsed.error) {
    console.error(tickParsed.error);
    return 1;
  }

  const maxPayloadParsed = parseOptionalIntegerFlag(
    "max-payload-bytes",
    parsed.values["max-payload-bytes"],
    { minimum: 16 * 1024 },
  );
  if (maxPayloadParsed.error) {
    console.error(maxPayloadParsed.error);
    return 1;
  }
  const sessionIdleParsed = parseOptionalIntegerFlag(
    "session-idle-ms",
    parsed.values["session-idle-ms"],
    { minimum: 1_000 },
  );
  if (sessionIdleParsed.error) {
    console.error(sessionIdleParsed.error);
    return 1;
  }
  const maxWorkersParsed = parseOptionalIntegerFlag("max-workers", parsed.values["max-workers"], {
    minimum: 1,
  });
  if (maxWorkersParsed.error) {
    console.error(maxWorkersParsed.error);
    return 1;
  }
  const maxQueueParsed = parseOptionalIntegerFlag(
    "max-open-queue",
    parsed.values["max-open-queue"],
    {
      minimum: 0,
    },
  );
  if (maxQueueParsed.error) {
    console.error(maxQueueParsed.error);
    return 1;
  }
  const waitParsed = parseOptionalIntegerFlag("wait-ms", parsed.values["wait-ms"], {
    minimum: 200,
  });
  if (waitParsed.error) {
    console.error(waitParsed.error);
    return 1;
  }
  const healthPortParsed = parseOptionalIntegerFlag(
    "health-http-port",
    parsed.values["health-http-port"],
    {
      minimum: 1,
      maximum: 65535,
    },
  );
  if (healthPortParsed.error) {
    console.error(healthPortParsed.error);
    return 1;
  }
  const healthPathParsed = parseOptionalPathFlag(
    "health-http-path",
    parsed.values["health-http-path"],
  );
  if (healthPathParsed.error) {
    console.error(healthPathParsed.error);
    return 1;
  }

  const host = normalizeGatewayHost(
    typeof parsed.values.host === "string" ? parsed.values.host : undefined,
  );
  try {
    assertLoopbackHost(host);
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }

  const paths = resolveGatewayPaths({
    stateDir:
      typeof parsed.values["state-dir"] === "string" ? parsed.values["state-dir"] : undefined,
    pidFilePath:
      typeof parsed.values["pid-file"] === "string" ? parsed.values["pid-file"] : undefined,
    logFilePath:
      typeof parsed.values["log-file"] === "string" ? parsed.values["log-file"] : undefined,
    tokenFilePath:
      typeof parsed.values["token-file"] === "string" ? parsed.values["token-file"] : undefined,
    heartbeatPolicyPath:
      typeof parsed.values.heartbeat === "string" ? parsed.values.heartbeat : undefined,
  });

  const jsonMode = parsed.values.json === true;
  const detachMode = parsed.values.detach === true && parsed.values.foreground !== true;
  const existing = readPidRecord(paths.pidFilePath);
  if (existing && isProcessAlive(existing.pid)) {
    const payload = {
      schema: "brewva.gateway.lifecycle.v1",
      event: "already_running",
      pid: existing.pid,
      host: existing.host,
      port: existing.port,
      pidFilePath: paths.pidFilePath,
    };
    if (jsonMode) {
      console.log(JSON.stringify(payload));
    } else {
      console.log(
        `gateway: already running pid=${existing.pid} host=${existing.host} port=${existing.port}`,
      );
    }
    return 0;
  }
  if (existing && !isProcessAlive(existing.pid)) {
    removePidRecord(paths.pidFilePath);
  }

  if (detachMode) {
    const childArgs = [
      ...resolveDetachedBootstrapPrefix(),
      ...buildDetachedStartArgs(parsed.values),
    ];
    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    try {
      const status = await waitForGatewayReady(paths, waitParsed.value ?? 8_000);
      if (jsonMode) {
        console.log(
          JSON.stringify({
            schema: "brewva.gateway.lifecycle.v1",
            event: "started_detached",
            launcherPid: process.pid,
            childPid: child.pid,
            pid: status.pidRecord?.pid ?? null,
            host: status.host ?? null,
            port: status.port ?? null,
            pidFilePath: paths.pidFilePath,
            logFilePath: paths.logFilePath,
          }),
        );
      } else {
        console.log(
          `gateway: detached pid=${status.pidRecord?.pid} host=${status.host} port=${status.port} pid_file=${paths.pidFilePath}`,
        );
      }
      return 0;
    } catch (error) {
      if (jsonMode) {
        console.log(
          JSON.stringify({
            schema: "brewva.gateway.lifecycle.v1",
            event: "detach_failed",
            childPid: child.pid,
            error: toErrorMessage(error),
            pidFilePath: paths.pidFilePath,
          }),
        );
      } else {
        console.error(`gateway: detached start failed (${toErrorMessage(error)})`);
      }
      return 2;
    }
  }

  try {
    const daemon = new GatewayDaemon({
      host,
      port: portParsed.value,
      stateDir: paths.stateDir,
      pidFilePath: paths.pidFilePath,
      logFilePath: paths.logFilePath,
      tokenFilePath: paths.tokenFilePath,
      heartbeatPolicyPath: paths.heartbeatPolicyPath,
      cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : process.cwd(),
      configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
      model: typeof parsed.values.model === "string" ? parsed.values.model : undefined,
      enableExtensions: parsed.values["no-addons"] !== true,
      jsonStdout: jsonMode,
      tickIntervalMs: tickParsed.value,
      sessionIdleTtlMs: sessionIdleParsed.value,
      maxWorkers: maxWorkersParsed.value,
      maxPendingSessionOpens: maxQueueParsed.value,
      maxPayloadBytes: maxPayloadParsed.value,
      healthHttpPort: healthPortParsed.value,
      healthHttpPath: healthPathParsed.value,
    });
    await daemon.start();
    const runtime = daemon.getRuntimeInfo();
    if (jsonMode) {
      console.log(
        JSON.stringify({
          schema: "brewva.gateway.lifecycle.v1",
          event: "started",
          ...runtime,
        }),
      );
    } else {
      console.log(
        `gateway: started pid=${runtime.pid} host=${runtime.host} port=${runtime.port} pid_file=${runtime.pidFilePath}`,
      );
    }

    await daemon.waitForStop();
    if (jsonMode) {
      console.log(
        JSON.stringify({
          schema: "brewva.gateway.lifecycle.v1",
          event: "stopped",
          pid: runtime.pid,
        }),
      );
    } else {
      console.log("gateway: stopped");
    }
    return 0;
  } catch (error) {
    console.error(`gateway: failed to start (${formatGatewayStartupError(error)})`);
    return 1;
  }
}

async function handleStatus(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: STATUS_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printGatewayHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(
      `Error: unexpected positional args for gateway status: ${parsed.positionals.join(" ")}`,
    );
    return 1;
  }

  const timeoutParsed = parseOptionalIntegerFlag("timeout-ms", parsed.values["timeout-ms"], {
    minimum: 100,
  });
  if (timeoutParsed.error) {
    console.error(timeoutParsed.error);
    return 1;
  }
  const portParsed = parseOptionalIntegerFlag("port", parsed.values.port, {
    minimum: 1,
    maximum: 65535,
  });
  if (portParsed.error) {
    console.error(portParsed.error);
    return 1;
  }

  const paths = resolveGatewayPaths({
    stateDir:
      typeof parsed.values["state-dir"] === "string" ? parsed.values["state-dir"] : undefined,
    pidFilePath:
      typeof parsed.values["pid-file"] === "string" ? parsed.values["pid-file"] : undefined,
    tokenFilePath:
      typeof parsed.values["token-file"] === "string" ? parsed.values["token-file"] : undefined,
  });

  const hostOverride =
    typeof parsed.values.host === "string" ? normalizeGatewayHost(parsed.values.host) : undefined;
  if (hostOverride) {
    try {
      assertLoopbackHost(hostOverride);
    } catch (error) {
      console.error(`Error: ${toErrorMessage(error)}`);
      return 1;
    }
  }

  const deep = parsed.values.deep === true;
  const jsonMode = parsed.values.json === true;
  const status = await queryGatewayStatus({
    paths,
    deep,
    timeoutMs: timeoutParsed.value ?? 3_000,
    hostOverride,
    portOverride: portParsed.value,
  });

  if (jsonMode) {
    console.log(
      JSON.stringify({
        schema: "brewva.gateway.status.v1",
        ...status,
        pidFilePath: paths.pidFilePath,
        tokenFilePath: paths.tokenFilePath,
      }),
    );
  } else {
    printStatusText(status, deep, paths);
  }

  if (!status.running) {
    return 1;
  }
  if (!status.reachable) {
    return 2;
  }
  return 0;
}

async function handleStop(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: STOP_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printGatewayHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(
      `Error: unexpected positional args for gateway stop: ${parsed.positionals.join(" ")}`,
    );
    return 1;
  }

  const timeoutParsed = parseOptionalIntegerFlag("timeout-ms", parsed.values["timeout-ms"], {
    minimum: 100,
  });
  if (timeoutParsed.error) {
    console.error(timeoutParsed.error);
    return 1;
  }
  const portParsed = parseOptionalIntegerFlag("port", parsed.values.port, {
    minimum: 1,
    maximum: 65535,
  });
  if (portParsed.error) {
    console.error(portParsed.error);
    return 1;
  }

  const jsonMode = parsed.values.json === true;
  const timeoutMs = timeoutParsed.value ?? 8_000;
  const reason = typeof parsed.values.reason === "string" ? parsed.values.reason : "cli_stop";
  const paths = resolveGatewayPaths({
    stateDir:
      typeof parsed.values["state-dir"] === "string" ? parsed.values["state-dir"] : undefined,
    pidFilePath:
      typeof parsed.values["pid-file"] === "string" ? parsed.values["pid-file"] : undefined,
    tokenFilePath:
      typeof parsed.values["token-file"] === "string" ? parsed.values["token-file"] : undefined,
  });

  const pidRecord = readPidRecord(paths.pidFilePath);
  if (!pidRecord) {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          schema: "brewva.gateway.stop.v1",
          stopped: false,
          reason: "not_running",
        }),
      );
    } else {
      console.log("gateway: not running");
    }
    return 0;
  }

  if (!isProcessAlive(pidRecord.pid)) {
    removePidRecord(paths.pidFilePath);
    if (jsonMode) {
      console.log(
        JSON.stringify({
          schema: "brewva.gateway.stop.v1",
          stopped: true,
          reason: "stale_pid_removed",
          pid: pidRecord.pid,
        }),
      );
    } else {
      console.log(`gateway: removed stale pid file for pid=${pidRecord.pid}`);
    }
    return 0;
  }

  const host = normalizeGatewayHost(
    typeof parsed.values.host === "string" ? parsed.values.host : pidRecord.host,
  );
  try {
    assertLoopbackHost(host);
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }
  const port = portParsed.value ?? pidRecord.port;
  const token = readGatewayToken(paths.tokenFilePath);
  if (!token) {
    console.error(`gateway: token file missing or empty (${paths.tokenFilePath})`);
    return 1;
  }

  let stopRequestError: string | undefined;
  try {
    const client = await connectGatewayClient({
      host,
      port,
      token,
      connectTimeoutMs: timeoutMs,
      requestTimeoutMs: timeoutMs,
    });
    await client.request("gateway.stop", { reason });
    await client.close();
  } catch (error) {
    stopRequestError = toErrorMessage(error);
  }

  let exited = await waitForProcessExit(pidRecord.pid, timeoutMs);
  if (!exited && parsed.values.force === true) {
    try {
      process.kill(pidRecord.pid, "SIGTERM");
    } catch (error) {
      stopRequestError = stopRequestError ?? toErrorMessage(error);
    }
    exited = await waitForProcessExit(pidRecord.pid, 3_000);
  }

  if (exited) {
    removePidRecord(paths.pidFilePath);
    if (jsonMode) {
      console.log(
        JSON.stringify({
          schema: "brewva.gateway.stop.v1",
          stopped: true,
          pid: pidRecord.pid,
          reason,
          stopRequestError: stopRequestError ?? null,
        }),
      );
    } else {
      console.log(`gateway: stopped pid=${pidRecord.pid}`);
    }
    return 0;
  }

  const errorText = stopRequestError
    ? `stop request failed and process still alive: ${stopRequestError}`
    : parsed.values.force === true
      ? "process is still alive after force timeout"
      : "process is still alive after timeout (use --force to send SIGTERM fallback)";
  if (jsonMode) {
    console.log(
      JSON.stringify({
        schema: "brewva.gateway.stop.v1",
        stopped: false,
        pid: pidRecord.pid,
        reason: errorText,
      }),
    );
  } else {
    console.error(`gateway: ${errorText}`);
  }
  return 2;
}

async function handleHeartbeatReload(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: HEARTBEAT_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printGatewayHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(
      `Error: unexpected positional args for gateway heartbeat-reload: ${parsed.positionals.join(" ")}`,
    );
    return 1;
  }

  const timeoutParsed = parseOptionalIntegerFlag("timeout-ms", parsed.values["timeout-ms"], {
    minimum: 100,
  });
  if (timeoutParsed.error) {
    console.error(timeoutParsed.error);
    return 1;
  }
  const portParsed = parseOptionalIntegerFlag("port", parsed.values.port, {
    minimum: 1,
    maximum: 65535,
  });
  if (portParsed.error) {
    console.error(portParsed.error);
    return 1;
  }

  const paths = resolveGatewayPaths({
    stateDir:
      typeof parsed.values["state-dir"] === "string" ? parsed.values["state-dir"] : undefined,
    pidFilePath:
      typeof parsed.values["pid-file"] === "string" ? parsed.values["pid-file"] : undefined,
    tokenFilePath:
      typeof parsed.values["token-file"] === "string" ? parsed.values["token-file"] : undefined,
  });

  const pidRecord = readPidRecord(paths.pidFilePath);
  if (!pidRecord || !isProcessAlive(pidRecord.pid)) {
    console.error("gateway: not running");
    return 1;
  }

  const host = normalizeGatewayHost(
    typeof parsed.values.host === "string" ? parsed.values.host : pidRecord.host,
  );
  try {
    assertLoopbackHost(host);
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }
  const port = portParsed.value ?? pidRecord.port;
  const timeoutMs = timeoutParsed.value ?? 3_000;
  const token = readGatewayToken(paths.tokenFilePath);
  if (!token) {
    console.error(`gateway: token file missing or empty (${paths.tokenFilePath})`);
    return 1;
  }

  try {
    const client = await connectGatewayClient({
      host,
      port,
      token,
      connectTimeoutMs: timeoutMs,
      requestTimeoutMs: timeoutMs,
    });
    const payload = await client.request("heartbeat.reload", {});
    await client.close();

    if (parsed.values.json === true) {
      console.log(
        JSON.stringify({
          schema: "brewva.gateway.heartbeat-reload.v1",
          ok: true,
          payload,
        }),
      );
    } else {
      console.log("gateway: heartbeat policy reloaded");
    }
    return 0;
  } catch (error) {
    console.error(`gateway: heartbeat reload failed (${toErrorMessage(error)})`);
    return 1;
  }
}

async function handleRotateToken(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: ROTATE_TOKEN_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printGatewayHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(
      `Error: unexpected positional args for gateway rotate-token: ${parsed.positionals.join(" ")}`,
    );
    return 1;
  }

  const timeoutParsed = parseOptionalIntegerFlag("timeout-ms", parsed.values["timeout-ms"], {
    minimum: 100,
  });
  if (timeoutParsed.error) {
    console.error(timeoutParsed.error);
    return 1;
  }
  const portParsed = parseOptionalIntegerFlag("port", parsed.values.port, {
    minimum: 1,
    maximum: 65535,
  });
  if (portParsed.error) {
    console.error(portParsed.error);
    return 1;
  }

  const paths = resolveGatewayPaths({
    stateDir:
      typeof parsed.values["state-dir"] === "string" ? parsed.values["state-dir"] : undefined,
    pidFilePath:
      typeof parsed.values["pid-file"] === "string" ? parsed.values["pid-file"] : undefined,
    tokenFilePath:
      typeof parsed.values["token-file"] === "string" ? parsed.values["token-file"] : undefined,
  });

  const pidRecord = readPidRecord(paths.pidFilePath);
  if (!pidRecord || !isProcessAlive(pidRecord.pid)) {
    console.error("gateway: not running");
    return 1;
  }

  const host = normalizeGatewayHost(
    typeof parsed.values.host === "string" ? parsed.values.host : pidRecord.host,
  );
  try {
    assertLoopbackHost(host);
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }
  const port = portParsed.value ?? pidRecord.port;
  const timeoutMs = timeoutParsed.value ?? 3_000;
  const token = readGatewayToken(paths.tokenFilePath);
  if (!token) {
    console.error(`gateway: token file missing or empty (${paths.tokenFilePath})`);
    return 1;
  }

  try {
    const client = await connectGatewayClient({
      host,
      port,
      token,
      connectTimeoutMs: timeoutMs,
      requestTimeoutMs: timeoutMs,
    });
    const payload = await client.request("gateway.rotate-token", {});
    await client.close();

    if (parsed.values.json === true) {
      console.log(
        JSON.stringify({
          schema: "brewva.gateway.rotate-token.v1",
          ok: true,
          payload,
        }),
      );
    } else {
      const result = (payload ?? {}) as { revokedConnections?: unknown };
      const revokedConnections =
        typeof result.revokedConnections === "number" ? result.revokedConnections : "unknown";
      console.log(`gateway: token rotated (revoked_connections=${revokedConnections})`);
    }
    return 0;
  } catch (error) {
    console.error(`gateway: token rotation failed (${toErrorMessage(error)})`);
    return 1;
  }
}

async function handleLogs(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: LOGS_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printGatewayHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(
      `Error: unexpected positional args for gateway logs: ${parsed.positionals.join(" ")}`,
    );
    return 1;
  }

  const tailParsed = parseOptionalIntegerFlag("tail", parsed.values.tail, {
    minimum: 1,
  });
  if (tailParsed.error) {
    console.error(tailParsed.error);
    return 1;
  }

  const paths = resolveGatewayPaths({
    stateDir:
      typeof parsed.values["state-dir"] === "string" ? parsed.values["state-dir"] : undefined,
    logFilePath:
      typeof parsed.values["log-file"] === "string" ? parsed.values["log-file"] : undefined,
  });
  const tail = tailParsed.value ?? 200;
  const lines = readTailLines(paths.logFilePath, tail);
  const jsonMode = parsed.values.json === true;

  if (jsonMode) {
    console.log(
      JSON.stringify({
        schema: "brewva.gateway.logs.v1",
        logFilePath: paths.logFilePath,
        tail,
        exists: existsSync(paths.logFilePath),
        lines,
      }),
    );
    return 0;
  }

  if (!existsSync(paths.logFilePath)) {
    console.log(`gateway: log file not found (${paths.logFilePath})`);
    return 0;
  }
  if (lines.length === 0) {
    console.log(`gateway: log file is empty (${paths.logFilePath})`);
    return 0;
  }

  for (const line of lines) {
    console.log(line);
  }
  return 0;
}

function printSupervisorCommandResults(commands: Array<{ command: string; ok: boolean }>): void {
  for (const command of commands) {
    const status = command.ok ? "ok" : "failed";
    console.log(`gateway: supervisor command ${status}: ${command.command}`);
  }
}

async function handleInstall(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: INSTALL_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printGatewayHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(
      `Error: unexpected positional args for gateway install: ${parsed.positionals.join(" ")}`,
    );
    return 1;
  }

  const supervisor = resolveSupervisorKind({
    launchd: parsed.values.launchd === true,
    systemd: parsed.values.systemd === true,
    platform: process.platform,
  });
  if (supervisor.error || !supervisor.kind) {
    console.error(supervisor.error ?? "Error: failed to resolve supervisor type.");
    return 1;
  }

  const portParsed = parseOptionalIntegerFlag("port", parsed.values.port, {
    minimum: 1,
    maximum: 65535,
  });
  if (portParsed.error) {
    console.error(portParsed.error);
    return 1;
  }
  const tickParsed = parseOptionalIntegerFlag(
    "tick-interval-ms",
    parsed.values["tick-interval-ms"],
    { minimum: 1000 },
  );
  if (tickParsed.error) {
    console.error(tickParsed.error);
    return 1;
  }
  const maxPayloadParsed = parseOptionalIntegerFlag(
    "max-payload-bytes",
    parsed.values["max-payload-bytes"],
    { minimum: 16 * 1024 },
  );
  if (maxPayloadParsed.error) {
    console.error(maxPayloadParsed.error);
    return 1;
  }
  const sessionIdleParsed = parseOptionalIntegerFlag(
    "session-idle-ms",
    parsed.values["session-idle-ms"],
    { minimum: 1_000 },
  );
  if (sessionIdleParsed.error) {
    console.error(sessionIdleParsed.error);
    return 1;
  }
  const maxWorkersParsed = parseOptionalIntegerFlag("max-workers", parsed.values["max-workers"], {
    minimum: 1,
  });
  if (maxWorkersParsed.error) {
    console.error(maxWorkersParsed.error);
    return 1;
  }
  const maxQueueParsed = parseOptionalIntegerFlag(
    "max-open-queue",
    parsed.values["max-open-queue"],
    { minimum: 0 },
  );
  if (maxQueueParsed.error) {
    console.error(maxQueueParsed.error);
    return 1;
  }
  const healthPortParsed = parseOptionalIntegerFlag(
    "health-http-port",
    parsed.values["health-http-port"],
    { minimum: 1, maximum: 65535 },
  );
  if (healthPortParsed.error) {
    console.error(healthPortParsed.error);
    return 1;
  }
  const healthPathParsed = parseOptionalPathFlag(
    "health-http-path",
    parsed.values["health-http-path"],
  );
  if (healthPathParsed.error) {
    console.error(healthPathParsed.error);
    return 1;
  }

  const host = normalizeGatewayHost(
    typeof parsed.values.host === "string" ? parsed.values.host : undefined,
  );
  try {
    assertLoopbackHost(host);
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }

  const daemonCwd = typeof parsed.values.cwd === "string" ? parsed.values.cwd : process.cwd();
  const paths = resolveGatewayPaths({
    stateDir:
      typeof parsed.values["state-dir"] === "string" ? parsed.values["state-dir"] : undefined,
    pidFilePath:
      typeof parsed.values["pid-file"] === "string" ? parsed.values["pid-file"] : undefined,
    logFilePath:
      typeof parsed.values["log-file"] === "string" ? parsed.values["log-file"] : undefined,
    tokenFilePath:
      typeof parsed.values["token-file"] === "string" ? parsed.values["token-file"] : undefined,
    heartbeatPolicyPath:
      typeof parsed.values.heartbeat === "string" ? parsed.values.heartbeat : undefined,
  });

  const startValues: Record<string, unknown> = {
    ...parsed.values,
    cwd: daemonCwd,
    host,
    port: portParsed.value?.toString() ?? parsed.values.port,
    "tick-interval-ms": tickParsed.value?.toString() ?? parsed.values["tick-interval-ms"],
    "session-idle-ms": sessionIdleParsed.value?.toString() ?? parsed.values["session-idle-ms"],
    "max-workers": maxWorkersParsed.value?.toString() ?? parsed.values["max-workers"],
    "max-open-queue": maxQueueParsed.value?.toString() ?? parsed.values["max-open-queue"],
    "max-payload-bytes": maxPayloadParsed.value?.toString() ?? parsed.values["max-payload-bytes"],
    "health-http-port": healthPortParsed.value?.toString() ?? parsed.values["health-http-port"],
    "health-http-path": healthPathParsed.value,
    "state-dir": paths.stateDir,
    "pid-file": paths.pidFilePath,
    "log-file": paths.logFilePath,
    "token-file": paths.tokenFilePath,
    heartbeat: paths.heartbeatPolicyPath,
  };

  const startArgs = buildDetachedStartArgs(startValues);
  const bootstrapPrefixRaw = resolveDetachedBootstrapPrefix();
  const bootstrapPrefix =
    bootstrapPrefixRaw.length > 0 && isLikelyBrewvaEntrypoint(bootstrapPrefixRaw[0])
      ? bootstrapPrefixRaw
      : [];
  const entryArg = isLikelyBrewvaEntrypoint(process.argv[1]) ? process.argv[1] : undefined;
  const programArguments = buildGatewaySupervisorCommand({
    startArgs,
    bootstrapPrefix,
    entryArg,
  });

  const jsonMode = parsed.values.json === true;
  const dryRun = parsed.values["dry-run"] === true;
  const noStart = parsed.values["no-start"] === true;

  try {
    const installResult = installGatewayService({
      kind: supervisor.kind,
      programArguments,
      workingDirectory: daemonCwd,
      logFilePath: paths.logFilePath,
      pathEnv: process.env.PATH,
      label:
        typeof parsed.values.label === "string"
          ? parsed.values.label
          : GatewaySupervisorDefaults.launchdLabel,
      serviceName:
        typeof parsed.values["service-name"] === "string"
          ? parsed.values["service-name"]
          : GatewaySupervisorDefaults.systemdServiceName,
      plistFilePath:
        typeof parsed.values["plist-file"] === "string" ? parsed.values["plist-file"] : undefined,
      unitFilePath:
        typeof parsed.values["unit-file"] === "string" ? parsed.values["unit-file"] : undefined,
      noStart,
      dryRun,
    });

    if (jsonMode) {
      console.log(
        JSON.stringify({
          schema: "brewva.gateway.install.v1",
          ok: true,
          dryRun,
          noStart,
          supervisor: supervisor.kind,
          command: programArguments,
          ...installResult,
        }),
      );
      return 0;
    }

    const modeText = dryRun ? "previewed" : "installed";
    console.log(
      `gateway: ${modeText} ${supervisor.kind} service=${installResult.labelOrService} file=${installResult.filePath}`,
    );
    console.log(`gateway: exec=${programArguments.join(" ")}`);
    if (installResult.commands.length > 0) {
      printSupervisorCommandResults(installResult.commands);
    }

    if (dryRun) {
      return 0;
    }
    if (noStart) {
      if (supervisor.kind === "launchd") {
        console.log(`gateway: start manually with: launchctl load -w ${installResult.filePath}`);
      } else {
        console.log("gateway: start manually with:");
        console.log(
          `  systemctl --user daemon-reload && systemctl --user enable --now ${installResult.labelOrService}`,
        );
      }
      return 0;
    }
    if (supervisor.kind === "systemd") {
      console.log(
        "gateway: tip for reboot persistence without active login: loginctl enable-linger",
      );
    }
    return 0;
  } catch (error) {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          schema: "brewva.gateway.install.v1",
          ok: false,
          dryRun,
          noStart,
          supervisor: supervisor.kind,
          error: toErrorMessage(error),
        }),
      );
    } else {
      console.error(`gateway: install failed (${toErrorMessage(error)})`);
    }
    return 1;
  }
}

async function handleUninstall(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: UNINSTALL_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printGatewayHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(
      `Error: unexpected positional args for gateway uninstall: ${parsed.positionals.join(" ")}`,
    );
    return 1;
  }

  const supervisor = resolveSupervisorKind({
    launchd: parsed.values.launchd === true,
    systemd: parsed.values.systemd === true,
    platform: process.platform,
  });
  if (supervisor.error || !supervisor.kind) {
    console.error(supervisor.error ?? "Error: failed to resolve supervisor type.");
    return 1;
  }

  const dryRun = parsed.values["dry-run"] === true;
  const jsonMode = parsed.values.json === true;

  try {
    const result = uninstallGatewayService({
      kind: supervisor.kind,
      label:
        typeof parsed.values.label === "string"
          ? parsed.values.label
          : GatewaySupervisorDefaults.launchdLabel,
      serviceName:
        typeof parsed.values["service-name"] === "string"
          ? parsed.values["service-name"]
          : GatewaySupervisorDefaults.systemdServiceName,
      plistFilePath:
        typeof parsed.values["plist-file"] === "string" ? parsed.values["plist-file"] : undefined,
      unitFilePath:
        typeof parsed.values["unit-file"] === "string" ? parsed.values["unit-file"] : undefined,
      dryRun,
    });

    if (jsonMode) {
      console.log(
        JSON.stringify({
          schema: "brewva.gateway.uninstall.v1",
          ok: true,
          dryRun,
          supervisor: supervisor.kind,
          ...result,
        }),
      );
      return 0;
    }

    const modeText = dryRun ? "previewed uninstall for" : "uninstalled";
    console.log(
      `gateway: ${modeText} ${supervisor.kind} service=${result.labelOrService} file=${result.filePath}`,
    );
    if (result.commands.length > 0) {
      printSupervisorCommandResults(result.commands);
    }
    return 0;
  } catch (error) {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          schema: "brewva.gateway.uninstall.v1",
          ok: false,
          dryRun,
          supervisor: supervisor.kind,
          error: toErrorMessage(error),
        }),
      );
    } else {
      console.error(`gateway: uninstall failed (${toErrorMessage(error)})`);
    }
    return 1;
  }
}

export async function runGatewayCli(
  argv: string[],
  options: RunGatewayCliOptions = {},
): Promise<RunGatewayCliResult> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printGatewayHelp();
    return {
      handled: true,
      exitCode: 0,
    };
  }

  if (command === "start" || command === "run") {
    return {
      handled: true,
      exitCode: await handleStart(rest),
    };
  }

  if (command === "install") {
    return {
      handled: true,
      exitCode: await handleInstall(rest),
    };
  }

  if (command === "uninstall") {
    return {
      handled: true,
      exitCode: await handleUninstall(rest),
    };
  }

  if (command === "status") {
    return {
      handled: true,
      exitCode: await handleStatus(rest),
    };
  }

  if (command === "stop") {
    return {
      handled: true,
      exitCode: await handleStop(rest),
    };
  }

  if (command === "heartbeat-reload") {
    return {
      handled: true,
      exitCode: await handleHeartbeatReload(rest),
    };
  }

  if (command === "rotate-token") {
    return {
      handled: true,
      exitCode: await handleRotateToken(rest),
    };
  }

  if (command === "logs") {
    return {
      handled: true,
      exitCode: await handleLogs(rest),
    };
  }

  if (options.allowUnknownCommandFallback) {
    return {
      handled: false,
      exitCode: 0,
    };
  }

  console.error(`Error: unknown gateway command "${command}".`);
  printGatewayHelp();
  return {
    handled: true,
    exitCode: 1,
  };
}
