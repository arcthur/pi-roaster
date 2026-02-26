#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  authenticated-session.sh <login-url> <target-url> [state-file]

Arguments:
  <login-url>   Login page URL.
  <target-url>  Protected page URL to verify authenticated access.
  [state-file]  State file path (default: ./auth-state.json).

Optional environment:
  AGENT_BROWSER_SESSION  Named session for isolation.
  APP_USERNAME           Login username/email (required for login mode).
  APP_PASSWORD           Login password (required for login mode).
  LOGIN_USER_REF         Ref for username input (required for login mode).
  LOGIN_PASS_REF         Ref for password input (required for login mode).
  LOGIN_SUBMIT_REF       Ref for submit button (required for login mode).
USAGE
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi

LOGIN_URL="$1"
TARGET_URL="$2"
STATE_FILE="${3:-./auth-state.json}"
SESSION_NAME="${AGENT_BROWSER_SESSION:-}"
COMMAND_LOG="./browser-artifacts/auth-$(date +%Y%m%d-%H%M%S)/command.log"
OUTPUT_DIR="$(dirname "$COMMAND_LOG")"
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
    echo "- next_action: \"Inspect $(escape_value "$COMMAND_LOG"), run snapshot -i on login page, and confirm refs/environment variables.\""
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
echo "- objective: \"Restore or establish an authenticated browser session and persist state.\""
echo "- success_criteria:"
echo "  - \"Authenticated access to target page is confirmed.\""
echo "  - \"State file is written for reuse.\""
echo "- expected_artifacts:"
echo "  - \"$(escape_value "$STATE_FILE")\""
echo "  - \"$(escape_value "$OUTPUT_DIR/target-snapshot.txt")\""
echo "  - \"$(escape_value "$OUTPUT_DIR/target.png")\""

echo
echo "ACTION_LOG"

RESTORED=0

if [[ -f "$STATE_FILE" ]]; then
  run_step "Load existing state file" ab state load "$STATE_FILE"
  run_step "Open target URL with restored state" ab open "$TARGET_URL"
  run_step "Wait after restore navigation" ab wait --load networkidle

  RESTORE_URL="$(ab get url 2>>"$COMMAND_LOG" | tr -d '\r')"
  if [[ "$RESTORE_URL" != *login* && "$RESTORE_URL" != *signin* ]]; then
    RESTORED=1
    action_entry "Verify restored session" "success" "$RESTORE_URL"
  else
    action_entry "Verify restored session" "fail" "$RESTORE_URL"
  fi
fi

if [[ "$RESTORED" -eq 0 ]]; then
  MISSING_MODE_VARS=0
  for var in APP_USERNAME APP_PASSWORD LOGIN_USER_REF LOGIN_PASS_REF LOGIN_SUBMIT_REF; do
    if [[ -z "${!var:-}" ]]; then
      MISSING_MODE_VARS=1
      break
    fi
  done

  if [[ "$MISSING_MODE_VARS" -eq 1 ]]; then
    run_step "Open login URL for discovery mode" ab open "$LOGIN_URL"
    run_step "Wait for login page" ab wait --load networkidle

    CURRENT_STEP="Capture login snapshot for ref discovery"
    ATTEMPTED_STEPS+=("$CURRENT_STEP")
    ab snapshot -i >"$OUTPUT_DIR/login-snapshot.txt" 2>>"$COMMAND_LOG"
    action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/login-snapshot.txt"

    echo
    echo "TROUBLESHOOTING"
    echo "- symptom: \"Login mode variables are missing.\""
    echo "- attempted_actions:"
    echo "  - \"Loaded state (if present) and checked target URL.\""
    echo "  - \"Captured login snapshot for ref discovery.\""
    echo "- next_action: \"Set APP_USERNAME, APP_PASSWORD, LOGIN_USER_REF, LOGIN_PASS_REF, LOGIN_SUBMIT_REF and rerun this template.\""
    exit 0
  fi

  run_step "Open login URL" ab open "$LOGIN_URL"
  run_step "Wait for login page" ab wait --load networkidle

  CURRENT_STEP="Capture pre-login snapshot"
  ATTEMPTED_STEPS+=("$CURRENT_STEP")
  ab snapshot -i >"$OUTPUT_DIR/pre-login-snapshot.txt" 2>>"$COMMAND_LOG"
  action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/pre-login-snapshot.txt"

  run_step "Fill username" ab fill "$LOGIN_USER_REF" "$APP_USERNAME"
  run_step "Fill password" ab fill "$LOGIN_PASS_REF" "$APP_PASSWORD"
  run_step "Submit login form" ab click "$LOGIN_SUBMIT_REF"
  run_step "Wait after login submit" ab wait --load networkidle

  run_step "Open target URL after login" ab open "$TARGET_URL"
  run_step "Wait for target page" ab wait --load networkidle
  run_step "Save refreshed state file" ab state save "$STATE_FILE"
fi

CURRENT_STEP="Capture target snapshot"
ATTEMPTED_STEPS+=("$CURRENT_STEP")
ab snapshot -i >"$OUTPUT_DIR/target-snapshot.txt" 2>>"$COMMAND_LOG"
action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/target-snapshot.txt"

CURRENT_STEP="Capture target screenshot"
ATTEMPTED_STEPS+=("$CURRENT_STEP")
ab screenshot "$OUTPUT_DIR/target.png" >>"$COMMAND_LOG" 2>&1
action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/target.png"

TARGET_FINAL_URL="$(ab get url 2>>"$COMMAND_LOG" | tr -d '\r')"
TARGET_TITLE="$(ab get title 2>>"$COMMAND_LOG" | tr -d '\r')"

echo
echo "EXTRACTION_RESULT"
echo "- key: \"title\""
echo "  value: \"$(escape_value "$TARGET_TITLE")\""
echo "- key: \"final_url\""
echo "  value: \"$(escape_value "$TARGET_FINAL_URL")\""
echo "- key: \"state_file\""
echo "  value: \"$(escape_value "$STATE_FILE")\""
echo "- key: \"artifacts_dir\""
echo "  value: \"$(escape_value "$OUTPUT_DIR")\""
echo "- key: \"command_log\""
echo "  value: \"$(escape_value "$COMMAND_LOG")\""
