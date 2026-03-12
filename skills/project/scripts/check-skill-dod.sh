#!/usr/bin/env bash

set -euo pipefail

root="${1:-skills}"

if [ ! -d "${root}" ]; then
  echo "error: directory not found: ${root}" >&2
  exit 1
fi

status=0
count=0

while IFS= read -r file; do
  count=$((count + 1))
  missing=()

  if ! grep -Eq '^---$' "${file}"; then
    missing+=("frontmatter")
  fi

  if ! grep -Eq '^intent:' "${file}"; then
    missing+=("intent_contract_field")
  fi

  if ! grep -Eq '^consumes:' "${file}"; then
    missing+=("consumes_field")
  fi

  if ! grep -Eq '^requires:' "${file}"; then
    missing+=("requires_field")
  fi

  if ! grep -Eq '^effects:' "${file}"; then
    missing+=("effects_field")
  fi

  if ! grep -Eq '^resources:' "${file}"; then
    missing+=("resources_field")
  fi

  if ! grep -Eq '^execution_hints:' "${file}"; then
    missing+=("execution_hints_field")
  fi

  if ! grep -Eq '^## Intent' "${file}"; then
    missing+=("intent")
  fi

  if ! grep -Eq '^## Trigger' "${file}"; then
    missing+=("trigger")
  fi

  if ! grep -Eq '^## Workflow' "${file}"; then
    missing+=("workflow")
  fi

  if ! grep -Eq '^## Stop Conditions' "${file}"; then
    missing+=("stop_conditions")
  fi

  if ! grep -Eq '^## Anti-Patterns' "${file}"; then
    missing+=("anti_patterns")
  fi

  if ! grep -Eq '^## Example' "${file}"; then
    missing+=("example")
  fi

  if [ "${#missing[@]}" -gt 0 ]; then
    status=1
    printf 'FAIL %s\n' "${file}"
    printf '  missing: %s\n' "${missing[*]}"
  else
    printf 'PASS %s\n' "${file}"
  fi
done < <(find "${root}" -type f -name 'SKILL.md' | sort)

echo "checked=${count}"

if [ "${status}" -ne 0 ]; then
  echo "result=fail"
  exit 1
fi

echo "result=pass"
