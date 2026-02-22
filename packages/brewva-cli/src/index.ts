#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { format, parseArgs as parseNodeArgs } from "node:util";
import {
  BrewvaRuntime,
  SchedulerService,
  parseScheduleIntentEvent,
  parseTaskSpec,
  type ScheduleIntentProjectionRecord,
  type TaskSpec,
} from "@brewva/brewva-runtime";
import { InteractiveMode, runPrintMode } from "@mariozechner/pi-coding-agent";
import { differenceInSeconds, formatISO } from "date-fns";
import { runChannelMode } from "./channel-mode.js";
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
  -h, --help            Show help

Examples:
  brewva
  brewva "Fix failing tests in runtime"
  brewva --print "Refactor this function"
  brewva --mode json "Summarize recent changes"
  brewva --task-file ./task.json
  brewva --undo --session <session-id>
  brewva --replay --mode json --session <session-id>
  brewva --channel telegram --telegram-token <bot-token>
  brewva --daemon`);
}

type CliMode = "interactive" | "print-text" | "print-json";

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

function resolveModeFromFlag(value: string): CliMode | null {
  if (value === "text") return "print-text";
  if (value === "json") return "print-json";
  console.error(`Error: --mode must be "text" or "json" (received "${value}").`);
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
  const pollTimeout = parseOptionalIntegerFlag(
    "telegram-poll-timeout",
    parsed.values["telegram-poll-timeout"],
  );
  if (pollTimeout.error) {
    console.error(pollTimeout.error);
    return null;
  }
  const pollLimit = parseOptionalIntegerFlag(
    "telegram-poll-limit",
    parsed.values["telegram-poll-limit"],
  );
  if (pollLimit.error) {
    console.error(pollLimit.error);
    return null;
  }
  const pollRetryMs = parseOptionalIntegerFlag(
    "telegram-poll-retry-ms",
    parsed.values["telegram-poll-retry-ms"],
  );
  if (pollRetryMs.error) {
    console.error(pollRetryMs.error);
    return null;
  }

  return {
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
    model: typeof parsed.values.model === "string" ? parsed.values.model : undefined,
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
    const iso = formatISO(event.timestamp);
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

function clampText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}

function ensureSessionShutdownRecorded(runtime: BrewvaRuntime, sessionId: string): void {
  if (runtime.queryEvents(sessionId, { type: "session_shutdown", last: 1 }).length > 0) return;
  runtime.recordEvent({
    sessionId,
    type: "session_shutdown",
  });
}

function inheritScheduleContext(
  runtime: BrewvaRuntime,
  input: { parentSessionId: string; childSessionId: string; continuityMode: "inherit" | "fresh" },
): {
  taskSpecCopied: boolean;
  truthFactsCopied: number;
  parentAnchor?: { id: string; name?: string; summary?: string; nextSteps?: string };
} {
  const parentAnchor = runtime.getTapeStatus(input.parentSessionId).lastAnchor;
  if (input.continuityMode !== "inherit") {
    return {
      taskSpecCopied: false,
      truthFactsCopied: 0,
      parentAnchor,
    };
  }

  const parentTask = runtime.getTaskState(input.parentSessionId);
  if (parentTask.spec) {
    runtime.setTaskSpec(input.childSessionId, parentTask.spec);
  }

  const parentTruth = runtime.getTruthState(input.parentSessionId);
  let copied = 0;
  for (const fact of parentTruth.facts) {
    const result = runtime.upsertTruthFact(input.childSessionId, {
      id: fact.id,
      kind: fact.kind,
      severity: fact.severity,
      summary: fact.summary,
      details: fact.details as Record<string, unknown> | undefined,
      evidenceIds: fact.evidenceIds,
      status: fact.status,
    });
    if (result.ok) {
      copied += 1;
    }
  }

  if (parentAnchor) {
    runtime.recordTapeHandoff(input.childSessionId, {
      name: `schedule:inherit:${parentAnchor.name ?? "parent"}`,
      summary: parentAnchor.summary,
      nextSteps: parentAnchor.nextSteps,
    });
  }

  return {
    taskSpecCopied: Boolean(parentTask.spec),
    truthFactsCopied: copied,
    parentAnchor,
  };
}

function buildScheduleWakeupMessage(input: {
  intent: ScheduleIntentProjectionRecord;
  runIndex: number;
  inherited: {
    taskSpecCopied: boolean;
    truthFactsCopied: number;
    parentAnchor?: { id: string; name?: string; summary?: string; nextSteps?: string };
  };
}): string {
  const anchor = input.inherited.parentAnchor;
  const lines = [
    "[Schedule Wakeup]",
    `intent_id: ${input.intent.intentId}`,
    `parent_session_id: ${input.intent.parentSessionId}`,
    `run_index: ${input.runIndex}`,
    `reason: ${input.intent.reason}`,
    `continuity_mode: ${input.intent.continuityMode}`,
    `time_zone: ${input.intent.timeZone ?? "none"}`,
    `goal_ref: ${input.intent.goalRef ?? "none"}`,
    `inherited_task_spec: ${input.inherited.taskSpecCopied ? "yes" : "no"}`,
    `inherited_truth_facts: ${input.inherited.truthFactsCopied}`,
    `parent_anchor_id: ${anchor?.id ?? "none"}`,
    `parent_anchor_name: ${anchor?.name ?? "none"}`,
  ];

  const anchorSummary = clampText(anchor?.summary, 320);
  if (anchorSummary) lines.push(`parent_anchor_summary: ${anchorSummary}`);
  const nextSteps = clampText(anchor?.nextSteps, 320);
  if (nextSteps) lines.push(`parent_anchor_next_steps: ${nextSteps}`);

  lines.push("Please continue the task from this wakeup context and produce concrete progress.");
  return lines.join("\n");
}

async function runDaemon(parsed: CliArgs): Promise<void> {
  if (parsed.modeExplicit && parsed.mode !== "interactive") {
    console.error("Error: --daemon cannot be combined with --print/--json/--mode.");
    return;
  }
  if (parsed.undo || parsed.replay) {
    console.error("Error: --daemon cannot be combined with --undo/--replay.");
    return;
  }
  if (parsed.taskJson || parsed.taskFile) {
    console.error("Error: --daemon cannot be combined with --task/--task-file.");
    return;
  }
  if (parsed.prompt) {
    console.error("Error: --daemon does not accept prompt text.");
    return;
  }

  const runtime = new BrewvaRuntime({
    cwd: parsed.cwd,
    configPath: parsed.configPath,
  });
  printConfigDiagnostics(runtime.configDiagnostics, parsed.verbose);

  if (!runtime.config.schedule.enabled) {
    console.error("brewva scheduler daemon: disabled by config (schedule.enabled=false).");
    return;
  }
  if (!runtime.config.infrastructure.events.enabled) {
    console.error(
      "brewva scheduler daemon: requires infrastructure.events.enabled=true for durable event replay.",
    );
    return;
  }

  const activeRuns = new Map<string, BrewvaSessionResult["session"]>();
  const summaryWindow = {
    startedAtMs: Date.now(),
    firedIntents: 0,
    erroredIntents: 0,
    deferredIntents: 0,
    circuitOpened: 0,
    childStarted: 0,
    childFinished: 0,
    childFailed: 0,
  };
  const emitSummaryWindow = (reason: "tick" | "shutdown"): void => {
    if (!parsed.verbose) return;
    const nowMs = Date.now();
    const windowSeconds = Math.max(1, differenceInSeconds(nowMs, summaryWindow.startedAtMs));
    console.error(
      `[daemon][${reason}] window_start=${formatISO(new Date(summaryWindow.startedAtMs))} window_s=${windowSeconds} fired=${summaryWindow.firedIntents} errored=${summaryWindow.erroredIntents} deferred=${summaryWindow.deferredIntents} circuit_opened=${summaryWindow.circuitOpened} child_started=${summaryWindow.childStarted} child_finished=${summaryWindow.childFinished} child_failed=${summaryWindow.childFailed}`,
    );
    summaryWindow.startedAtMs = nowMs;
    summaryWindow.firedIntents = 0;
    summaryWindow.erroredIntents = 0;
    summaryWindow.deferredIntents = 0;
    summaryWindow.circuitOpened = 0;
    summaryWindow.childStarted = 0;
    summaryWindow.childFinished = 0;
    summaryWindow.childFailed = 0;
  };
  const unsubscribeEvents = runtime.subscribeEvents((event) => {
    if (event.type === "schedule_recovery_deferred") {
      summaryWindow.deferredIntents += 1;
      return;
    }
    if (event.type === "schedule_child_session_started") {
      summaryWindow.childStarted += 1;
      return;
    }
    if (event.type === "schedule_child_session_finished") {
      summaryWindow.childFinished += 1;
      return;
    }
    if (event.type === "schedule_child_session_failed") {
      summaryWindow.childFailed += 1;
      return;
    }
    if (event.type !== "schedule_intent") return;

    const payload = parseScheduleIntentEvent({
      id: event.id,
      sessionId: event.sessionId,
      type: event.type,
      timestamp: event.timestamp,
      payload: event.payload,
    });
    if (!payload) return;
    if (payload.kind === "intent_fired") {
      if (payload.error) {
        summaryWindow.erroredIntents += 1;
      } else {
        summaryWindow.firedIntents += 1;
      }
      return;
    }
    if (payload.kind === "intent_cancelled" && payload.error?.startsWith("circuit_open:")) {
      summaryWindow.circuitOpened += 1;
    }
  });
  const summaryInterval = parsed.verbose
    ? setInterval(() => emitSummaryWindow("tick"), 60_000)
    : null;
  summaryInterval?.unref?.();
  const scheduler = new SchedulerService({
    runtime,
    executeIntent: async (intent) => {
      const runIndex = intent.runCount + 1;
      const child = await createBrewvaSession({
        cwd: parsed.cwd,
        configPath: parsed.configPath,
        model: parsed.model,
        enableExtensions: parsed.enableExtensions,
        runtime,
      });
      const childSessionId = child.session.sessionManager.getSessionId();
      activeRuns.set(childSessionId, child.session);

      const inherited = inheritScheduleContext(runtime, {
        parentSessionId: intent.parentSessionId,
        childSessionId,
        continuityMode: intent.continuityMode,
      });
      const wakeupMessage = buildScheduleWakeupMessage({
        intent,
        runIndex,
        inherited,
      });

      runtime.recordEvent({
        sessionId: childSessionId,
        type: "schedule_wakeup",
        payload: {
          schema: "brewva.schedule-wakeup.v1",
          intentId: intent.intentId,
          parentSessionId: intent.parentSessionId,
          runIndex,
          reason: intent.reason,
          continuityMode: intent.continuityMode,
          timeZone: intent.timeZone ?? null,
          goalRef: intent.goalRef ?? null,
          inheritedTaskSpec: inherited.taskSpecCopied,
          inheritedTruthFacts: inherited.truthFactsCopied,
          parentAnchorId: inherited.parentAnchor?.id ?? null,
        },
      });
      runtime.recordEvent({
        sessionId: intent.parentSessionId,
        type: "schedule_child_session_started",
        payload: {
          intentId: intent.intentId,
          childSessionId,
          runIndex,
        },
      });

      try {
        await child.session.sendUserMessage(wakeupMessage);
        await child.session.agent.waitForIdle();
        runtime.recordEvent({
          sessionId: intent.parentSessionId,
          type: "schedule_child_session_finished",
          payload: {
            intentId: intent.intentId,
            childSessionId,
            runIndex,
          },
        });
        return { evaluationSessionId: childSessionId };
      } catch (error) {
        runtime.recordEvent({
          sessionId: intent.parentSessionId,
          type: "schedule_child_session_failed",
          payload: {
            intentId: intent.intentId,
            childSessionId,
            runIndex,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      } finally {
        ensureSessionShutdownRecorded(runtime, childSessionId);
        activeRuns.delete(childSessionId);
        child.session.dispose();
      }
    },
  });
  const recovered = await scheduler.recover();
  const stats = scheduler.getStats();
  if (!stats.executionEnabled) {
    console.error(
      "brewva scheduler daemon: execution is disabled because no intent executor is configured.",
    );
    scheduler.stop();
    process.exitCode = 1;
    return;
  }
  if (parsed.verbose) {
    console.error(
      `[daemon] projection=${stats.projectionPath} active=${stats.intentsActive}/${stats.intentsTotal} timers=${stats.timersArmed} events=${recovered.rebuiltFromEvents} matched=${recovered.projectionMatched} catchup_due=${recovered.catchUp.dueIntents} catchup_fired=${recovered.catchUp.firedIntents} catchup_deferred=${recovered.catchUp.deferredIntents} catchup_sessions=${recovered.catchUp.sessions.length}`,
    );
  }

  await new Promise<void>((complete) => {
    let resolved = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (resolved) return;
      resolved = true;
      scheduler.stop();
      if (summaryInterval) {
        clearInterval(summaryInterval);
      }

      const abortAll = async (): Promise<void> => {
        await Promise.allSettled(
          [...activeRuns.values()].map(async (session) => {
            try {
              await session.abort();
            } catch {
              // Best effort abort during daemon shutdown.
            }
          }),
        );
      };

      void abortAll().finally(() => {
        emitSummaryWindow("shutdown");
        unsubscribeEvents();
        if (parsed.verbose) {
          console.error(`[daemon] received ${signal}, scheduler stopped.`);
        }
        process.off("SIGINT", onSigInt);
        process.off("SIGTERM", onSigTerm);
        complete();
      });
    };

    const onSigInt = (): void => shutdown("SIGINT");
    const onSigTerm = (): void => shutdown("SIGTERM");
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
  });
}

async function run(): Promise<void> {
  process.title = "brewva";
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) return;

  if (parsed.channel) {
    if (parsed.daemon) {
      console.error("Error: --channel cannot be combined with --daemon.");
      return;
    }
    if (parsed.undo || parsed.replay) {
      console.error("Error: --channel cannot be combined with --undo/--replay.");
      return;
    }
    if (parsed.taskJson || parsed.taskFile) {
      console.error("Error: --channel cannot be combined with --task/--task-file.");
      return;
    }
    if (parsed.prompt) {
      console.error("Error: --channel mode does not accept prompt text.");
      return;
    }
    if (parsed.modeExplicit && parsed.mode !== "interactive") {
      console.error("Error: --channel mode cannot be combined with --print/--json/--mode.");
      return;
    }

    await runChannelMode({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      model: parsed.model,
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
    await runDaemon(parsed);
    return;
  }

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
      ensureSessionShutdownRecorded(runtime, sessionId);
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
