import { describe, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepWorkspace, repoRoot, runLive } from "./helpers.js";

type RuntimeEvent = {
  type?: unknown;
};

type RegressionRunResult = {
  workspace: string;
  stdout: string;
  stderr: string;
  driverExit: number | null;
  eventFile: string;
  events: RuntimeEvent[];
};

const COMPACTION_FOLLOW_TYPES = new Set([
  "session_before_compact",
  "session_compact",
  "context_compacted",
  "context_compaction_skipped",
]);

const MULTI_TURN_PROMPTS = [
  "Do not call any tool. Reply exactly: ROUND-1 Snake levels increase both speed and obstacle count.",
  "Do not call any tool. Reply exactly: ROUND-2 Review logic and fix non-smooth flow.",
  "Do not call any tool. Reply exactly: ROUND-3 Difficulty shows speed plus obstacle count.",
  "Do not call any tool. Reply exactly: ROUND-4 Validate long interactive session continuity.",
  "Do not call any tool. Reply exactly: ROUND-5 Multi-turn compaction regression complete.",
] as const;

function ensureExpectAvailable(): void {
  const check = spawnSync("/usr/bin/env", ["bash", "-lc", "command -v expect >/dev/null 2>&1"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(check.status).toBe(0);
}

function writeWorkspaceConfig(workspace: string): void {
  const configDir = join(workspace, ".brewva");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "brewva.json"),
    JSON.stringify(
      {
        infrastructure: {
          contextBudget: {
            enabled: true,
            compactionThresholdPercent: 0.0001,
            hardLimitPercent: 0.999,
            minTurnsBetweenCompaction: 0,
            minSecondsBetweenCompaction: 0,
            pressureBypassPercent: 0,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function writePromptsFile(workspace: string): string {
  const promptsPath = join(workspace, ".interactive-prompts.txt");
  writeFileSync(promptsPath, `${MULTI_TURN_PROMPTS.join("\n")}\n`, "utf8");
  return promptsPath;
}

function writeExpectDriver(workspace: string): string {
  const expectPath = join(workspace, ".interactive-driver.expect");
  writeFileSync(
    expectPath,
    `#!/usr/bin/expect -f
set timeout -1
log_user 0

if {[llength $argv] != 3} {
  puts stderr "usage: <workspace> <rounds> <prompts_file>"
  exit 2
}

set workspace [lindex $argv 0]
set rounds [lindex $argv 1]
set promptsFile [lindex $argv 2]
set eventsDir [file join $workspace .orchestrator events]
set childExited 0

proc read_prompts {path rounds} {
  set fh [open $path r]
  set items {}
  while {[gets $fh line] >= 0} {
    if {[string length [string trim $line]] > 0} {
      lappend items $line
    }
  }
  close $fh
  if {[llength $items] < $rounds} {
    puts stderr "not enough prompts in prompts file"
    exit 2
  }
  return $items
}

proc count_event_type {eventsDir eventType} {
  set cmd "f=\\$(ls -t \\"$eventsDir\\"/*.jsonl 2>/dev/null | head -n 1); if test -n \\"\\$f\\"; then rg -c --no-filename '\\"type\\":\\"$eventType\\"' \\"\\$f\\" 2>/dev/null || echo 0; else echo 0; fi"
  set out [exec /bin/sh -c $cmd]
  set cleaned [string trim $out]
  if {![string is integer -strict $cleaned]} {
    return 0
  }
  return $cleaned
}

proc wait_for_event_count {eventsDir eventType target timeoutSec} {
  global childExited
  set deadline [expr {[clock seconds] + $timeoutSec}]
  while {1} {
    pump_output
    if {$childExited} {
      return 0
    }
    set c [count_event_type $eventsDir $eventType]
    if {$c >= $target} {
      return 1
    }
    if {[clock seconds] > $deadline} {
      return 0
    }
    after 500
  }
}

proc pump_output {} {
  global childExited
  expect {
    -timeout 0
    -re {.+} { exp_continue }
    timeout { return }
    eof {
      set childExited 1
      return
    }
  }
}

proc wait_for_agent_end_count {eventsDir target timeoutSec} {
  if {![wait_for_event_count $eventsDir "agent_end" $target $timeoutSec]} {
    puts stderr "timeout waiting for agent_end >= $target"
    exit 3
  }
}

proc send_prompt_with_retry {eventsDir prompt targetInputCount maxAttempts timeoutSec} {
  global childExited
  for {set attempt 1} {$attempt <= $maxAttempts} {incr attempt} {
    pump_output
    if {$childExited} {
      puts stderr "interactive process exited before sending prompt"
      exit 3
    }
    send -- "$prompt\\r"
    if {[wait_for_event_count $eventsDir "input" $targetInputCount $timeoutSec]} {
      return
    }
    after 400
  }
  puts stderr "timeout waiting for input >= $targetInputCount after $maxAttempts attempts"
  exit 3
}

set prompts [read_prompts $promptsFile $rounds]

spawn -noecho bun run start --interactive --cwd $workspace
if {![wait_for_event_count $eventsDir "session_start" 1 90]} {
  puts stderr "timeout waiting for session_start"
  exit 3
}
after 1200

for {set i 0} {$i < $rounds} {incr i} {
  if {$i > 0} {
    wait_for_agent_end_count $eventsDir $i 120
    after 300
  }
  set targetInputCount [expr {$i + 1}]
  send_prompt_with_retry $eventsDir [lindex $prompts $i] $targetInputCount 3 60
}

wait_for_agent_end_count $eventsDir $rounds 240
after 600
send -- "/quit\\r"
after 800

if {[catch {close}]} {
}
if {[catch {wait}]} {
}
`,
    "utf8",
  );
  return expectPath;
}

function latestEventFile(eventsDir: string): string {
  const candidates = readdirSync(eventsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const file = join(eventsDir, name);
      return { file, mtimeMs: statSync(file).mtimeMs };
    })
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`No event files under ${eventsDir}`);
  }
  return candidates[0]!.file;
}

function parseEvents(eventFile: string): RuntimeEvent[] {
  return readFileSync(eventFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as RuntimeEvent;
      } catch {
        return {};
      }
    });
}

function countEvents(events: RuntimeEvent[], eventType: string): number {
  return events.reduce((count, event) => (event.type === eventType ? count + 1 : count), 0);
}

function eventIndexes(events: RuntimeEvent[], eventType: string): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.type === eventType) {
      indexes.push(i);
    }
  }
  return indexes;
}

