#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  capture-workflow.sh <url> [output-dir] [verify-ref]

Arguments:
  <url>          Target page URL.
  [output-dir]   Artifact directory (default: ./browser-artifacts/capture-<timestamp>).
  [verify-ref]   Optional ref (for example @e5) to click before running diff verification.

Optional environment:
  AGENT_BROWSER_SESSION  Named session for isolation.
  BROWSER_STATE_FILE     Path to pre-saved state file to load before navigation.
USAGE
}

if [[ $# -lt 1 || $# -gt 3 ]]; then
  usage
  exit 2
fi

TARGET_URL="$1"
OUTPUT_DIR="${2:-./browser-artifacts/capture-$(date +%Y%m%d-%H%M%S)}"
VERIFY_REF="${3:-}"
SESSION_NAME="${AGENT_BROWSER_SESSION:-}"
STATE_FILE="${BROWSER_STATE_FILE:-}"
COMMAND_LOG="$OUTPUT_DIR/command.log"
CURRENT_STEP="init"
ATTEMPTED_STEPS=()

mkdir -p "$OUTPUT_DIR"

ab() {
  if [[ -n "$SESSION_NAME" ]]; then
    agent-browser --session "$SESSION_NAME" "$@"
  else
    agent-browser "$@"
  fi
}

escape_value() {
  printf '%s' "$1" | sed 's/"/\\"/g'
}

action_entry() {
  local step="$1"
  local result="$2"
  local evidence="$3"
  echo "- step: \"$(escape_value "$step")\""
  echo "  result: \"$(escape_value "$result")\""
  echo "  evidence: \"$(escape_value "$evidence")\""
}

run_step() {
  local step="$1"
  shift
  CURRENT_STEP="$step"
  ATTEMPTED_STEPS+=("$step")
  "$@" >>"$COMMAND_LOG" 2>&1
  action_entry "$step" "success" "$COMMAND_LOG"
}

on_error() {
  local exit_code=$?
  {
    echo
    echo "TROUBLESHOOTING"
    echo "- symptom: \"Failed at step: $(escape_value "$CURRENT_STEP")\""
    echo "- attempted_actions:"
    for step in "${ATTEMPTED_STEPS[@]}"; do
      echo "  - \"$(escape_value "$step")\""
    done
    echo "- next_action: \"Inspect $(escape_value "$COMMAND_LOG"), run agent-browser snapshot -i, and retry from the failed step.\""
  } >&2
  exit "$exit_code"
}

cleanup() {
  ab close >/dev/null 2>>"$COMMAND_LOG" || true
}

trap on_error ERR
trap cleanup EXIT

echo "BROWSER_PLAN"
echo "- target_url: \"$(escape_value "$TARGET_URL")\""
echo "- objective: \"Capture page content and artifacts with optional state-change verification.\""
echo "- success_criteria:"
echo "  - \"Page opens and reaches stable load state.\""
echo "  - \"Artifacts (snapshot, screenshot, pdf, text) are created.\""
if [[ -n "$VERIFY_REF" ]]; then
  echo "  - \"Verification click $(escape_value "$VERIFY_REF") produces diff evidence.\""
fi
echo "- expected_artifacts:"
echo "  - \"$(escape_value "$OUTPUT_DIR/snapshot-before.txt")\""
echo "  - \"$(escape_value "$OUTPUT_DIR/page-full.png")\""
echo "  - \"$(escape_value "$OUTPUT_DIR/page.pdf")\""
echo "  - \"$(escape_value "$OUTPUT_DIR/page-text.txt")\""

echo
echo "ACTION_LOG"

if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
  run_step "Load state file" ab state load "$STATE_FILE"
fi

run_step "Open target URL" ab open "$TARGET_URL"
run_step "Wait for network idle" ab wait --load networkidle

CURRENT_STEP="Capture baseline snapshot"
ATTEMPTED_STEPS+=("$CURRENT_STEP")
ab snapshot -i >"$OUTPUT_DIR/snapshot-before.txt" 2>>"$COMMAND_LOG"
action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/snapshot-before.txt"

if [[ -n "$VERIFY_REF" ]]; then
  run_step "Click verification ref" ab click "$VERIFY_REF"
  run_step "Wait after verification click" ab wait --load networkidle

  CURRENT_STEP="Capture snapshot diff"
  ATTEMPTED_STEPS+=("$CURRENT_STEP")
  ab diff snapshot >"$OUTPUT_DIR/diff-snapshot.txt" 2>>"$COMMAND_LOG"
  action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/diff-snapshot.txt"
fi

CURRENT_STEP="Capture latest snapshot"
ATTEMPTED_STEPS+=("$CURRENT_STEP")
ab snapshot -i >"$OUTPUT_DIR/snapshot-after.txt" 2>>"$COMMAND_LOG"
action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/snapshot-after.txt"

CURRENT_STEP="Capture full screenshot"
ATTEMPTED_STEPS+=("$CURRENT_STEP")
ab screenshot --full "$OUTPUT_DIR/page-full.png" >>"$COMMAND_LOG" 2>&1
action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/page-full.png"

CURRENT_STEP="Capture PDF"
ATTEMPTED_STEPS+=("$CURRENT_STEP")
ab pdf "$OUTPUT_DIR/page.pdf" >>"$COMMAND_LOG" 2>&1
action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/page.pdf"

CURRENT_STEP="Extract body text"
ATTEMPTED_STEPS+=("$CURRENT_STEP")
ab get text body >"$OUTPUT_DIR/page-text.txt" 2>>"$COMMAND_LOG"
action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/page-text.txt"

TITLE="$(ab get title 2>>"$COMMAND_LOG" | tr -d '\r')"
FINAL_URL="$(ab get url 2>>"$COMMAND_LOG" | tr -d '\r')"

echo
echo "EXTRACTION_RESULT"
echo "- key: \"title\""
echo "  value: \"$(escape_value "$TITLE")\""
echo "- key: \"final_url\""
echo "  value: \"$(escape_value "$FINAL_URL")\""
echo "- key: \"artifacts_dir\""
echo "  value: \"$(escape_value "$OUTPUT_DIR")\""
echo "- key: \"command_log\""
echo "  value: \"$(escape_value "$COMMAND_LOG")\""
if [[ -n "$VERIFY_REF" ]]; then
  echo "- key: \"diff_snapshot\""
  echo "  value: \"$(escape_value "$OUTPUT_DIR/diff-snapshot.txt")\""
fi
