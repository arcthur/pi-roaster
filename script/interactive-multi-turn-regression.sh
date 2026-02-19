#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  script/interactive-multi-turn-regression.sh [--rounds 3-5] [--cwd <dir>] [--keep-workspace]

Description:
  Run a scripted interactive multi-turn stress regression against Brewva.
  The script:
  1) starts interactive mode in a PTY,
  2) sends 3-5 prompts sequentially after each agent_end,
  3) verifies event-chain continuity from .orchestrator/events.

Options:
  --rounds <n>        Number of prompts to run (default: 4, allowed: 3..5)
  --cwd <dir>         Workspace for the run (default: auto-created temp dir)
  --keep-workspace    Do not delete auto-created temp workspace
  --help              Show this help
EOF
}

ROUNDS=4
TARGET_CWD=""
KEEP_WORKSPACE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rounds)
      shift
      [[ $# -gt 0 ]] || {
        echo "Missing value for --rounds" >&2
        exit 2
      }
      ROUNDS="$1"
      ;;
    --cwd)
      shift
      [[ $# -gt 0 ]] || {
        echo "Missing value for --cwd" >&2
        exit 2
      }
      TARGET_CWD="$1"
      ;;
    --keep-workspace)
      KEEP_WORKSPACE=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
  shift
done

if ! [[ "$ROUNDS" =~ ^[0-9]+$ ]]; then
  echo "--rounds must be an integer, got: $ROUNDS" >&2
  exit 2
fi
if (( ROUNDS < 3 || ROUNDS > 5 )); then
  echo "--rounds must be between 3 and 5, got: $ROUNDS" >&2
  exit 2
fi

AUTO_WORKSPACE=0
if [[ -z "$TARGET_CWD" ]]; then
  TARGET_CWD="$(mktemp -d /tmp/brewva-multi-turn-stress-XXXXXX)"
  AUTO_WORKSPACE=1
fi

mkdir -p "$TARGET_CWD/.brewva"
cat >"$TARGET_CWD/.brewva/brewva.json" <<'JSON'
{
  "infrastructure": {
    "contextBudget": {
      "enabled": true,
      "compactionThresholdPercent": 0.0001,
      "hardLimitPercent": 0.999,
      "minTurnsBetweenCompaction": 0,
      "minSecondsBetweenCompaction": 0,
      "pressureBypassPercent": 0,
      "compactionCircuitBreaker": {
        "enabled": true,
        "maxConsecutiveFailures": 2,
        "cooldownTurns": 2
      }
    }
  }
}
JSON

PROMPTS_FILE="$(mktemp /tmp/brewva-prompts-XXXXXX.txt)"
cat >"$PROMPTS_FILE" <<'EOF'
Do not call any tool. Reply exactly: ROUND-1
Do not call any tool. Reply exactly: ROUND-2
Do not call any tool. Reply exactly: ROUND-3
Do not call any tool. Reply exactly: ROUND-4
Do not call any tool. Reply exactly: ROUND-5
EOF

EXPECT_FILE="$(mktemp /tmp/brewva-interactive-runner-XXXXXX.expect)"
cat >"$EXPECT_FILE" <<'EOF'
#!/usr/bin/expect -f
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
  set cmd "f=\$(ls -t \"$eventsDir\"/*.jsonl 2>/dev/null | head -n 1); if test -n \"\$f\"; then rg -c --no-filename '\"type\":\"$eventType\"' \"\$f\" 2>/dev/null || echo 0; else echo 0; fi"
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
    send -- "$prompt\r"
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
    wait_for_agent_end_count $eventsDir $i 90
    after 300
  }
  set targetInputCount [expr {$i + 1}]
  send_prompt_with_retry $eventsDir [lindex $prompts $i] $targetInputCount 3 45
}

wait_for_agent_end_count $eventsDir $rounds 120
after 600
send -- "/quit\r"
after 800

if {[catch {close}]} {
}
if {[catch {wait}]} {
}
EOF
chmod +x "$EXPECT_FILE"

cleanup() {
  rm -f "$PROMPTS_FILE" "$EXPECT_FILE"
  if (( AUTO_WORKSPACE == 1 && KEEP_WORKSPACE == 0 )); then
    rm -rf "$TARGET_CWD"
  fi
}
trap cleanup EXIT