function summarizeCounts(events: RuntimeEvent[]): string {
  const input = countEvents(events, "input");
  const turnStart = countEvents(events, "turn_start");
  const turnEnd = countEvents(events, "turn_end");
  const agentEnd = countEvents(events, "agent_end");
  const compactionRequested = countEvents(events, "context_compaction_requested");
  const beforeCompact = countEvents(events, "session_before_compact");
  const sessionCompact = countEvents(events, "session_compact");
  const compacted = countEvents(events, "context_compacted");
  const compactionSkipped = countEvents(events, "context_compaction_skipped");

  return [
    `input=${input}`,
    `turn_start=${turnStart}`,
    `turn_end=${turnEnd}`,
    `agent_end=${agentEnd}`,
    `compaction_requested=${compactionRequested}`,
    `session_before_compact=${beforeCompact}`,
    `session_compact=${sessionCompact}`,
    `context_compacted=${compacted}`,
    `compaction_skipped=${compactionSkipped}`,
  ].join(" ");
}

function formatFailureOutput(result: RegressionRunResult): string {
  const tail = result.events
    .slice(Math.max(result.events.length - 40, 0))
    .map((event) => (typeof event.type === "string" ? event.type : "unknown"))
    .join(", ");

  return [
    `[interactive-multi-turn.live] workspace: ${result.workspace}`,
    `[interactive-multi-turn.live] event file: ${result.eventFile}`,
    `[interactive-multi-turn.live] driverExit: ${String(result.driverExit)}`,
    `[interactive-multi-turn.live] counts: ${summarizeCounts(result.events)}`,
    "",
    "[interactive-multi-turn.live] stdout:",
    result.stdout.trim(),
    "",
    "[interactive-multi-turn.live] stderr:",
    result.stderr.trim(),
    "",
    `[interactive-multi-turn.live] tail event types: ${tail}`,
  ].join("\n");
}

function runRegression(rounds: number): RegressionRunResult {
  const workspace = mkdtempSync(join(tmpdir(), "brewva-interactive-live-"));
  writeWorkspaceConfig(workspace);
  const promptsPath = writePromptsFile(workspace);
  const expectPath = writeExpectDriver(workspace);

  const child = spawnSync(
    "/usr/bin/env",
    ["expect", "-f", expectPath, workspace, String(rounds), promptsPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env },
      timeout: 12 * 60 * 1000,
    },
  );

  const eventsDir = join(workspace, ".orchestrator", "events");
  const eventFile = latestEventFile(eventsDir);
  const events = parseEvents(eventFile);

  rmSync(promptsPath, { force: true });
  rmSync(expectPath, { force: true });

  return {
    workspace,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    driverExit: child.status,
    eventFile,
    events,
  };
}

function assertCoreCounts(result: RegressionRunResult, rounds: number): void {
  const input = countEvents(result.events, "input");
  const turnStart = countEvents(result.events, "turn_start");
  const turnEnd = countEvents(result.events, "turn_end");
  const agentEnd = countEvents(result.events, "agent_end");
  expect(input).toBeGreaterThanOrEqual(rounds);
  expect(turnStart).toBeGreaterThanOrEqual(rounds);
  expect(turnEnd).toBeGreaterThanOrEqual(rounds);
  expect(agentEnd).toBeGreaterThanOrEqual(rounds);
}

function assertCompactionContinuity(result: RegressionRunResult): void {
  const requestIndexes = eventIndexes(result.events, "context_compaction_requested");
  if (requestIndexes.length === 0) return;

  const agentEndIndexes = eventIndexes(result.events, "agent_end");
  for (const requestIndex of requestIndexes) {
    const nextAgentEnd =
      agentEndIndexes.find((index) => index > requestIndex) ?? result.events.length;
    const hasFollow = result.events
      .slice(requestIndex + 1, nextAgentEnd + 1)
      .some((event) =>
        COMPACTION_FOLLOW_TYPES.has(typeof event.type === "string" ? event.type : ""),
      );
    expect(hasFollow).toBe(true);
  }
}

describe("e2e: interactive multi-turn live regression", () => {
  runLive("runs 3~5 round segmented conversation and validates compaction continuity", () => {
    ensureExpectAvailable();
    for (const rounds of [3, 5]) {
      const result = runRegression(rounds);
      try {
        if (result.driverExit !== 0) {
          throw new Error(formatFailureOutput(result));
        }
        assertCoreCounts(result, rounds);
        assertCompactionContinuity(result);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${formatFailureOutput(result)}`,
          { cause: error },
        );
      } finally {
        if (!keepWorkspace) {
          rmSync(result.workspace, { recursive: true, force: true });
        }
      }
    }
  });
});
