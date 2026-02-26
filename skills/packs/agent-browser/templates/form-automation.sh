#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  form-automation.sh <form-url> <field1-ref> <field1-value> <field2-ref> <field2-value> <submit-ref> [success-url-pattern]

Arguments:
  <form-url>             Form page URL.
  <field1-ref>           First input ref (for example @e1).
  <field1-value>         First input value.
  <field2-ref>           Second input ref (for example @e2).
  <field2-value>         Second input value.
  <submit-ref>           Submit button ref (for example @e3).
  [success-url-pattern]  Optional URL glob for post-submit wait (for example **/dashboard).

Optional environment:
  AGENT_BROWSER_SESSION  Named session for isolation.
  OUTPUT_DIR             Artifact directory (default: ./browser-artifacts/form-<timestamp>).
USAGE
}

if [[ $# -lt 6 || $# -gt 7 ]]; then
  usage
  exit 2
fi

FORM_URL="$1"
FIELD1_REF="$2"
FIELD1_VALUE="$3"
FIELD2_REF="$4"
FIELD2_VALUE="$5"
SUBMIT_REF="$6"
SUCCESS_URL_PATTERN="${7:-}"
SESSION_NAME="${AGENT_BROWSER_SESSION:-}"
OUTPUT_DIR="${OUTPUT_DIR:-./browser-artifacts/form-$(date +%Y%m%d-%H%M%S)}"
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
    echo "- next_action: \"Inspect $(escape_value "$COMMAND_LOG"), re-run snapshot -i, verify refs, and retry.\""
  } >&2
  exit "$exit_code"
}

cleanup() {
  ab close >/dev/null 2>>"$COMMAND_LOG" || true
}

trap on_error ERR
trap cleanup EXIT

echo "BROWSER_PLAN"
echo "- target_url: \"$(escape_value "$FORM_URL")\""
echo "- objective: \"Submit form using stable refs and verify the resulting state change.\""
echo "- success_criteria:"
echo "  - \"Form fields are filled with provided values.\""
echo "  - \"Submit interaction completes without command errors.\""
if [[ -n "$SUCCESS_URL_PATTERN" ]]; then
  echo "  - \"Final URL matches pattern: $(escape_value "$SUCCESS_URL_PATTERN")\""
fi
echo "  - \"Snapshot diff and artifacts are produced.\""
echo "- expected_artifacts:"
echo "  - \"$(escape_value "$OUTPUT_DIR/snapshot-before.txt")\""
echo "  - \"$(escape_value "$OUTPUT_DIR/snapshot-after.txt")\""
echo "  - \"$(escape_value "$OUTPUT_DIR/diff-snapshot.txt")\""
echo "  - \"$(escape_value "$OUTPUT_DIR/form-result.png")\""

echo
echo "ACTION_LOG"

run_step "Open form URL" ab open "$FORM_URL"
run_step "Wait for network idle" ab wait --load networkidle

CURRENT_STEP="Capture baseline snapshot"
ATTEMPTED_STEPS+=("$CURRENT_STEP")
ab snapshot -i >"$OUTPUT_DIR/snapshot-before.txt" 2>>"$COMMAND_LOG"
action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/snapshot-before.txt"

run_step "Fill first field" ab fill "$FIELD1_REF" "$FIELD1_VALUE"
run_step "Fill second field" ab fill "$FIELD2_REF" "$FIELD2_VALUE"
run_step "Click submit" ab click "$SUBMIT_REF"
run_step "Wait after submit" ab wait --load networkidle

if [[ -n "$SUCCESS_URL_PATTERN" ]]; then
  run_step "Wait for success URL pattern" ab wait --url "$SUCCESS_URL_PATTERN"
fi

CURRENT_STEP="Capture snapshot diff"
ATTEMPTED_STEPS+=("$CURRENT_STEP")
ab diff snapshot >"$OUTPUT_DIR/diff-snapshot.txt" 2>>"$COMMAND_LOG"
action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/diff-snapshot.txt"

CURRENT_STEP="Capture final snapshot"
ATTEMPTED_STEPS+=("$CURRENT_STEP")
ab snapshot -i >"$OUTPUT_DIR/snapshot-after.txt" 2>>"$COMMAND_LOG"
action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/snapshot-after.txt"

CURRENT_STEP="Capture result screenshot"
ATTEMPTED_STEPS+=("$CURRENT_STEP")
ab screenshot "$OUTPUT_DIR/form-result.png" >>"$COMMAND_LOG" 2>&1
action_entry "$CURRENT_STEP" "success" "$OUTPUT_DIR/form-result.png"

FINAL_URL="$(ab get url 2>>"$COMMAND_LOG" | tr -d '\r')"
TITLE="$(ab get title 2>>"$COMMAND_LOG" | tr -d '\r')"

echo
echo "EXTRACTION_RESULT"
echo "- key: \"title\""
echo "  value: \"$(escape_value "$TITLE")\""
echo "- key: \"final_url\""
echo "  value: \"$(escape_value "$FINAL_URL")\""
echo "- key: \"artifacts_dir\""
echo "  value: \"$(escape_value "$OUTPUT_DIR")\""
echo "- key: \"snapshot_diff\""
echo "  value: \"$(escape_value "$OUTPUT_DIR/diff-snapshot.txt")\""