echo "[stress] workspace: $TARGET_CWD"
echo "[stress] rounds: $ROUNDS"
echo "[stress] launching scripted interactive session..."
set +e
"$EXPECT_FILE" "$TARGET_CWD" "$ROUNDS" "$PROMPTS_FILE"
DRIVER_EXIT="$?"
set -e
if (( DRIVER_EXIT != 0 )); then
  echo "[stress] WARN: interactive driver exited with code $DRIVER_EXIT" >&2
fi

EVENT_FILE="$(ls -t "$TARGET_CWD/.orchestrator/events"/*.jsonl 2>/dev/null | head -n 1 || true)"
if [[ -z "$EVENT_FILE" ]]; then
  echo "[stress] FAIL: no event file produced under $TARGET_CWD/.orchestrator/events" >&2
  exit 4
fi

count_type() {
  local type="$1"
  rg -c --no-filename "\"type\":\"${type}\"" "$EVENT_FILE" 2>/dev/null || echo 0
}

TURN_START="$(count_type turn_start)"
TURN_END="$(count_type turn_end)"
INPUT="$(count_type input)"
AGENT_END="$(count_type agent_end)"
HANDOFF="$(count_type session_handoff_generated)"
HANDOFF_SKIPPED="$(count_type session_handoff_skipped)"
HANDOFF_FALLBACK="$(count_type session_handoff_fallback)"
COMPACT_REQ="$(count_type context_compaction_requested)"
COMPACT_DONE="$(count_type context_compacted)"
COMPACT_SDK="$(count_type session_compact)"
COMPACT_BEFORE="$(count_type session_before_compact)"
COMPACT_SKIPPED="$(count_type context_compaction_skipped)"
HANDOFF_TOTAL=$((HANDOFF + HANDOFF_SKIPPED + HANDOFF_FALLBACK))
COMPACT_FOLLOW=$((COMPACT_BEFORE + COMPACT_SDK + COMPACT_DONE + COMPACT_SKIPPED))

echo "[stress] session: $(basename "$EVENT_FILE" .jsonl)"
echo "[stress] event file: $EVENT_FILE"
echo "[stress] counts: input=$INPUT turn_start=$TURN_START turn_end=$TURN_END agent_end=$AGENT_END handoff_generated=$HANDOFF handoff_skipped=$HANDOFF_SKIPPED handoff_fallback=$HANDOFF_FALLBACK compaction_requested=$COMPACT_REQ session_before_compact=$COMPACT_BEFORE session_compact=$COMPACT_SDK context_compacted=$COMPACT_DONE compaction_skipped=$COMPACT_SKIPPED"

FAIL=0
if (( DRIVER_EXIT != 0 )); then
  echo "[stress] FAIL: interactive driver exited with code $DRIVER_EXIT" >&2
  FAIL=1
fi
if (( INPUT < ROUNDS )); then
  echo "[stress] FAIL: input ($INPUT) < rounds ($ROUNDS)" >&2
  FAIL=1
fi
if (( TURN_START < ROUNDS )); then
  echo "[stress] FAIL: turn_start ($TURN_START) < rounds ($ROUNDS)" >&2
  FAIL=1
fi
if (( TURN_END < ROUNDS )); then
  echo "[stress] FAIL: turn_end ($TURN_END) < rounds ($ROUNDS)" >&2
  FAIL=1
fi
if (( AGENT_END < ROUNDS )); then
  echo "[stress] FAIL: agent_end ($AGENT_END) < rounds ($ROUNDS)" >&2
  FAIL=1
fi
if (( HANDOFF_TOTAL < ROUNDS )); then
  echo "[stress] FAIL: handoff events total ($HANDOFF_TOTAL) < rounds ($ROUNDS)" >&2
  FAIL=1
fi
if (( COMPACT_REQ > 0 && COMPACT_FOLLOW == 0 )); then
  echo "[stress] FAIL: compaction requested but no follow-up event observed" >&2
  FAIL=1
fi

if (( FAIL != 0 )); then
  echo "[stress] RESULT: FAIL" >&2
  echo "[stress] tail events:"
  tail -n 40 "$EVENT_FILE"
  exit 5
fi

echo "[stress] RESULT: PASS"
if (( AUTO_WORKSPACE == 1 && KEEP_WORKSPACE == 1 )); then
  echo "[stress] workspace retained at: $TARGET_CWD"
fi
