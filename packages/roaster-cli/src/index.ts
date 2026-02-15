#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InteractiveMode, runPrintMode } from "@mariozechner/pi-coding-agent";
import { RoasterRuntime } from "@pi-roaster/roaster-runtime";
import { createRoasterSession } from "./session.js";

function printHelp(): void {
  console.log(`pi-roaster - AI-native coding agent CLI

Usage:
  pi-roaster [options] [prompt]

Modes:
  default               Interactive TUI mode (same flow as pi)
  --print               One-shot mode (prints final answer and exits)
  --mode json           One-shot JSON event stream

Options:
  --cwd <path>          Working directory
  --config <path>       Roaster config path (default: .pi/roaster.json)
  --model <provider/id> Model override
  --no-extensions       Disable extensions, register tools directly
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
  pi-roaster
  pi-roaster "Fix failing tests in runtime"
  pi-roaster --print "Refactor this function"
  pi-roaster --mode json "Summarize recent changes"
  pi-roaster --undo --session <session-id>
  pi-roaster --replay --mode json --session <session-id>`);
}

type CliMode = "interactive" | "print-text" | "print-json";

interface CliArgs {
  cwd?: string;
  configPath?: string;
  model?: string;
  enableExtensions: boolean;
  undo: boolean;
  replay: boolean;
  sessionId?: string;
  mode: CliMode;
  modeExplicit: boolean;
  verbose: boolean;
  prompt?: string;
}

function parseOptionValue(argv: string[], index: number, flag: string): string | null {
  const value = argv[index + 1];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  console.error(`Error: ${flag} requires a value.`);
  printHelp();
  return null;
}

function parseArgs(argv: string[]): CliArgs | null {
  let cwd: string | undefined;
  let configPath: string | undefined;
  let model: string | undefined;
  let enableExtensions = true;
  let undo = false;
  let replay = false;
  let sessionId: string | undefined;
  let mode: CliMode = "interactive";
  let modeExplicit = false;
  let verbose = false;

  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;

    if (arg === "-h" || arg === "--help") {
      printHelp();
      return null;
    }

    if (arg === "--cwd") {
      const value = parseOptionValue(argv, i, "--cwd");
      if (!value) return null;
      cwd = value;
      i += 1;
      continue;
    }

    if (arg === "--config") {
      const value = parseOptionValue(argv, i, "--config");
      if (!value) return null;
      configPath = value;
      i += 1;
      continue;
    }

    if (arg === "--model") {
      const value = parseOptionValue(argv, i, "--model");
      if (!value) return null;
      model = value;
      i += 1;
      continue;
    }

    if (arg === "--no-extensions") {
      enableExtensions = false;
      continue;
    }

    if (arg === "--undo") {
      undo = true;
      continue;
    }

    if (arg === "--replay") {
      replay = true;
      continue;
    }

    if (arg === "--session") {
      const value = parseOptionValue(argv, i, "--session");
      if (!value) return null;
      sessionId = value;
      i += 1;
      continue;
    }

    if (arg === "--print" || arg === "-p") {
      mode = "print-text";
      modeExplicit = true;
      continue;
    }

    if (arg === "--interactive" || arg === "-i") {
      mode = "interactive";
      modeExplicit = true;
      continue;
    }

    if (arg === "--json") {
      mode = "print-json";
      modeExplicit = true;
      continue;
    }

    if (arg === "--mode") {
      const value = parseOptionValue(argv, i, "--mode");
      if (!value) return null;
      if (value === "text") {
        mode = "print-text";
      } else if (value === "json") {
        mode = "print-json";
      } else {
        console.error(`Error: --mode must be "text" or "json" (received "${value}").`);
        return null;
      }
      modeExplicit = true;
      i += 1;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg.startsWith("-")) {
      console.error(`Error: unknown option "${arg}".`);
      printHelp();
      return null;
    }

    promptParts.push(arg);
  }

  const prompt = promptParts.join(" ").trim() || undefined;

  return {
    cwd,
    configPath,
    model,
    enableExtensions,
    undo,
    replay,
    sessionId,
    mode,
    modeExplicit,
    verbose,
    prompt,
  };
}

async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  return await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      const text = data.trim();
      resolve(text.length > 0 ? text : undefined);
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

function printReplayText(events: Array<{ timestamp: number; turn?: number; type: string; payload?: Record<string, unknown> }>): void {
  for (const event of events) {
    const iso = new Date(event.timestamp).toISOString();
    const turnText = typeof event.turn === "number" ? `turn=${event.turn}` : "turn=-";
    const payload = event.payload ? JSON.stringify(event.payload) : "{}";
    console.log(`${iso} ${turnText} ${event.type} ${payload}`);
  }
}

function printCostSummary(sessionId: string, runtime: RoasterRuntime): void {
  const summary = runtime.getCostSummary(sessionId);
  if (summary.totalTokens <= 0 && summary.totalCostUsd <= 0) return;

  const topSkill = Object.entries(summary.skills).sort((a, b) => b[1].totalCostUsd - a[1].totalCostUsd)[0];
  const topTool = Object.entries(summary.tools).sort((a, b) => b[1].allocatedCostUsd - a[1].allocatedCostUsd)[0];

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

async function run(): Promise<void> {
  process.title = "pi-roaster";
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) return;

  const pipedInput = await readPipedStdin();
  const initialMessage = parsed.prompt ?? pipedInput;
  const mode = resolveEffectiveMode(parsed);
  if (!mode) return;

  if (!parsed.undo && !parsed.replay && mode !== "interactive" && !initialMessage) {
    printHelp();
    return;
  }

  if (parsed.replay) {
    const runtime = new RoasterRuntime({
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
        console.log(JSON.stringify(event));
      }
    } else {
      printReplayText(events);
    }
    return;
  }

  if (parsed.undo) {
    const runtime = new RoasterRuntime({
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

  const { session, runtime } = await createRoasterSession({
    cwd: parsed.cwd,
    configPath: parsed.configPath,
    model: parsed.model,
    enableExtensions: parsed.enableExtensions,
  });

  const sessionId = session.sessionManager.getSessionId();
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

    runtime.recordEvent({
      sessionId,
      type: "session_interrupted",
      payload: { signal },
    });
    runtime.persistSessionSnapshot(sessionId, {
      reason: "signal",
      interrupted: true,
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

  try {
    if (mode === "interactive") {
      const interactiveMode = new InteractiveMode(session, {
        initialMessage,
        verbose: parsed.verbose,
      });
      await interactiveMode.run();
      printCostSummary(sessionId, runtime);
      return;
    }

    await runPrintMode(session, {
      mode: mode === "print-json" ? "json" : "text",
      initialMessage,
    });

    if (mode === "print-json") {
      const replayEvents = runtime.queryStructuredEvents(sessionId);
      console.log(
        JSON.stringify({
          schema: "roaster.stream.v1",
          type: "roaster_event_bundle",
          sessionId,
          events: replayEvents,
          costSummary: runtime.getCostSummary(sessionId),
        }),
      );
    } else {
      printCostSummary(sessionId, runtime);
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    if (terminatedBySignal) {
      return;
    }
    runtime.persistSessionSnapshot(sessionId, {
      reason: "shutdown",
      interrupted: false,
    });
    session.dispose();
  }
}

const isBunMain = (import.meta as ImportMeta & { main?: boolean }).main;
const isNodeMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isBunMain ?? isNodeMain) {
  void run();
}

export { createRoasterSession } from "./session.js";
export { parseArgs };
